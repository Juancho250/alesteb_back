const db = require("../config/db");

/* =========================
   OBTENER TODOS LOS GASTOS
========================= */
exports.getExpenses = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.*, p.name as provider_name 
       FROM public.expenses e
       LEFT JOIN providers p ON e.provider_id = p.id
       ORDER BY e.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

/* ===============================================
   CREAR GASTO OPERATIVO SIMPLE
=============================================== */
exports.createExpense = async (req, res) => {
  const { 
    type, 
    category, 
    amount, 
    description,
    provider_id 
  } = req.body;

  const client = await db.connect();
  
  try {
    await client.query("BEGIN");

    // Insertar gasto
    const result = await client.query(
      `INSERT INTO expenses 
       (type, category, amount, description, provider_id)
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [type, category, amount, description, provider_id]
    );

    // Si es a crédito, actualizar balance del proveedor
    if (provider_id && type === 'gasto') {
      await client.query(
        `UPDATE providers 
         SET balance = balance + $1 
         WHERE id = $2`,
        [amount, provider_id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CREATE EXPENSE ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

/* ===============================================
   RESUMEN FINANCIERO COMPLETO
=============================================== */
exports.getFinanceSummary = async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    let dateFilter = '';
    const params = [];
    let paramCount = 1;

    if (start_date) {
      dateFilter += ` AND e.created_at >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }

    if (end_date) {
      dateFilter += ` AND e.created_at <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    // Gastos y compras
    const expensesResult = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'gasto' THEN amount END), 0) AS "totalGastos",
        COALESCE(SUM(CASE WHEN type = 'compra' THEN amount END), 0) AS "totalCompras"
      FROM expenses e
      WHERE 1=1 ${dateFilter}
    `, params);

    // Ventas y rentabilidad real
    const salesResult = await db.query(`
      SELECT 
        COALESCE(SUM(total), 0) as total_revenue,
        COUNT(*) as total_sales
      FROM sales 
      WHERE payment_status = 'paid'
      ${start_date ? `AND created_at >= $1` : ''}
      ${end_date ? `AND created_at <= $${start_date ? 2 : 1}` : ''}
    `, start_date && end_date ? [start_date, end_date] : start_date ? [start_date] : end_date ? [end_date] : []);

    // Deuda total con proveedores
    const debtResult = await db.query(`
      SELECT COALESCE(SUM(balance), 0) AS "deudaTotal"
      FROM providers
    `);

    // Rentabilidad por producto vendido
    const profitResult = await db.query(`
      SELECT 
        COALESCE(SUM(si.quantity * (si.unit_price - p.purchase_price)), 0) as realized_profit
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales s ON si.sale_id = s.id
      WHERE s.payment_status = 'paid'
      ${start_date ? `AND s.created_at >= $1` : ''}
      ${end_date ? `AND s.created_at <= $${start_date ? 2 : 1}` : ''}
    `, start_date && end_date ? [start_date, end_date] : start_date ? [start_date] : end_date ? [end_date] : []);

    const summary = {
      ...expensesResult.rows[0],
      ...debtResult.rows[0],
      totalVentas: Number(salesResult.rows[0].total_revenue),
      totalSales: Number(salesResult.rows[0].total_sales),
      realizedProfit: Number(profitResult.rows[0].realized_profit),
      netProfit: Number(profitResult.rows[0].realized_profit) - 
                 Number(expensesResult.rows[0].totalGastos)
    };

    res.json(summary);

  } catch (err) {
    console.error("GET FINANCE SUMMARY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};


/* ===============================================
   CREAR ORDEN DE COMPRA PROFESIONAL
=============================================== */
// En expenses.controller.js - Función createPurchaseOrder

exports.createPurchaseOrder = async (req, res) => {
  const { 
    provider_id, 
    items,
    notes,
    payment_method,
    payment_status
  } = req.body;

  const client = await db.connect();
  
  try {
    await client.query("BEGIN");

    const totalAmount = items.reduce((sum, item) => 
      sum + (item.unit_cost * item.quantity), 0
    );

    const orderResult = await client.query(
      `INSERT INTO purchase_orders 
       (provider_id, total_amount, payment_method, payment_status, notes)
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, created_at`,
      [provider_id, totalAmount, payment_method || 'credit', payment_status || 'pending', notes]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      const {
        product_id,
        quantity,
        unit_cost,
        markup_type,
        markup_value
      } = item;

      // Calcular precio sugerido basado en el costo de compra
      let suggestedPrice;
      if (markup_type === 'percentage') {
        suggestedPrice = unit_cost * (1 + markup_value / 100);
      } else if (markup_type === 'fixed') {
        suggestedPrice = unit_cost + markup_value;
      } else {
        suggestedPrice = unit_cost * 1.30;
      }

      // Insertar item de la orden
      await client.query(
        `INSERT INTO purchase_order_items 
         (order_id, product_id, quantity, unit_cost, markup_type, markup_value, suggested_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, product_id, quantity, unit_cost, markup_type, markup_value, suggestedPrice]
      );

      // ⭐ ACTUALIZACIÓN MEJORADA: Actualizar producto sin sobrescribir descuentos
      // Solo actualizamos el precio base y el precio de compra
      // El final_price se calcula dinámicamente en las consultas con descuentos activos
      await client.query(
        `UPDATE products 
         SET 
           purchase_price = $1,
           markup_type = $2,
           markup_value = $3,
           price = $4,
           stock = stock + $5,
           last_purchase_date = NOW()
         WHERE id = $6`,
        [unit_cost, markup_type, markup_value, suggestedPrice, quantity, product_id]
      );

      // Registrar en expenses
      await client.query(
        `INSERT INTO expenses 
         (type, category, amount, provider_id, product_id, quantity, utility_type, utility_value)
         VALUES ('compra', $1, $2, $3, $4, $5, $6, $7)`,
        [
          `Compra: ${item.product_name || 'Producto'}`,
          unit_cost * quantity,
          provider_id,
          product_id,
          quantity,
          markup_type,
          markup_value
        ]
      );
    }

    // Actualizar balance del proveedor si es necesario
    if (payment_status === 'pending' || payment_status === 'partial') {
      const pendingAmount = payment_status === 'partial' ? totalAmount / 2 : totalAmount;
      await client.query(
        `UPDATE providers SET balance = balance + $1 WHERE id = $2`,
        [pendingAmount, provider_id]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Orden de compra registrada exitosamente",
      orderId,
      orderCode: `OC-${String(orderId).padStart(5, '0')}`,
      totalAmount,
      itemsCount: items.length
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("CREATE PURCHASE ORDER ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

/* ===============================================
   OBTENER ÓRDENES DE COMPRA
=============================================== */
exports.getPurchaseOrders = async (req, res) => {
  const { provider_id, status, start_date, end_date } = req.query;

  try {
    let query = `
      SELECT 
        po.*,
        p.name as provider_name,
        p.category as provider_category,
        (SELECT COUNT(*) FROM purchase_order_items WHERE order_id = po.id) as items_count,
        CONCAT('OC-', LPAD(po.id::text, 5, '0')) as order_code
      FROM purchase_orders po
      LEFT JOIN providers p ON po.provider_id = p.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (provider_id) {
      query += ` AND po.provider_id = $${paramCount}`;
      params.push(provider_id);
      paramCount++;
    }

    if (status) {
      query += ` AND po.payment_status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (start_date) {
      query += ` AND po.created_at >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }

    if (end_date) {
      query += ` AND po.created_at <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    query += ` ORDER BY po.created_at DESC`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PURCHASE ORDERS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ===============================================
   OBTENER DETALLES DE ORDEN DE COMPRA
=============================================== */
exports.getPurchaseOrderDetails = async (req, res) => {
  const { id } = req.params;

  try {
    const orderResult = await db.query(
      `SELECT 
        po.*,
        p.name as provider_name,
        p.phone as provider_phone,
        p.email as provider_email,
        CONCAT('OC-', LPAD(po.id::text, 5, '0')) as order_code
       FROM purchase_orders po
       LEFT JOIN providers p ON po.provider_id = p.id
       WHERE po.id = $1`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ message: "Orden no encontrada" });
    }

    const itemsResult = await db.query(
      `SELECT 
        poi.*,
        pr.name as product_name,
        pr.stock as current_stock,
        pr.price as current_price,
        (poi.suggested_price - poi.unit_cost) as unit_profit,
        ((poi.suggested_price - poi.unit_cost) / poi.unit_cost * 100) as profit_margin
       FROM purchase_order_items poi
       LEFT JOIN products pr ON poi.product_id = pr.id
       WHERE poi.order_id = $1`,
      [id]
    );

    res.json({
      order: orderResult.rows[0],
      items: itemsResult.rows
    });

  } catch (err) {
    console.error("GET PURCHASE ORDER DETAILS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ===============================================
   ANÁLISIS DE RENTABILIDAD POR PRODUCTO
=============================================== */
exports.getProductProfitability = async (req, res) => {
  const { product_id, start_date, end_date } = req.query;

  try {
    let query = `
      SELECT 
        p.id,
        p.name as product_name,
        p.purchase_price,
        p.price as sale_price,
        p.stock,
        p.markup_type,
        p.markup_value,
        (p.price - COALESCE(p.purchase_price, 0)) as unit_profit,
        CASE 
          WHEN COALESCE(p.purchase_price, 0) > 0 THEN 
            ROUND(((p.price - p.purchase_price) / p.purchase_price * 100)::numeric, 2)
          ELSE 0 
        END as profit_margin_percent,
        COALESCE(SUM(si.quantity), 0) as total_sold,
        COALESCE(SUM(si.quantity * si.unit_price), 0) as revenue,
        COALESCE(SUM(si.quantity * COALESCE(p.purchase_price, 0)), 0) as cost,
        COALESCE(SUM(si.quantity * (si.unit_price - COALESCE(p.purchase_price, 0))), 0) as total_profit
      FROM products p
      LEFT JOIN sale_items si ON p.id = si.product_id
      LEFT JOIN sales s ON si.sale_id = s.id AND s.payment_status = 'paid'
    `;

    const params = [];
    let paramCount = 1;
    let whereAdded = false;

    if (product_id) {
      query += ` WHERE p.id = $${paramCount}`;
      params.push(product_id);
      paramCount++;
      whereAdded = true;
    }

    if (start_date) {
      query += whereAdded ? ` AND` : ` WHERE`;
      query += ` s.created_at >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
      whereAdded = true;
    }

    if (end_date) {
      query += whereAdded ? ` AND` : ` WHERE`;
      query += ` s.created_at <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    query += ` GROUP BY p.id, p.name, p.purchase_price, p.price, p.stock, p.markup_type, p.markup_value`;
    query += ` ORDER BY total_profit DESC`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PRODUCT PROFITABILITY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ===============================================
   ANÁLISIS DE RENTABILIDAD POR PROVEEDOR
=============================================== */
exports.getProviderProfitability = async (req, res) => {
  const { provider_id, start_date, end_date } = req.query;

  try {
    let query = `
      SELECT 
        prov.id,
        prov.name as provider_name,
        prov.category,
        prov.balance as pending_debt,
        COUNT(DISTINCT po.id) as total_orders,
        COALESCE(SUM(poi.quantity * poi.unit_cost), 0) as total_purchased,
        COALESCE(SUM(poi.quantity * poi.suggested_price), 0) as potential_revenue,
        COALESCE(SUM(poi.quantity * (poi.suggested_price - poi.unit_cost)), 0) as potential_profit,
        CASE 
          WHEN SUM(poi.quantity * poi.unit_cost) > 0 THEN
            ROUND((SUM(poi.quantity * (poi.suggested_price - poi.unit_cost)) / 
                   SUM(poi.quantity * poi.unit_cost) * 100)::numeric, 2)
          ELSE 0
        END as avg_margin_percent
      FROM providers prov
      LEFT JOIN purchase_orders po ON prov.id = po.provider_id
      LEFT JOIN purchase_order_items poi ON po.id = poi.order_id
    `;

    const params = [];
    let paramCount = 1;
    let whereAdded = false;

    if (provider_id) {
      query += ` WHERE prov.id = $${paramCount}`;
      params.push(provider_id);
      paramCount++;
      whereAdded = true;
    }

    if (start_date) {
      query += whereAdded ? ` AND` : ` WHERE`;
      query += ` po.created_at >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
      whereAdded = true;
    }

    if (end_date) {
      query += whereAdded ? ` AND` : ` WHERE`;
      query += ` po.created_at <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    query += ` GROUP BY prov.id, prov.name, prov.category, prov.balance`;
    query += ` ORDER BY potential_profit DESC`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PROVIDER PROFITABILITY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/* ===============================================
   REGISTRAR PAGO A PROVEEDOR
=============================================== */
exports.recordProviderPayment = async (req, res) => {
  const { provider_id, amount, payment_method, notes } = req.body;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO provider_payments (provider_id, amount, payment_method, notes)
       VALUES ($1, $2, $3, $4)`,
      [provider_id, amount, payment_method, notes]
    );

    await client.query(
      `UPDATE providers SET balance = balance - $1 WHERE id = $2`,
      [amount, provider_id]
    );

    await client.query("COMMIT");
    res.json({ message: "Pago registrado correctamente" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("RECORD PROVIDER PAYMENT ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

/* ===============================================
   OBTENER HISTORIAL DE PAGOS
=============================================== */
exports.getProviderPayments = async (req, res) => {
  const { provider_id } = req.query;

  try {
    let query = `
      SELECT 
        pp.*,
        p.name as provider_name
      FROM provider_payments pp
      LEFT JOIN providers p ON pp.provider_id = p.id
      WHERE 1=1
    `;

    const params = [];
    if (provider_id) {
      query += ` AND pp.provider_id = $1`;
      params.push(provider_id);
    }

    query += ` ORDER BY pp.created_at DESC`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PROVIDER PAYMENTS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};
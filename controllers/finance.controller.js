const db = require("../config/db");

const fmtNum = (v) => parseFloat(v) || 0;

// ============================================
// 📊 RESUMEN FINANCIERO SIMPLIFICADO
// ============================================
exports.getSummary = async (req, res) => {
  const { start_date, end_date } = req.query;
  const hasDateFilter = start_date && end_date;
  const dateParams = hasDateFilter ? [start_date, end_date] : [];
  
  // Filtro para ventas
  const salesDateFilter = hasDateFilter ? "AND s.sale_date BETWEEN $1 AND $2" : "";
  
  // Filtro para facturas
  const invoicesDateFilter = hasDateFilter ? "WHERE invoice_date BETWEEN $1 AND $2" : "";

  try {
    // 1. Ventas realizadas (ingresos)
    const salesResult = await db.query(
      `SELECT
         COALESCE(SUM(s.total), 0) AS total_sales,
         COALESCE(SUM(si.unit_cost * si.quantity), 0) AS total_cogs,
         COUNT(DISTINCT s.id) AS sales_count
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.id
       WHERE s.payment_status = 'paid' ${salesDateFilter}`,
      dateParams
    );

    // 2. Facturas pagadas (gastos operativos)
    const invoicesResult = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN invoice_type = 'service' THEN total_amount ELSE 0 END), 0) AS services_paid,
         COALESCE(SUM(CASE WHEN invoice_type = 'purchase' THEN total_amount ELSE 0 END), 0) AS purchases_paid,
         COUNT(*) AS invoices_count
       FROM invoices
       ${invoicesDateFilter}`,
      dateParams
    );

    // 3. Facturas pendientes de pago
    const pendingResult = await db.query(
      `SELECT
         COALESCE(SUM(pending_amount), 0) AS total_pending
       FROM invoices
       WHERE payment_status != 'paid'`
    );

    // 4. Inventario actual
    const inventoryResult = await db.query(
      `SELECT
         COALESCE(SUM(stock * COALESCE(purchase_price, 0)), 0) AS inventory_value,
         COUNT(*) AS products_count
       FROM products
       WHERE is_active = true`
    );

    const sales = salesResult.rows[0];
    const invoices = invoicesResult.rows[0];
    const pending = pendingResult.rows[0];
    const inventory = inventoryResult.rows[0];

    // Cálculos
    const totalSales = fmtNum(sales.total_sales);
    const cogs = fmtNum(sales.total_cogs);
    const grossProfit = totalSales - cogs;
    
    const operatingExpenses = fmtNum(invoices.services_paid);
    const netProfit = grossProfit - operatingExpenses;

    res.json({
      // Ingresos
      revenue: {
        total: totalSales,
        sales_count: parseInt(sales.sales_count || 0),
        cogs: cogs
      },
      
      // Rentabilidad
      profitability: {
        gross_profit: grossProfit,
        gross_margin_pct: totalSales > 0 ? +((grossProfit / totalSales) * 100).toFixed(2) : 0,
        net_profit: netProfit,
        net_margin_pct: totalSales > 0 ? +((netProfit / totalSales) * 100).toFixed(2) : 0
      },
      
      // Gastos
      expenses: {
        operating: operatingExpenses,
        purchases: fmtNum(invoices.purchases_paid)
      },
      
      // Deudas
      debt: {
        pending_invoices: fmtNum(pending.total_pending)
      },
      
      // Activos
      assets: {
        inventory_value: fmtNum(inventory.inventory_value),
        products_count: parseInt(inventory.products_count || 0)
      }
    });

  } catch (err) {
    console.error("[SUMMARY ERROR]", err);
    res.status(500).json({ message: "Error al obtener resumen financiero" });
  }
};

// ============================================
// 📄 LISTAR FACTURAS
// ============================================
exports.getInvoices = async (req, res) => {
  const { type, status, start_date, end_date, limit = 100, offset = 0 } = req.query;
  
  let where = [];
  let params = [];
  let paramIndex = 1;

  if (type) {
    where.push(`invoice_type = $${paramIndex}`);
    params.push(type);
    paramIndex++;
  }

  if (status) {
    where.push(`payment_status = $${paramIndex}`);
    params.push(status);
    paramIndex++;
  }

  if (start_date && end_date) {
    where.push(`invoice_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`);
    params.push(start_date, end_date);
    paramIndex += 2;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT
         i.*,
         p.name AS provider_name,
         COALESCE(
           (SELECT json_agg(
              json_build_object(
                'product_id', ii.product_id,
                'product_name', prod.name,
                'quantity', ii.quantity,
                'unit_price', ii.unit_price,
                'subtotal', ii.subtotal
              )
            )
            FROM invoice_items ii
            LEFT JOIN products prod ON prod.id = ii.product_id
            WHERE ii.invoice_id = i.id
           ), '[]'::json
         ) AS items
       FROM invoices i
       LEFT JOIN providers p ON p.id = i.provider_id
       ${whereClause}
       ORDER BY i.invoice_date DESC, i.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("[GET INVOICES ERROR]", err);
    res.status(500).json({ message: "Error al obtener facturas" });
  }
};

// ============================================
// ➕ CREAR FACTURA
// ============================================
exports.createInvoice = async (req, res) => {
  const {
    invoice_type,    // 'service' o 'purchase'
    provider_id,
    invoice_number,
    invoice_date,
    due_date,
    description,
    items = [],      // Solo para compras: [{ product_id, quantity, unit_price }]
    total_amount,
    payment_method,
    notes
  } = req.body;

  // Validaciones
  if (!invoice_type || !['service', 'purchase'].includes(invoice_type)) {
    return res.status(400).json({ message: "Tipo de factura inválido (service o purchase)" });
  }

  if (!total_amount || total_amount <= 0) {
    return res.status(400).json({ message: "El monto debe ser mayor a 0" });
  }

  if (invoice_type === 'purchase') {
    if (!items || items.length === 0) {
      return res.status(400).json({ message: "Las compras deben incluir productos" });
    }
    if (!provider_id) {
      return res.status(400).json({ message: "Las compras requieren un proveedor" });
    }
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Crear factura
    const invoiceResult = await client.query(
      `INSERT INTO invoices (
        invoice_type,
        provider_id,
        invoice_number,
        invoice_date,
        due_date,
        description,
        total_amount,
        pending_amount,
        payment_status,
        payment_method,
        notes,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id`,
      [
        invoice_type,
        provider_id || null,
        invoice_number || null,
        invoice_date || new Date(),
        due_date || null,
        description || 'Factura registrada',
        total_amount,
        payment_method === 'credit' ? total_amount : 0, // Si es crédito, queda pendiente
        payment_method === 'credit' ? 'pending' : 'paid',
        payment_method || 'cash',
        notes || null,
        req.user?.id || null
      ]
    );

    const invoiceId = invoiceResult.rows[0].id;

    // 2. Si es compra, procesar items
    if (invoice_type === 'purchase' && items.length > 0) {
      for (const item of items) {
        const { product_id, quantity, unit_price } = item;

        if (!product_id || !quantity || !unit_price) {
          throw new Error("Items incompletos en la factura");
        }

        const subtotal = quantity * unit_price;

        // Insertar item
        await client.query(
          `INSERT INTO invoice_items (
            invoice_id,
            product_id,
            quantity,
            unit_price,
            subtotal
          ) VALUES ($1, $2, $3, $4, $5)`,
          [invoiceId, product_id, quantity, unit_price, subtotal]
        );

        // Actualizar producto: precio de compra y stock
        await client.query(
          `UPDATE products
           SET purchase_price = $1,
               stock = stock + $2,
               updated_at = NOW()
           WHERE id = $3`,
          [unit_price, quantity, product_id]
        );
      }
    }

    // 3. Si es crédito, actualizar balance del proveedor
    if (payment_method === 'credit' && provider_id) {
      await client.query(
        `UPDATE providers
         SET balance = balance + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [total_amount, provider_id]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: `${invoice_type === 'service' ? 'Factura de servicio' : 'Compra'} registrada exitosamente`,
      invoice_id: invoiceId
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[CREATE INVOICE ERROR]", err);
    res.status(500).json({ message: err.message || "Error al crear factura" });
  } finally {
    client.release();
  }
};

// ============================================
// 💳 REGISTRAR PAGO DE FACTURA
// ============================================
exports.payInvoice = async (req, res) => {
  const { invoice_id, amount, payment_method, payment_date, notes } = req.body;

  if (!invoice_id || !amount || amount <= 0) {
    return res.status(400).json({ message: "Datos de pago incompletos" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // Verificar factura
    const invoiceResult = await client.query(
      `SELECT id, provider_id, pending_amount, payment_status
       FROM invoices
       WHERE id = $1`,
      [invoice_id]
    );

    if (invoiceResult.rows.length === 0) {
      throw new Error("Factura no encontrada");
    }

    const invoice = invoiceResult.rows[0];

    if (invoice.payment_status === 'paid') {
      throw new Error("Esta factura ya está completamente pagada");
    }

    if (amount > invoice.pending_amount) {
      throw new Error("El monto excede lo pendiente de pago");
    }

    // Registrar pago
    await client.query(
      `INSERT INTO invoice_payments (
        invoice_id,
        amount,
        payment_method,
        payment_date,
        notes,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        invoice_id,
        amount,
        payment_method || 'cash',
        payment_date || new Date(),
        notes || null,
        req.user?.id || null
      ]
    );

    // Actualizar factura
    const newPending = invoice.pending_amount - amount;
    const newStatus = newPending <= 0 ? 'paid' : (newPending < invoice.total_amount ? 'partial' : 'pending');

    await client.query(
      `UPDATE invoices
       SET pending_amount = $1,
           payment_status = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [newPending, newStatus, invoice_id]
    );

    // Actualizar balance del proveedor
    if (invoice.provider_id) {
      await client.query(
        `UPDATE providers
         SET balance = balance - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [amount, invoice.provider_id]
      );
    }

    await client.query("COMMIT");

    res.json({
      message: "Pago registrado exitosamente",
      new_pending: newPending,
      new_status: newStatus
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PAY INVOICE ERROR]", err);
    res.status(500).json({ message: err.message || "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ============================================
// 📈 FLUJO DE CAJA MENSUAL
// ============================================
exports.getCashflow = async (req, res) => {
  try {
    const result = await db.query(`
      WITH monthly_data AS (
        -- Ingresos por ventas
        SELECT
          TO_CHAR(DATE_TRUNC('month', sale_date), 'Mon YY') AS month,
          DATE_TRUNC('month', sale_date) AS month_date,
          SUM(total) AS revenue,
          0 AS costs
        FROM sales
        WHERE payment_status = 'paid'
          AND sale_date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', sale_date)
        
        UNION ALL
        
        -- Gastos por facturas pagadas
        SELECT
          TO_CHAR(DATE_TRUNC('month', invoice_date), 'Mon YY') AS month,
          DATE_TRUNC('month', invoice_date) AS month_date,
          0 AS revenue,
          SUM(total_amount - pending_amount) AS costs
        FROM invoices
        WHERE invoice_date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', invoice_date)
      )
      SELECT
        month,
        COALESCE(SUM(revenue), 0) AS revenue,
        COALESCE(SUM(costs), 0) AS costs,
        COALESCE(SUM(revenue - costs), 0) AS profit
      FROM monthly_data
      GROUP BY month, month_date
      ORDER BY month_date
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("[CASHFLOW ERROR]", err);
    res.status(500).json({ message: "Error al obtener flujo de caja" });
  }
};

// ============================================
// 🏷️ RENTABILIDAD POR PRODUCTO
// ============================================
exports.getProfitByProduct = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        p.id,
        p.name,
        p.sku,
        p.stock,
        COALESCE(p.purchase_price, 0) AS cost_price,
        COALESCE(p.sale_price, 0) AS sale_price,
        COALESCE(p.sale_price - p.purchase_price, 0) AS unit_profit,
        CASE
          WHEN COALESCE(p.sale_price, 0) > 0
          THEN ROUND(((p.sale_price - p.purchase_price) / p.sale_price * 100)::numeric, 2)
          ELSE 0
        END AS margin_pct,
        COALESCE(sales.units_sold, 0) AS units_sold,
        COALESCE(sales.total_revenue, 0) AS total_revenue,
        COALESCE(sales.total_profit, 0) AS realized_profit,
        p.stock * COALESCE(p.purchase_price, 0) AS inventory_value
      FROM products p
      LEFT JOIN (
        SELECT
          product_id,
          SUM(quantity) AS units_sold,
          SUM(subtotal) AS total_revenue,
          SUM(total_profit) AS total_profit
        FROM sale_items
        GROUP BY product_id
      ) sales ON sales.product_id = p.id
      WHERE p.is_active = true
      ORDER BY realized_profit DESC NULLS LAST
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("[PROFIT BY PRODUCT ERROR]", err);
    res.status(500).json({ message: "Error al obtener rentabilidad" });
  }
};

module.exports = exports;
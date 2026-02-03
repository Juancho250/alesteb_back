const db = require("../config/db");
const { z } = require("zod");

// ===============================
// ESQUEMAS DE VALIDACIÓN
// ===============================

const expenseSchema = z.object({
  type: z.enum(['gasto', 'compra'], {
    errorMap: () => ({ message: "Tipo debe ser 'gasto' o 'compra'" })
  }),
  category: z.string()
    .min(2, "La categoría es requerida")
    .max(100, "Categoría demasiado larga")
    .trim(),
  amount: z.number()
    .positive("El monto debe ser mayor a 0")
    .max(999999999, "Monto demasiado alto"),
  description: z.string()
    .max(500, "Descripción demasiado larga")
    .trim()
    .optional(),
  provider_id: z.number()
    .int()
    .positive()
    .optional()
    .nullable()
});

const purchaseOrderSchema = z.object({
  provider_id: z.number()
    .int()
    .positive("Proveedor inválido"),
  items: z.array(
    z.object({
      product_id: z.number().int().positive(),
      product_name: z.string().optional(),
      quantity: z.number().int().positive().max(10000),
      unit_cost: z.number().positive().max(999999),
      markup_type: z.enum(['percentage', 'fixed', 'none']).optional(),
      markup_value: z.number().min(0).max(10000).optional()
    })
  ).min(1, "Debe incluir al menos un producto").max(100, "Máximo 100 productos por orden"),
  notes: z.string().max(1000).trim().optional(),
  payment_method: z.enum(['cash', 'credit', 'transfer', 'check']).optional(),
  payment_status: z.enum(['paid', 'pending', 'partial']).optional()
});

const providerPaymentSchema = z.object({
  provider_id: z.number().int().positive(),
  amount: z.number().positive().max(999999999),
  payment_method: z.enum(['cash', 'credit', 'transfer', 'check']),
  notes: z.string().max(500).trim().optional()
});

// ===============================
// OBTENER TODOS LOS GASTOS
// ===============================

exports.getExpenses = async (req, res) => {
  try {
    const { start_date, end_date, type, provider_id } = req.query;
    
    let query = `
      SELECT e.*, p.name as provider_name 
      FROM expenses e
      LEFT JOIN providers p ON e.provider_id = p.id
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 1;

    if (start_date) {
      query += ` AND e.created_at >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }

    if (end_date) {
      query += ` AND e.created_at <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    if (type) {
      query += ` AND e.type = $${paramCount}`;
      params.push(type);
      paramCount++;
    }

    if (provider_id) {
      query += ` AND e.provider_id = $${paramCount}`;
      params.push(provider_id);
      paramCount++;
    }

    query += ` ORDER BY e.created_at DESC LIMIT 1000`;

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET EXPENSES ERROR:", {
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
    res.status(500).json({ message: "Error al obtener gastos" });
  }
};

// ===============================
// CREAR GASTO OPERATIVO SIMPLE
// ===============================

exports.createExpense = async (req, res) => {
  const client = await db.connect();
  
  try {
    // Validar datos
    const validatedData = expenseSchema.parse(req.body);
    
    await client.query("BEGIN");

    // Insertar gasto
    const result = await client.query(
      `INSERT INTO expenses 
       (type, category, amount, description, provider_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) 
       RETURNING *`,
      [
        validatedData.type, 
        validatedData.category, 
        validatedData.amount, 
        validatedData.description || null, 
        validatedData.provider_id || null
      ]
    );

    // Si es a crédito, actualizar balance del proveedor
    if (validatedData.provider_id && validatedData.type === 'gasto') {
      await client.query(
        `UPDATE providers 
         SET balance = balance + $1 
         WHERE id = $2`,
        [validatedData.amount, validatedData.provider_id]
      );
    }

    await client.query("COMMIT");
    
    res.status(201).json({
      message: "Gasto registrado con éxito",
      expense: result.rows[0]
    });

  } catch (err) {
    await client.query("ROLLBACK");
    
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: err.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("CREATE EXPENSE ERROR:", {
      message: err.message,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al crear gasto" });
  } finally {
    client.release();
  }
};

// ===============================
// RESUMEN FINANCIERO COMPLETO
// ===============================

exports.getFinanceSummary = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

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
        COALESCE(SUM(CASE WHEN type = 'gasto' THEN amount END), 0) AS total_gastos,
        COALESCE(SUM(CASE WHEN type = 'compra' THEN amount END), 0) AS total_compras
      FROM expenses e
      WHERE 1=1 ${dateFilter}
    `, params);

    // Ventas y rentabilidad real
    const salesParams = [];
    let salesQuery = `
      SELECT 
        COALESCE(SUM(total), 0) as total_revenue,
        COUNT(*) as total_sales
      FROM sales 
      WHERE payment_status = 'paid'
    `;

    if (start_date) {
      salesQuery += ` AND created_at >= $1`;
      salesParams.push(start_date);
    }

    if (end_date) {
      salesQuery += ` AND created_at <= $${salesParams.length + 1}`;
      salesParams.push(end_date);
    }

    const salesResult = await db.query(salesQuery, salesParams);

    // Deuda total con proveedores
    const debtResult = await db.query(`
      SELECT COALESCE(SUM(balance), 0) AS deuda_total
      FROM providers
    `);

    // Rentabilidad por producto vendido
    const profitParams = [];
    let profitQuery = `
      SELECT 
        COALESCE(SUM(si.quantity * (si.unit_price - COALESCE(p.purchase_price, 0))), 0) as realized_profit
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales s ON si.sale_id = s.id
      WHERE s.payment_status = 'paid'
    `;

    if (start_date) {
      profitQuery += ` AND s.created_at >= $1`;
      profitParams.push(start_date);
    }

    if (end_date) {
      profitQuery += ` AND s.created_at <= $${profitParams.length + 1}`;
      profitParams.push(end_date);
    }

    const profitResult = await db.query(profitQuery, profitParams);

    const summary = {
      totalGastos: Number(expensesResult.rows[0].total_gastos),
      totalCompras: Number(expensesResult.rows[0].total_compras),
      deudaTotal: Number(debtResult.rows[0].deuda_total),
      totalVentas: Number(salesResult.rows[0].total_revenue),
      totalSales: Number(salesResult.rows[0].total_sales),
      realizedProfit: Number(profitResult.rows[0].realized_profit),
      netProfit: Number(profitResult.rows[0].realized_profit) - 
                 Number(expensesResult.rows[0].total_gastos)
    };

    res.json(summary);

  } catch (err) {
    console.error("GET FINANCE SUMMARY ERROR:", {
      message: err.message
    });
    res.status(500).json({ message: "Error al obtener resumen financiero" });
  }
};

// ===============================
// CREAR ORDEN DE COMPRA
// ===============================

exports.createPurchaseOrder = async (req, res) => {
  const client = await db.connect();
  
  try {
    // Validar datos
    const validatedData = purchaseOrderSchema.parse(req.body);
    
    await client.query("BEGIN");

    // Verificar que el proveedor existe
    const providerCheck = await client.query(
      "SELECT id FROM providers WHERE id = $1",
      [validatedData.provider_id]
    );

    if (providerCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    // Calcular total
    const totalAmount = validatedData.items.reduce((sum, item) => 
      sum + (item.unit_cost * item.quantity), 0
    );

    // Crear orden
    const orderResult = await client.query(
      `INSERT INTO purchase_orders 
       (provider_id, total_amount, payment_method, payment_status, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) 
       RETURNING id, created_at`,
      [
        validatedData.provider_id, 
        totalAmount, 
        validatedData.payment_method || 'credit', 
        validatedData.payment_status || 'pending', 
        validatedData.notes || null
      ]
    );

    const orderId = orderResult.rows[0].id;

    // Procesar items
    for (const item of validatedData.items) {
      // Verificar que el producto existe
      const productCheck = await client.query(
        "SELECT id, stock FROM products WHERE id = $1",
        [item.product_id]
      );

      if (productCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ 
          message: `Producto con ID ${item.product_id} no encontrado` 
        });
      }

      // Calcular precio sugerido
      const markupType = item.markup_type || 'percentage';
      const markupValue = item.markup_value || 30;
      
      let suggestedPrice;
      if (markupType === 'percentage') {
        suggestedPrice = item.unit_cost * (1 + markupValue / 100);
      } else if (markupType === 'fixed') {
        suggestedPrice = item.unit_cost + markupValue;
      } else {
        suggestedPrice = item.unit_cost * 1.30;
      }

      // Insertar item de orden
      await client.query(
        `INSERT INTO purchase_order_items 
         (order_id, product_id, quantity, unit_cost, markup_type, markup_value, suggested_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, item.product_id, item.quantity, item.unit_cost, markupType, markupValue, suggestedPrice]
      );

      // Actualizar producto
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
        [item.unit_cost, markupType, markupValue, suggestedPrice, item.quantity, item.product_id]
      );

      // Registrar en expenses
      await client.query(
        `INSERT INTO expenses 
         (type, category, amount, provider_id, product_id, quantity, utility_type, utility_value, created_at)
         VALUES ('compra', $1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          `Compra: ${item.product_name || 'Producto'}`,
          item.unit_cost * item.quantity,
          validatedData.provider_id,
          item.product_id,
          item.quantity,
          markupType,
          markupValue
        ]
      );
    }

    // Actualizar balance del proveedor si es necesario
    if (validatedData.payment_status === 'pending' || validatedData.payment_status === 'partial') {
      const pendingAmount = validatedData.payment_status === 'partial' 
        ? totalAmount / 2 
        : totalAmount;
      
      await client.query(
        `UPDATE providers SET balance = balance + $1 WHERE id = $2`,
        [pendingAmount, validatedData.provider_id]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Orden de compra registrada exitosamente",
      orderId,
      orderCode: `OC-${String(orderId).padStart(5, '0')}`,
      totalAmount,
      itemsCount: validatedData.items.length
    });

  } catch (err) {
    await client.query("ROLLBACK");
    
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: err.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("CREATE PURCHASE ORDER ERROR:", {
      message: err.message,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al crear orden de compra" });
  } finally {
    client.release();
  }
};

// ===============================
// OBTENER ÓRDENES DE COMPRA
// ===============================

exports.getPurchaseOrders = async (req, res) => {
  try {
    const { provider_id, status, start_date, end_date } = req.query;

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

    if (provider_id && !isNaN(parseInt(provider_id))) {
      query += ` AND po.provider_id = $${paramCount}`;
      params.push(parseInt(provider_id));
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

    query += ` ORDER BY po.created_at DESC LIMIT 500`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PURCHASE ORDERS ERROR:", {
      message: err.message
    });
    res.status(500).json({ message: "Error al obtener órdenes de compra" });
  }
};

// ===============================
// OBTENER DETALLES DE ORDEN
// ===============================

exports.getPurchaseOrderDetails = async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

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
        CASE 
          WHEN poi.unit_cost > 0 THEN
            ROUND(((poi.suggested_price - poi.unit_cost) / poi.unit_cost * 100)::numeric, 2)
          ELSE 0
        END as profit_margin
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
    console.error("GET PURCHASE ORDER DETAILS ERROR:", {
      message: err.message,
      orderId: req.params.id
    });
    res.status(500).json({ message: "Error al obtener detalles de orden" });
  }
};

// ===============================
// ANÁLISIS DE RENTABILIDAD POR PRODUCTO
// ===============================

exports.getProductProfitability = async (req, res) => {
  try {
    const { product_id, start_date, end_date } = req.query;

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

    if (product_id && !isNaN(parseInt(product_id))) {
      query += ` WHERE p.id = $${paramCount}`;
      params.push(parseInt(product_id));
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
    query += ` ORDER BY total_profit DESC LIMIT 500`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PRODUCT PROFITABILITY ERROR:", {
      message: err.message
    });
    res.status(500).json({ message: "Error al obtener rentabilidad de productos" });
  }
};

// ===============================
// ANÁLISIS DE RENTABILIDAD POR PROVEEDOR
// ===============================

exports.getProviderProfitability = async (req, res) => {
  try {
    const { provider_id, start_date, end_date } = req.query;

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

    if (provider_id && !isNaN(parseInt(provider_id))) {
      query += ` WHERE prov.id = $${paramCount}`;
      params.push(parseInt(provider_id));
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
    query += ` ORDER BY potential_profit DESC LIMIT 500`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PROVIDER PROFITABILITY ERROR:", {
      message: err.message
    });
    res.status(500).json({ message: "Error al obtener rentabilidad de proveedores" });
  }
};

// ===============================
// REGISTRAR PAGO A PROVEEDOR
// ===============================

exports.recordProviderPayment = async (req, res) => {
  const client = await db.connect();

  try {
    // Validar datos
    const validatedData = providerPaymentSchema.parse(req.body);
    
    await client.query("BEGIN");

    // Verificar que el proveedor existe y tiene suficiente deuda
    const providerCheck = await client.query(
      "SELECT id, balance FROM providers WHERE id = $1",
      [validatedData.provider_id]
    );

    if (providerCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    if (providerCheck.rows[0].balance < validatedData.amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ 
        message: "El monto del pago excede la deuda actual" 
      });
    }

    // Registrar pago
    await client.query(
      `INSERT INTO provider_payments (provider_id, amount, payment_method, notes, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        validatedData.provider_id, 
        validatedData.amount, 
        validatedData.payment_method, 
        validatedData.notes || null
      ]
    );

    // Actualizar balance
    await client.query(
      `UPDATE providers SET balance = balance - $1 WHERE id = $2`,
      [validatedData.amount, validatedData.provider_id]
    );

    await client.query("COMMIT");
    
    res.json({ 
      message: "Pago registrado correctamente",
      amount: validatedData.amount
    });

  } catch (err) {
    await client.query("ROLLBACK");
    
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: err.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("RECORD PROVIDER PAYMENT ERROR:", {
      message: err.message,
      userId: req.user?.id
    });
    res.status(500).json({ message: "Error al registrar pago" });
  } finally {
    client.release();
  }
};

// ===============================
// OBTENER HISTORIAL DE PAGOS
// ===============================

exports.getProviderPayments = async (req, res) => {
  try {
    const { provider_id } = req.query;

    let query = `
      SELECT 
        pp.*,
        p.name as provider_name
      FROM provider_payments pp
      LEFT JOIN providers p ON pp.provider_id = p.id
      WHERE 1=1
    `;

    const params = [];
    if (provider_id && !isNaN(parseInt(provider_id))) {
      query += ` AND pp.provider_id = $1`;
      params.push(parseInt(provider_id));
    }

    query += ` ORDER BY pp.created_at DESC LIMIT 500`;

    const result = await db.query(query, params);
    res.json(result.rows);

  } catch (err) {
    console.error("GET PROVIDER PAYMENTS ERROR:", {
      message: err.message
    });
    res.status(500).json({ message: "Error al obtener pagos" });
  }
};
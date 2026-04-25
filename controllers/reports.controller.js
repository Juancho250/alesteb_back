// controllers/reports.controller.js
const db = require('../config/db');

// ─────────────────────────────────────────────
// RESUMEN GENERAL (KPIs del período)
// ─────────────────────────────────────────────
const getReportSummary = async (req, res) => {
  try {
    const { from, to } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const [sales, expenses, products, customers] = await Promise.all([
      db.query(
        `SELECT
          COUNT(*)                          AS total_orders,
          COALESCE(SUM(s.total), 0)         AS total_revenue,
          COALESCE(SUM(si.total_profit), 0) AS total_profit,
          COALESCE(AVG(s.total), 0)         AS avg_order_value
         FROM sales s
         LEFT JOIN (
           SELECT sale_id, SUM(total_profit) AS total_profit
           FROM sale_items GROUP BY sale_id
         ) si ON si.sale_id = s.id
         WHERE s.payment_status = 'paid'
           AND DATE(s.sale_date) BETWEEN $1 AND $2`,
        [dateFrom, dateTo]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_expenses
         FROM expenses
         WHERE expense_date BETWEEN $1 AND $2`,
        [dateFrom, dateTo]
      ),
      db.query(
        `SELECT
          COUNT(*)                                                                        AS total_products,
          SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END)                                    AS out_of_stock,
          SUM(CASE WHEN stock > 0 AND stock <= min_stock THEN 1 ELSE 0 END)              AS low_stock,
          COALESCE(SUM(stock * purchase_price), 0)                                       AS inventory_value
         FROM products WHERE is_active = true`
      ),
      db.query(
        `SELECT COUNT(DISTINCT customer_id) AS new_customers
         FROM sales
         WHERE customer_id IS NOT NULL
           AND DATE(sale_date) BETWEEN $1 AND $2`,
        [dateFrom, dateTo]
      ),
    ]);

    res.json({
      period:    { from: dateFrom, to: dateTo },
      sales:     sales.rows[0],
      expenses:  expenses.rows[0],
      products:  products.rows[0],
      customers: customers.rows[0],
    });
  } catch (err) {
    console.error('[Reports] getReportSummary:', err);
    res.status(500).json({ error: 'Error al obtener resumen' });
  }
};

// ─────────────────────────────────────────────
// VENTAS POR PERÍODO (día / semana / mes)
// ─────────────────────────────────────────────
const getSalesOverTime = async (req, res) => {
  try {
    const { from, to, granularity = 'day' } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];
    const trunc    = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';

    const result = await db.query(
      `SELECT
        DATE_TRUNC($1, s.sale_date)   AS period,
        COUNT(*)                      AS orders,
        COALESCE(SUM(s.total), 0)     AS revenue,
        COALESCE(SUM(si.profit), 0)   AS profit,
        COALESCE(AVG(s.total), 0)     AS avg_ticket
       FROM sales s
       LEFT JOIN (
         SELECT sale_id, SUM(total_profit) AS profit
         FROM sale_items GROUP BY sale_id
       ) si ON si.sale_id = s.id
       WHERE s.payment_status = 'paid'
         AND DATE(s.sale_date) BETWEEN $2 AND $3
       GROUP BY DATE_TRUNC($1, s.sale_date)
       ORDER BY period ASC`,
      [trunc, dateFrom, dateTo]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Reports] getSalesOverTime:', err);
    res.status(500).json({ error: 'Error al obtener ventas en el tiempo' });
  }
};

// ─────────────────────────────────────────────
// TOP PRODUCTOS MÁS VENDIDOS
// ─────────────────────────────────────────────
const getTopProducts = async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const result = await db.query(
      `SELECT
        p.id, p.name, p.sku,
        c.name                                                            AS category,
        SUM(si.quantity)                                                  AS units_sold,
        SUM(si.subtotal)                                                  AS revenue,
        COALESCE(SUM(si.total_profit), 0)                                AS profit,
        ROUND(COALESCE(SUM(si.total_profit), 0)
              / NULLIF(SUM(si.subtotal), 0) * 100, 2)                    AS margin_pct,
        p.stock                                                           AS current_stock
       FROM sale_items si
       JOIN sales    s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE s.payment_status = 'paid'
         AND DATE(s.sale_date) BETWEEN $1 AND $2
       GROUP BY p.id, p.name, p.sku, c.name, p.stock
       ORDER BY units_sold DESC
       LIMIT $3`,
      [dateFrom, dateTo, Number(limit)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Reports] getTopProducts:', err);
    res.status(500).json({ error: 'Error al obtener top productos' });
  }
};

// ─────────────────────────────────────────────
// VENTAS POR MÉTODO DE PAGO
// ─────────────────────────────────────────────
const getSalesByPaymentMethod = async (req, res) => {
  try {
    const { from, to } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const result = await db.query(
      `SELECT
        payment_method,
        COUNT(*)    AS orders,
        SUM(total)  AS revenue,
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS pct_orders
       FROM sales
       WHERE payment_status = 'paid'
         AND DATE(sale_date) BETWEEN $1 AND $2
       GROUP BY payment_method
       ORDER BY revenue DESC`,
      [dateFrom, dateTo]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Reports] getSalesByPaymentMethod:', err);
    res.status(500).json({ error: 'Error al obtener ventas por método de pago' });
  }
};

// ─────────────────────────────────────────────
// GASTOS POR TIPO Y CATEGORÍA
// ─────────────────────────────────────────────
const getExpensesBreakdown = async (req, res) => {
  try {
    const { from, to } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const [byType, byCategory] = await Promise.all([
      db.query(
        `SELECT
          expense_type,
          COUNT(*)    AS transactions,
          SUM(amount) AS total,
          ROUND(SUM(amount) * 100.0 / SUM(SUM(amount)) OVER (), 2) AS pct
         FROM expenses
         WHERE expense_date BETWEEN $1 AND $2
         GROUP BY expense_type
         ORDER BY total DESC`,
        [dateFrom, dateTo]
      ),
      db.query(
        `SELECT
          COALESCE(category, 'Sin categoría') AS category,
          COUNT(*)    AS transactions,
          SUM(amount) AS total
         FROM expenses
         WHERE expense_date BETWEEN $1 AND $2
         GROUP BY category
         ORDER BY total DESC
         LIMIT 10`,
        [dateFrom, dateTo]
      ),
    ]);

    res.json({ by_type: byType.rows, by_category: byCategory.rows });
  } catch (err) {
    console.error('[Reports] getExpensesBreakdown:', err);
    res.status(500).json({ error: 'Error al obtener desglose de gastos' });
  }
};

// ─────────────────────────────────────────────
// INVENTARIO
// ─────────────────────────────────────────────
const getInventoryReport = async (req, res) => {
  try {
    const [summary, lowStock, topValue, byCategory] = await Promise.all([
      db.query(
        `SELECT
          COUNT(*)                                                                      AS total_skus,
          SUM(stock)                                                                    AS total_units,
          COALESCE(SUM(stock * purchase_price), 0)                                     AS inventory_value,
          SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END)                                  AS out_of_stock,
          SUM(CASE WHEN stock > 0 AND stock <= min_stock THEN 1 ELSE 0 END)            AS low_stock,
          SUM(CASE WHEN stock >= max_stock THEN 1 ELSE 0 END)                          AS overstocked
         FROM products WHERE is_active = true`
      ),
      db.query(
        `SELECT p.id, p.name, p.sku, p.stock, p.min_stock,
                c.name AS category, p.sale_price, p.purchase_price
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.is_active = true AND p.stock <= p.min_stock
         ORDER BY p.stock ASC
         LIMIT 20`
      ),
      db.query(
        `SELECT p.id, p.name, p.sku, p.stock, p.purchase_price,
                (p.stock * p.purchase_price) AS inventory_value
         FROM products p
         WHERE p.is_active = true
         ORDER BY inventory_value DESC
         LIMIT 10`
      ),
      db.query(
        `SELECT
          COALESCE(c.name, 'Sin categoría') AS category,
          COUNT(p.id)                        AS products,
          SUM(p.stock)                       AS total_units,
          SUM(p.stock * p.purchase_price)    AS inventory_value
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.is_active = true
         GROUP BY c.name
         ORDER BY inventory_value DESC`
      ),
    ]);

    res.json({
      summary:     summary.rows[0],
      low_stock:   lowStock.rows,
      top_value:   topValue.rows,
      by_category: byCategory.rows,
    });
  } catch (err) {
    console.error('[Reports] getInventoryReport:', err);
    res.status(500).json({ error: 'Error al obtener reporte de inventario' });
  }
};

// ─────────────────────────────────────────────
// TOP CLIENTES
// ─────────────────────────────────────────────
const getTopCustomers = async (req, res) => {
  try {
    const { from, to, limit = 10 } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const result = await db.query(
      `SELECT
        u.id, u.name, u.email, u.phone, u.city,
        COUNT(s.id)      AS total_orders,
        SUM(s.total)     AS total_spent,
        AVG(s.total)     AS avg_order,
        MAX(s.sale_date) AS last_purchase
       FROM sales s
       JOIN users u ON u.id = s.customer_id
       WHERE s.payment_status = 'paid'
         AND DATE(s.sale_date) BETWEEN $1 AND $2
       GROUP BY u.id, u.name, u.email, u.phone, u.city
       ORDER BY total_spent DESC
       LIMIT $3`,
      [dateFrom, dateTo, Number(limit)]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Reports] getTopCustomers:', err);
    res.status(500).json({ error: 'Error al obtener top clientes' });
  }
};

// ─────────────────────────────────────────────
// FLUJO DE CAJA (usa la vista v_cashflow_detailed)
// ─────────────────────────────────────────────
const getCashflow = async (req, res) => {
  try {
    const { from, to } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const result = await db.query(
      `SELECT * FROM v_cashflow_detailed
       WHERE date BETWEEN $1::timestamp AND $2::timestamp
       ORDER BY date ASC`,
      [dateFrom, dateTo]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Reports] getCashflow:', err);
    res.status(500).json({ error: 'Error al obtener flujo de caja' });
  }
};

// ─────────────────────────────────────────────
// PROVEEDORES
// ─────────────────────────────────────────────
const getProvidersReport = async (req, res) => {
  try {
    const { from, to } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const [summary, topProviders, pendingOrders] = await Promise.all([
      db.query(
        `SELECT
          COUNT(*)                                                                              AS total_orders,
          COALESCE(SUM(total_cost), 0)                                                         AS total_purchased,
          COUNT(CASE WHEN status = 'pending' THEN 1 END)                                       AS pending_orders,
          COUNT(CASE WHEN payment_status = 'pending' THEN 1 END)                               AS unpaid_orders,
          COALESCE(SUM(CASE WHEN payment_status != 'paid' THEN total_cost ELSE 0 END), 0)      AS pending_debt
         FROM purchase_orders
         WHERE order_date BETWEEN $1 AND $2 AND status != 'cancelled'`,
        [dateFrom, dateTo]
      ),
      db.query(
        `SELECT
          p.id, p.name, p.category, p.reliability_score,
          COUNT(po.id)       AS orders,
          SUM(po.total_cost) AS total_purchased,
          COALESCE(SUM(CASE WHEN po.payment_status != 'paid' THEN po.total_cost ELSE 0 END), 0) AS pending_payment
         FROM providers p
         JOIN purchase_orders po ON po.provider_id = p.id
         WHERE po.order_date BETWEEN $1 AND $2 AND po.status != 'cancelled'
         GROUP BY p.id, p.name, p.category, p.reliability_score
         ORDER BY total_purchased DESC
         LIMIT 10`,
        [dateFrom, dateTo]
      ),
      db.query(
        `SELECT po.id, po.order_number, po.order_date,
                po.total_cost, po.payment_status, po.status,
                p.name AS provider_name
         FROM purchase_orders po
         JOIN providers p ON p.id = po.provider_id
         WHERE po.payment_status IN ('pending', 'partial')
           AND po.status != 'cancelled'
         ORDER BY po.order_date ASC
         LIMIT 10`
      ),
    ]);

    res.json({
      summary:        summary.rows[0],
      top_providers:  topProviders.rows,
      pending_orders: pendingOrders.rows,
    });
  } catch (err) {
    console.error('[Reports] getProvidersReport:', err);
    res.status(500).json({ error: 'Error al obtener reporte de proveedores' });
  }
};

// ─────────────────────────────────────────────
// RENTABILIDAD POR CATEGORÍA
// ─────────────────────────────────────────────
const getProfitByCategory = async (req, res) => {
  try {
    const { from, to } = req.query;
    const today    = new Date();
    const dateFrom = from || new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || today.toISOString().split('T')[0];

    const result = await db.query(
      `SELECT
        COALESCE(c.name, 'Sin categoría')                             AS category,
        COUNT(DISTINCT p.id)                                          AS products,
        SUM(si.quantity)                                              AS units_sold,
        SUM(si.subtotal)                                              AS revenue,
        COALESCE(SUM(si.total_profit), 0)                            AS profit,
        ROUND(COALESCE(SUM(si.total_profit), 0)
              / NULLIF(SUM(si.subtotal), 0) * 100, 2)                AS margin_pct
       FROM sale_items si
       JOIN sales    s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE s.payment_status = 'paid'
         AND DATE(s.sale_date) BETWEEN $1 AND $2
       GROUP BY c.name
       ORDER BY revenue DESC`,
      [dateFrom, dateTo]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Reports] getProfitByCategory:', err);
    res.status(500).json({ error: 'Error al obtener rentabilidad por categoría' });
  }
};

module.exports = {
  getReportSummary,
  getSalesOverTime,
  getTopProducts,
  getSalesByPaymentMethod,
  getExpensesBreakdown,
  getInventoryReport,
  getTopCustomers,
  getCashflow,
  getProvidersReport,
  getProfitByCategory,
};
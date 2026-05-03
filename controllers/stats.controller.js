// controllers/stats.controller.js
// ─── Todo PostgreSQL (Neon) ───────────────────────────────────────
const pool = require("../config/db");

const getDashboardStats = async (req, res) => {
  try {
    const [
      revenueVsExpenses,
      cashflow,
      topProducts,
      marginByCategory,
      paymentMethods,
      expensesByType,
      kpiSummary,
      providerDebt,
      lowStock,
      pendingOrders,
    ] = await Promise.all([
      getRevenueVsExpenses(),
      getCashflow12Months(),
      getTopProductsByProfit(),
      getMarginByCategory(),
      getPaymentMethodDistribution(),
      getExpensesByType(),
      getKpiSummary(),
      getProviderDebt(),
      getLowStockProducts(),
      getPendingOrders(),
    ]);

    return res.json({
      revenueVsExpenses,
      cashflow,
      topProducts,
      marginByCategory,
      paymentMethods,
      expensesByType,
      kpiSummary,
      providerDebt,
      lowStock,
      pendingOrders,
    });
  } catch (err) {
    console.error("[STATS /dashboard]", err);
    return res.status(500).json({ error: "Error al cargar estadísticas del dashboard" });
  }
};

// ── Ingresos vs Gastos — últimas 8 semanas ────────────────────────
async function getRevenueVsExpenses() {
  const { rows } = await pool.query(`
    WITH weeks AS (SELECT generate_series(0, 7) AS w),
    week_ranges AS (
      SELECT
        w,
        CURRENT_DATE - ((w + 1) * 7)  AS week_start,
        CURRENT_DATE - (w * 7)         AS week_end,
        'S' || (8 - w)                 AS label
      FROM weeks
    ),
    sales_agg AS (
      SELECT wr.label, wr.w,
        COALESCE(SUM(s.total), 0) AS ingresos
      FROM week_ranges wr
      LEFT JOIN sales s
        ON s.sale_date::date >= wr.week_start
        AND s.sale_date::date < wr.week_end
        AND s.payment_status = 'paid'
      GROUP BY wr.label, wr.w
    ),
    expenses_agg AS (
      SELECT wr.label, wr.w,
        COALESCE(SUM(e.amount), 0) AS gastos
      FROM week_ranges wr
      LEFT JOIN expenses e
        ON e.expense_date >= wr.week_start
        AND e.expense_date < wr.week_end
      GROUP BY wr.label, wr.w
    )
    SELECT
      sa.label                              AS name,
      ROUND(sa.ingresos, 0)                 AS ingresos,
      ROUND(ea.gastos, 0)                   AS gastos,
      ROUND(sa.ingresos - ea.gastos, 0)     AS utilidad
    FROM sales_agg sa
    JOIN expenses_agg ea USING (label, w)
    ORDER BY sa.w DESC
  `);
  return rows;
}

// ── Flujo de caja — últimos 12 meses ──────────────────────────────
async function getCashflow12Months() {
  const { rows } = await pool.query(`
    SELECT
      TO_CHAR(month_start, 'Mon')    AS name,
      TO_CHAR(month_start, 'YYYY-MM') AS period,
      ROUND(COALESCE(SUM(CASE WHEN type = 'income'  THEN amount END), 0), 0) AS ingresos,
      ROUND(COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0), 0) AS gastos
    FROM (
      SELECT DATE_TRUNC('month', sale_date)                AS month_start, 'income'  AS type, total  AS amount
      FROM sales
      WHERE payment_status = 'paid'
        AND sale_date >= NOW() - INTERVAL '12 months'

      UNION ALL

      SELECT DATE_TRUNC('month', expense_date::timestamp)  AS month_start, 'expense' AS type, amount
      FROM expenses
      WHERE expense_date >= NOW() - INTERVAL '12 months'
    ) combined
    GROUP BY month_start
    ORDER BY month_start ASC
  `);
  return rows;
}

// ── Top 6 productos por utilidad realizada ─────────────────────────
async function getTopProductsByProfit() {
  const { rows } = await pool.query(`
    SELECT
      p.id,
      CASE WHEN LENGTH(p.name) > 16 THEN SUBSTRING(p.name, 1, 14) || '…' ELSE p.name END AS name,
      ROUND(COALESCE(SUM(si.total_profit), 0), 0)   AS revenue,
      COALESCE(SUM(si.quantity), 0)::int             AS units,
      ROUND(p.sale_price, 0)                         AS price,
      ROUND(p.sale_price - p.purchase_price, 0)      AS margin_per_unit,
      CASE
        WHEN p.purchase_price > 0
        THEN ROUND((p.sale_price - p.purchase_price) / p.purchase_price * 100, 1)
        ELSE 0
      END AS margin_pct
    FROM products p
    LEFT JOIN sale_items si ON si.product_id = p.id
    WHERE p.is_active = true
    GROUP BY p.id, p.name, p.sale_price, p.purchase_price
    ORDER BY revenue DESC
    LIMIT 6
  `);
  return rows;
}

// ── Margen por categoría ───────────────────────────────────────────
async function getMarginByCategory() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(c.name, 'Sin categoría') AS name,
      ROUND(
        CASE
          WHEN SUM(p.sale_price) > 0
          THEN (SUM(p.sale_price - p.purchase_price) / SUM(p.sale_price)) * 100
          ELSE 0
        END, 1
      ) AS margin
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = true AND p.purchase_price > 0
    GROUP BY c.name
    HAVING SUM(p.sale_price) > 0
    ORDER BY margin DESC
    LIMIT 6
  `);
  return rows;
}

// ── Distribución de métodos de pago ───────────────────────────────
async function getPaymentMethodDistribution() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(payment_method::text, 'other') AS name,
      COUNT(*)::int                            AS value,
      ROUND(SUM(total), 0)                     AS total_amount
    FROM sales
    WHERE payment_status = 'paid'
      AND created_at >= NOW() - INTERVAL '90 days'
    GROUP BY payment_method
    ORDER BY value DESC
  `);
  return rows;
}

// ── Gastos por tipo (mes actual) ───────────────────────────────────
async function getExpensesByType() {
  const { rows } = await pool.query(`
    SELECT
      expense_type::text    AS name,
      ROUND(SUM(amount), 0) AS value,
      COUNT(*)::int         AS count
    FROM expenses
    WHERE expense_date >= DATE_TRUNC('month', CURRENT_DATE)
    GROUP BY expense_type
    ORDER BY value DESC
  `);
  return rows;
}

// ── KPIs de resumen ────────────────────────────────────────────────
async function getKpiSummary() {
  const { rows } = await pool.query(`
    WITH
      today_sales     AS (SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE sale_date::date = CURRENT_DATE         AND payment_status = 'paid'),
      yesterday_sales AS (SELECT COALESCE(SUM(total), 0) AS total FROM sales WHERE sale_date::date = CURRENT_DATE - 1     AND payment_status = 'paid'),
      month_sales     AS (
        SELECT
          COALESCE(SUM(total), 0) AS revenue,
          COALESCE(AVG(total), 0) AS avg_ticket,
          COUNT(*)                 AS count
        FROM sales
        WHERE DATE_TRUNC('month', sale_date) = DATE_TRUNC('month', NOW())
          AND payment_status = 'paid'
      ),
      last_month      AS (SELECT COALESCE(SUM(total), 0) AS revenue FROM sales WHERE DATE_TRUNC('month', sale_date) = DATE_TRUNC('month', NOW() - INTERVAL '1 month') AND payment_status = 'paid'),
      month_expenses  AS (SELECT COALESCE(SUM(amount), 0) AS total  FROM expenses WHERE DATE_TRUNC('month', expense_date::timestamp) = DATE_TRUNC('month', NOW())),
      inventory       AS (SELECT COALESCE(SUM(stock * sale_price), 0) AS value, COUNT(*) AS sku_count FROM products WHERE is_active = true),
      low_stock_cnt   AS (SELECT COUNT(*) AS cnt FROM products WHERE is_active = true AND stock <= COALESCE(min_stock, 5)),
      pending_po      AS (SELECT COUNT(*) AS cnt FROM purchase_orders WHERE status IN ('pending', 'draft')),
      provider_debt   AS (SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*) FILTER (WHERE balance > 0) AS cnt FROM providers WHERE is_active = true)
    SELECT
      ts.total                                                                       AS sales_today,
      ys.total                                                                       AS sales_yesterday,
      ms.revenue                                                                     AS month_revenue,
      lm.revenue                                                                     AS last_month_revenue,
      ms.avg_ticket                                                                  AS avg_ticket,
      ms.count::int                                                                  AS month_sales_count,
      me.total                                                                       AS month_expenses,
      CASE WHEN ms.revenue > 0 THEN ROUND((ms.revenue - me.total) / ms.revenue * 100, 1) ELSE 0 END AS net_margin,
      inv.value                                                                      AS inventory_value,
      inv.sku_count::int                                                             AS sku_count,
      ls.cnt::int                                                                    AS low_stock_count,
      pp.cnt::int                                                                    AS pending_orders,
      pd.total                                                                       AS total_debt,
      pd.cnt::int                                                                    AS active_providers
    FROM today_sales ts, yesterday_sales ys, month_sales ms, last_month lm,
         month_expenses me, inventory inv, low_stock_cnt ls, pending_po pp, provider_debt pd
  `);
  return rows[0] ?? {};
}

// ── Deuda con proveedores ──────────────────────────────────────────
async function getProviderDebt() {
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.name,
      p.category::text,
      ROUND(p.balance, 0)       AS balance,
      ROUND(p.credit_limit, 0)  AS credit_limit,
      p.payment_terms_days      AS terms,
      CASE WHEN p.credit_limit > 0 THEN ROUND((p.balance / p.credit_limit) * 100, 1) ELSE 0 END AS usage_pct
    FROM providers p
    WHERE p.balance > 0 AND p.is_active = true
    ORDER BY p.balance DESC
    LIMIT 6
  `);
  return rows;
}

// ── Productos con stock bajo ───────────────────────────────────────
async function getLowStockProducts() {
  const { rows } = await pool.query(`
    SELECT
      p.id, p.name, p.stock, p.min_stock, p.max_stock,
      COALESCE(c.name, 'Sin categoría') AS category_name,
      CASE
        WHEN p.stock = 0            THEN 'out'
        WHEN p.stock <= p.min_stock THEN 'low'
        ELSE 'normal'
      END AS stock_status
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = true AND p.stock <= COALESCE(p.min_stock, 5)
    ORDER BY p.stock ASC
    LIMIT 10
  `);
  return rows;
}

// ── Órdenes de compra pendientes ───────────────────────────────────
async function getPendingOrders() {
  const { rows } = await pool.query(`
    SELECT
      po.id, po.order_number,
      po.status::text,
      po.payment_status::text,
      ROUND(po.total_cost, 0)         AS total_cost,
      po.order_date,
      po.expected_delivery_date,
      pr.name                          AS provider_name,
      CASE
        WHEN po.expected_delivery_date < CURRENT_DATE
          AND po.status NOT IN ('received', 'cancelled')
        THEN true ELSE false
      END AS is_late
    FROM purchase_orders po
    JOIN providers pr ON pr.id = po.provider_id
    WHERE po.status IN ('pending', 'draft')
    ORDER BY po.expected_delivery_date ASC NULLS LAST
    LIMIT 5
  `);
  return rows;
}

module.exports = { getDashboardStats };
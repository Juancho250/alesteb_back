const express = require("express");
const router  = express.Router();
const db      = require("../config/db");

// ─────────────────────────────────────────────
// Helper: convierte db.get / db.all a promesas
// ─────────────────────────────────────────────
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows ?? [])))
  );

// ─────────────────────────────────────────────
// GET /api/stats/dashboard
// ─────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const [
      kpiRow,
      yesterdayRow,
      lastMonthRow,
      revenueVsExpenses,
      cashflow,
      topProducts,
      paymentMethods,
      expensesByType,
      marginByCategory,
      lowStock,
      providerDebt,
      pendingOrders,
    ] = await Promise.all([

      // ── KPIs principales ──────────────────
      dbGet(`
        SELECT
          COALESCE((
            SELECT SUM(total) FROM sales
            WHERE DATE(sale_date) = DATE('now')
              AND payment_status = 'paid'
          ), 0) AS sales_today,

          COALESCE((
            SELECT SUM(total) FROM sales
            WHERE strftime('%Y-%m', sale_date) = strftime('%Y-%m', 'now')
              AND payment_status = 'paid'
          ), 0) AS month_revenue,

          COALESCE((
            SELECT AVG(total) FROM sales
            WHERE payment_status = 'paid'
          ), 0) AS avg_ticket,

          COALESCE((
            SELECT SUM(amount) FROM expenses
            WHERE strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now')
          ), 0) AS month_expenses,

          COALESCE((
            SELECT SUM(stock * sale_price) FROM products
            WHERE is_active = 1
          ), 0) AS inventory_value,

          (SELECT COUNT(*) FROM products WHERE is_active = 1) AS sku_count,

          (SELECT COUNT(*) FROM products
            WHERE is_active = 1
              AND stock <= COALESCE(min_stock, 5)
          ) AS low_stock_count,

          (SELECT COUNT(*) FROM purchase_orders
            WHERE status IN ('pending','draft')
          ) AS pending_orders,

          COALESCE((
            SELECT SUM(balance) FROM providers WHERE is_active = 1
          ), 0) AS total_debt,

          (SELECT COUNT(*) FROM providers WHERE is_active = 1) AS active_providers
      `),

      // ── Ventas ayer (para % variación) ───
      dbGet(`
        SELECT COALESCE(SUM(total), 0) AS total
        FROM sales
        WHERE DATE(sale_date) = DATE('now', '-1 day')
          AND payment_status = 'paid'
      `),

      // ── Ingresos mes anterior ─────────────
      dbGet(`
        SELECT COALESCE(SUM(total), 0) AS total
        FROM sales
        WHERE strftime('%Y-%m', sale_date) = strftime('%Y-%m', DATE('now', '-1 month'))
          AND payment_status = 'paid'
      `),

      // ── Ingresos vs Gastos — últimas 8 semanas ──
      dbAll(`
        SELECT
          'S' || (8 - w) AS name,
          COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS ingresos,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS gastos,
          COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE -amount END), 0) AS utilidad
        FROM (
          SELECT 0 AS w UNION SELECT 1 UNION SELECT 2 UNION SELECT 3
          UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7
        ) weeks
        LEFT JOIN (
          SELECT
            CAST((julianday('now') - julianday(sale_date)) / 7 AS INT) AS w,
            'income'  AS type,
            total     AS amount
          FROM sales
          WHERE payment_status = 'paid'
            AND sale_date >= DATE('now', '-56 days')

          UNION ALL

          SELECT
            CAST((julianday('now') - julianday(expense_date)) / 7 AS INT) AS w,
            'expense' AS type,
            amount
          FROM expenses
          WHERE expense_date >= DATE('now', '-56 days')
        ) data USING (w)
        GROUP BY w
        ORDER BY w DESC
      `),

      // ── Flujo de caja — últimos 12 meses ──
      dbAll(`
        SELECT
          strftime('%Y-%m', month) AS period,
          SUBSTR(
            'EneFebMarAbrMayJunJulAgoSepOctNovDic',
            (CAST(strftime('%m', month) AS INT) - 1) * 3 + 1,
            3
          ) AS name,
          COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS ingresos,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS gastos
        FROM (
          SELECT
            DATE(sale_date, 'start of month') AS month,
            'income' AS type,
            total    AS amount
          FROM sales
          WHERE payment_status = 'paid'
            AND sale_date >= DATE('now', '-12 months')

          UNION ALL

          SELECT
            DATE(expense_date, 'start of month') AS month,
            'expense' AS type,
            amount
          FROM expenses
          WHERE expense_date >= DATE('now', '-12 months')
        ) combined
        GROUP BY period
        ORDER BY period ASC
      `),

      // ── Top 6 productos por utilidad realizada ──
      dbAll(`
        SELECT
          CASE WHEN LENGTH(p.name) > 16
            THEN SUBSTR(p.name, 1, 14) || '…'
            ELSE p.name
          END AS name,
          ROUND(COALESCE(SUM(si.total_profit), 0), 0) AS revenue,
          COALESCE(SUM(si.quantity), 0)                AS units,
          ROUND(p.sale_price, 0)                        AS price,
          ROUND(p.sale_price - p.purchase_price, 0)     AS margin_per_unit,
          CASE WHEN p.purchase_price > 0
            THEN ROUND(
              (p.sale_price - p.purchase_price) / p.purchase_price * 100, 1
            )
            ELSE 0
          END AS margin_pct
        FROM products p
        LEFT JOIN sale_items si ON si.product_id = p.id
        WHERE p.is_active = 1
        GROUP BY p.id
        ORDER BY revenue DESC
        LIMIT 6
      `),

      // ── Distribución métodos de pago ──────
      dbAll(`
        SELECT
          COALESCE(payment_method, 'other') AS name,
          COUNT(*)                           AS value,
          ROUND(SUM(total), 0)               AS total_amount
        FROM sales
        WHERE payment_status = 'paid'
          AND sale_date >= DATE('now', '-90 days')
        GROUP BY payment_method
        ORDER BY value DESC
      `),

      // ── Gastos por tipo (mes actual) ──────
      dbAll(`
        SELECT
          expense_type        AS name,
          ROUND(SUM(amount), 0) AS value,
          COUNT(*)              AS count
        FROM expenses
        WHERE strftime('%Y-%m', expense_date) = strftime('%Y-%m', 'now')
        GROUP BY expense_type
        ORDER BY value DESC
      `),

      // ── Margen por categoría ──────────────
      dbAll(`
        SELECT
          COALESCE(c.name, 'Sin categoría') AS name,
          ROUND(
            CASE WHEN SUM(p.sale_price) > 0
              THEN (SUM(p.sale_price - p.purchase_price) / SUM(p.sale_price)) * 100
              ELSE 0
            END, 1
          ) AS margin
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = 1 AND p.purchase_price > 0
        GROUP BY c.name
        HAVING SUM(p.sale_price) > 0
        ORDER BY margin DESC
        LIMIT 6
      `),

      // ── Productos con stock bajo ──────────
      dbAll(`
        SELECT
          p.id,
          p.name,
          p.stock,
          p.min_stock,
          p.max_stock,
          COALESCE(c.name, 'Sin categoría') AS category_name,
          CASE
            WHEN p.stock = 0                           THEN 'out'
            WHEN p.stock <= COALESCE(p.min_stock, 5)  THEN 'low'
            ELSE 'normal'
          END AS stock_status
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.is_active = 1
          AND p.stock <= COALESCE(p.min_stock, 5)
        ORDER BY p.stock ASC
        LIMIT 10
      `),

      // ── Deuda con proveedores ─────────────
      dbAll(`
        SELECT
          p.id,
          p.name,
          p.category,
          ROUND(p.balance, 0)       AS balance,
          ROUND(p.credit_limit, 0)  AS credit_limit,
          p.payment_terms_days      AS terms,
          CASE WHEN p.credit_limit > 0
            THEN ROUND((p.balance / p.credit_limit) * 100, 1)
            ELSE 0
          END AS usage_pct
        FROM providers p
        WHERE p.balance > 0 AND p.is_active = 1
        ORDER BY p.balance DESC
        LIMIT 6
      `),

      // ── Órdenes de compra pendientes ──────
      dbAll(`
        SELECT
          po.id,
          po.order_number,
          po.status,
          po.payment_status,
          ROUND(po.total_cost, 0)     AS total_cost,
          po.order_date,
          po.expected_delivery_date,
          pr.name                     AS provider_name,
          CASE
            WHEN po.expected_delivery_date < DATE('now')
              AND po.status NOT IN ('received', 'cancelled')
            THEN 1 ELSE 0
          END AS is_late
        FROM purchase_orders po
        JOIN providers pr ON pr.id = po.provider_id
        WHERE po.status IN ('pending', 'draft')
        ORDER BY po.expected_delivery_date ASC
        LIMIT 5
      `),
    ]);

    // ── Calcular margen neto ──────────────────
    const netMargin =
      kpiRow.month_revenue > 0
        ? +(
            ((kpiRow.month_revenue - kpiRow.month_expenses) /
              kpiRow.month_revenue) *
            100
          ).toFixed(1)
        : 0;

    return res.json({
      kpiSummary: {
        ...kpiRow,
        sales_yesterday:    yesterdayRow?.total ?? 0,
        last_month_revenue: lastMonthRow?.total ?? 0,
        net_margin:         netMargin,
      },
      revenueVsExpenses,
      cashflow,
      topProducts,
      paymentMethods,
      expensesByType,
      marginByCategory,
      lowStock,
      providerDebt,
      pendingOrders,
    });

  } catch (err) {
    console.error("[STATS /dashboard]", err);
    return res.status(500).json({ error: "Error al cargar estadísticas" });
  }
});

module.exports = router;
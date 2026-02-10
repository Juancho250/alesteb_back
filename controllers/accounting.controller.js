const db = require("../config/db");

const pf = (v) => parseFloat(v) || 0;



// ============================================
// 📊 RESUMEN GENERAL P&L
// ============================================
exports.getSummary = async (req, res) => {
  const { start_date, end_date } = req.query;
  const dp = start_date && end_date ? [start_date, end_date] : [];
  const sf = dp.length ? "AND s.created_at BETWEEN $1 AND $2" : "";
  const ef = dp.length ? "WHERE created_at BETWEEN $1 AND $2" : "";
  const pf2 = dp.length ? "AND po.created_at BETWEEN $1 AND $2" : "";

  try {
    const [rvRes, exRes, poRes, debtRes] = await Promise.all([
      db.query(
        `SELECT
           COALESCE(SUM(s.total), 0)                             AS total_revenue,
           COALESCE(SUM(si.unit_cost * si.quantity), 0)          AS cogs,
           COALESCE(SUM(s.total - si.unit_cost * si.quantity),0) AS gross_profit,
           COUNT(DISTINCT s.id)                                   AS total_sales,
           COUNT(DISTINCT s.customer_id)                          AS unique_customers
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         WHERE s.payment_status = 'paid' ${sf}`,
        dp
      ),
      exRes, // ✅ Query corregida abajo
        db.query(
        `SELECT
            COALESCE(SUM(CASE WHEN expense_type IN ('service', 'utility', 'tax', 'salary', 'other') 
                            THEN amount ELSE 0 END), 0) AS operating_expenses,
            COALESCE(SUM(CASE WHEN expense_type = 'purchase' 
                            THEN amount ELSE 0 END), 0) AS purchase_expenses
        FROM expenses ${ef}`,
        dp
        ),
      db.query(
        `SELECT
           COALESCE(SUM(po.total_cost),0)                                                              AS total_purchased,
           COUNT(po.id)                                                                                 AS total_orders,
           COALESCE(SUM(CASE WHEN po.payment_status IN ('pending','partial') THEN po.total_cost ELSE 0 END),0) AS pending_payment
         FROM purchase_orders po
         WHERE po.status != 'cancelled' ${pf2}`,
        dp
      ),
      db.query("SELECT COALESCE(SUM(balance),0) AS provider_debt FROM providers WHERE is_active = true"),
    ]);

    const rv = rvRes.rows[0];
    const ex = exRes.rows[0];
    const po = poRes.rows[0];

    const totalRevenue      = pf(rv.total_revenue);
    const cogs              = pf(rv.cogs);
    const grossProfit       = pf(rv.gross_profit);
    const operatingExpenses = pf(ex.operating_expenses);
    const netProfit         = grossProfit - operatingExpenses;
    const grossMargin       = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const netMargin         = totalRevenue > 0 ? (netProfit  / totalRevenue) * 100 : 0;

    res.json({
      revenue: {
        total: totalRevenue, cogs, gross_profit: grossProfit,
        gross_margin_pct: +grossMargin.toFixed(2),
        total_sales: parseInt(rv.total_sales),
        unique_customers: parseInt(rv.unique_customers),
      },
      expenses: {
        operating: operatingExpenses,
        purchases: pf(ex.purchase_expenses),
        total_purchased: pf(po.total_purchased),
        pending_payment: pf(po.pending_payment),
        total_orders: parseInt(po.total_orders),
      },
      profitability: {
        gross_profit: grossProfit, net_profit: netProfit,
        gross_margin_pct: +grossMargin.toFixed(2),
        net_margin_pct: +netMargin.toFixed(2),
      },
      debt: { provider_total: pf(debtRes.rows[0].provider_debt) },
    });
  } catch (err) {
    console.error("[ACCOUNTING SUMMARY]", err);
    res.status(500).json({ message: "Error al obtener resumen contable" });
  }
};

// ============================================
// 📈 FLUJO MENSUAL – últimos 6 meses
// ============================================
exports.getCashflow = async (req, res) => {
  try {
    const [rvRows, costRows] = await Promise.all([
      db.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at),'Mon YY') AS month,
               DATE_TRUNC('month', created_at)                   AS month_date,
               COALESCE(SUM(total),0)                            AS revenue
        FROM sales
        WHERE payment_status='paid' AND created_at >= NOW()-INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at) ORDER BY month_date
      `),
      db.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at),'Mon YY') AS month,
               COALESCE(SUM(amount),0)                           AS costs
        FROM expenses
        WHERE created_at >= NOW()-INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY DATE_TRUNC('month', created_at)
      `),
    ]);

    const map = {};
    rvRows.rows.forEach(r  => { map[r.month] = { month: r.month, revenue: pf(r.revenue), costs: 0 }; });
    costRows.rows.forEach(r => {
      if (map[r.month]) map[r.month].costs = pf(r.costs);
      else map[r.month] = { month: r.month, revenue: 0, costs: pf(r.costs) };
    });

    res.json(Object.values(map).map(m => ({ ...m, profit: m.revenue - m.costs })));
  } catch (err) {
    console.error("[CASHFLOW]", err);
    res.status(500).json({ message: "Error al obtener flujo de caja" });
  }
};

// ============================================
// 🏷️ RENTABILIDAD POR PRODUCTO
// ============================================
exports.getProfitByProduct = async (req, res) => {
  const { limit = 100 } = req.query;
  try {
    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku, p.stock,
         COALESCE(p.purchase_price,0)                                             AS cost_price,
         COALESCE(p.price,0)                                                       AS sale_price,
         COALESCE(p.price - p.purchase_price,0)                                   AS unit_profit,
         CASE WHEN COALESCE(p.price,0)>0
              THEN ROUND(((p.price - p.purchase_price)/p.price*100)::numeric,2)
              ELSE 0 END                                                            AS margin_pct,
         COALESCE(s.units_sold,0)     AS units_sold,
         COALESCE(s.total_revenue,0)  AS total_revenue,
         COALESCE(s.total_profit,0)   AS realized_profit,
         p.stock * COALESCE(p.purchase_price,0) AS inventory_value
       FROM products p
       LEFT JOIN (
         SELECT product_id,
                SUM(quantity)                        AS units_sold,
                SUM(subtotal)                        AS total_revenue,
                SUM(subtotal - unit_cost*quantity)   AS total_profit
         FROM sale_items GROUP BY product_id
       ) s ON s.product_id = p.id
       WHERE COALESCE(p.purchase_price,0) > 0
       ORDER BY realized_profit DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[PROFIT BY PRODUCT]", err);
    res.status(500).json({ message: "Error al obtener rentabilidad" });
  }
};

// ============================================
// 🛒 REGISTRAR COMPRA RÁPIDA
// ============================================
exports.registerPurchase = async (req, res) => {
  const {
    product_id, provider_id, quantity, unit_cost, sale_price,
    payment_method = "cash", category = "compra_mercancia", notes,
  } = req.body;

  if (!product_id || !quantity || !unit_cost) {
    return res.status(400).json({ message: "Faltan: product_id, quantity, unit_cost" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const totalCost  = quantity * unit_cost;
    const unitProfit = sale_price ? (sale_price - unit_cost) : 0;

    // 1. Expense record
    await client.query(
    `INSERT INTO expenses (expense_type, category, amount, provider_id, product_id, quantity, utility_type, utility_value)
    VALUES ('purchase', $1, $2, $3, $4, $5, 'fixed', $6)`,
      [category, totalCost, provider_id || null, product_id, quantity, unitProfit]
    );

    // 2. Update product stock, purchase_price, and optionally sale price
    if (sale_price) {
      await client.query(
        `UPDATE products SET purchase_price=$1, stock=stock+$2, price=$3, updated_at=NOW() WHERE id=$4`,
        [unit_cost, quantity, sale_price, product_id]
      );
    } else {
      await client.query(
        `UPDATE products SET purchase_price=$1, stock=stock+$2, updated_at=NOW() WHERE id=$3`,
        [unit_cost, quantity, product_id]
      );
    }

    // 3. Provider balance if credit
    if (provider_id && payment_method === "credit") {
      await client.query(
        "UPDATE providers SET balance=balance+$1 WHERE id=$2",
        [totalCost, provider_id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({
      message: "Compra registrada",
      summary: {
        total_cost: totalCost,
        unit_profit: unitProfit,
        margin_pct: sale_price ? +((unitProfit / sale_price) * 100).toFixed(2) : null,
        expected_revenue: sale_price ? sale_price * quantity : null,
        expected_profit: unitProfit * quantity,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[REGISTER PURCHASE]", err);
    res.status(500).json({ message: "Error al registrar compra" });
  } finally {
    client.release();
  }
};

// ============================================
// 📋 HISTORIAL DE COMPRAS
// ============================================
exports.getPurchaseHistory = async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  try {
    const result = await db.query(
      `SELECT
         e.id, e.created_at,
         e.amount                                           AS total_cost,
         e.quantity,
         ROUND((e.amount / NULLIF(e.quantity,0))::numeric,0) AS unit_cost,
         e.utility_value                                    AS unit_profit,
         (e.utility_value * e.quantity)                     AS expected_profit,
         CASE WHEN (e.utility_value + e.amount/NULLIF(e.quantity,0)) > 0
              THEN ROUND((e.utility_value/(e.utility_value+e.amount/NULLIF(e.quantity,0))*100)::numeric,2)
              ELSE 0 END                                    AS margin_pct,
         p.name  AS product_name, p.sku,
         pr.name AS provider_name,
         e.category
       FROM expenses e
       LEFT JOIN products  p  ON p.id  = e.product_id
       LEFT JOIN providers pr ON pr.id = e.provider_id
       WHERE e.expense_type = 'purchase'
       ORDER BY e.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[PURCHASE HISTORY]", err);
    res.status(500).json({ message: "Error al obtener historial" });
  }
};

// ============================================
// 💸 GASTOS OPERATIVOS
// ============================================
exports.getExpensesBreakdown = async (req, res) => {
  const { start_date, end_date } = req.query;
  const params = [];
  let where = "WHERE expense_type IN ('service', 'utility', 'tax', 'salary', 'other')";
  
  if (start_date && end_date) {
    where += " AND created_at BETWEEN $1 AND $2";
    params.push(start_date, end_date);
  }
  
  try {
    const [byCategory, recent] = await Promise.all([
      db.query(
        `SELECT category, COUNT(*) AS count,
                COALESCE(SUM(amount), 0) AS total,
                COALESCE(AVG(amount), 0) AS average
         FROM expenses ${where} 
         GROUP BY category 
         ORDER BY total DESC`,
        params
      ),
      db.query(
        `SELECT e.*, p.name AS provider_name 
         FROM expenses e
         LEFT JOIN providers p ON p.id = e.provider_id
         WHERE e.expense_type IN ('service', 'utility', 'tax', 'salary', 'other')
         ORDER BY e.created_at DESC 
         LIMIT 20`
      ),
    ]);
    
    res.json({ by_category: byCategory.rows, recent: recent.rows });
  } catch (err) {
    console.error("[EXPENSES BREAKDOWN]", err);
    res.status(500).json({ message: "Error al obtener gastos" });
  }
};

// ============================================
// 🏦 DEUDA CON PROVEEDORES
// ============================================
exports.getProviderDebts = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        p.id, p.name, p.category, p.balance, p.credit_limit,
        p.payment_terms_days, p.phone, p.email,
        CASE WHEN p.credit_limit>0
             THEN ROUND((p.balance/p.credit_limit*100)::numeric,2)
             ELSE 0 END                  AS credit_used_pct,
        COALESCE(pending.total,0)        AS orders_pending_payment
      FROM providers p
      LEFT JOIN (
        SELECT provider_id, SUM(total_cost) AS total
        FROM purchase_orders
        WHERE payment_status IN ('pending','partial') AND status!='cancelled'
        GROUP BY provider_id
      ) pending ON pending.provider_id=p.id
      WHERE p.is_active=true
      ORDER BY p.balance DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("[PROVIDER DEBTS]", err);
    res.status(500).json({ message: "Error al obtener deudas" });
  }
};

module.exports = exports;
const db = require("../config/db");

const pf = (v) => parseFloat(v) || 0;

// ============================================
// 📊 /finance/summary  ← NUEVO endpoint unificado
// Devuelve exactamente la forma que espera Finance.jsx:
//   s.revenue.total, s.revenue.total_sales, s.revenue.cogs
//   s.profitability.gross_profit / gross_margin_pct / net_profit / net_margin_pct
//   s.expenses.operating
//   s.debt.provider_total
// ============================================
exports.getSummary = async (req, res) => {
  const { start_date, end_date } = req.query;
  const dp = start_date && end_date ? [start_date, end_date] : [];
  const sf = dp.length ? "AND s.sale_date BETWEEN $1 AND $2" : "";
  const ef = dp.length ? "WHERE expense_date BETWEEN $1 AND $2" : "";

  try {
    const [salesRes, expensesRes, inventoryRes, arRes, apRes] = await Promise.all([
      db.query(
        `SELECT
           COALESCE(SUM(s.total), 0)                      AS total_revenue,
           COALESCE(SUM(s.tax_amount), 0)                 AS total_taxes,
           COALESCE(SUM(si.unit_cost * si.quantity), 0)   AS cogs,
           COUNT(DISTINCT s.id)                           AS total_sales
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
         WHERE s.payment_status = 'paid' ${sf}`,
        dp
      ),
      db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN expense_type IN ('service','utility','tax','salary','other')
                             THEN amount ELSE 0 END), 0)  AS operating_expenses,
           COALESCE(SUM(CASE WHEN expense_type = 'purchase'
                             THEN amount ELSE 0 END), 0)  AS purchase_expenses
         FROM expenses ${ef}`,
        dp
      ),
      db.query(`
        SELECT
          COALESCE(SUM(stock * COALESCE(purchase_price,0)), 0) AS inventory_value,
          COUNT(*)                                              AS total_products,
          COUNT(CASE WHEN stock <= min_stock THEN 1 END)       AS low_stock_count
        FROM products WHERE is_active = true
      `),
      db.query(`
        SELECT COALESCE(SUM(total), 0) AS accounts_receivable
        FROM sales WHERE payment_status = 'pending'
      `),
      db.query(`
        SELECT COALESCE(SUM(balance), 0) AS accounts_payable
        FROM providers WHERE is_active = true
      `),
    ]);

    const s    = salesRes.rows[0];
    const exp  = expensesRes.rows[0];
    const inv  = inventoryRes.rows[0];
    const ar   = arRes.rows[0];
    const ap   = apRes.rows[0];

    const totalRevenue       = pf(s.total_revenue);
    const cogs               = pf(s.cogs);
    const grossProfit        = totalRevenue - cogs;
    const operatingExpenses  = pf(exp.operating_expenses);
    const netProfit          = grossProfit - operatingExpenses;

    // Forma exacta que Finance.jsx consume
    res.json({
      revenue: {
        total:       totalRevenue,
        cogs:        cogs,
        total_sales: parseInt(s.total_sales),
      },
      profitability: {
        gross_profit:      grossProfit,
        gross_margin_pct:  totalRevenue > 0 ? +((grossProfit / totalRevenue) * 100).toFixed(2) : 0,
        net_profit:        netProfit,
        net_margin_pct:    totalRevenue > 0 ? +((netProfit  / totalRevenue) * 100).toFixed(2) : 0,
      },
      expenses: {
        operating:  operatingExpenses,
        purchases:  pf(exp.purchase_expenses),
      },
      debt: {
        provider_total: pf(ap.accounts_payable),
      },
      assets: {
        inventory:           pf(inv.inventory_value),
        accounts_receivable: pf(ar.accounts_receivable),
        total_products:      parseInt(inv.total_products),
        low_stock_alerts:    parseInt(inv.low_stock_count),
      },
    });
  } catch (err) {
    console.error("[SUMMARY]", err);
    res.status(500).json({ message: "Error al obtener resumen financiero" });
  }
};

// ============================================
// 📊 LIBRO MAYOR GENERAL (mantener compatibilidad)
// ============================================
exports.getGeneralLedger = async (req, res) => {
  // Redirigir internamente a getSummary para evitar duplicar lógica
  return exports.getSummary(req, res);
};

// ============================================
// 📈 FLUJO DE CAJA MENSUAL
// ============================================
exports.getCashflow = async (req, res) => {
  try {
    const [rvRows, costRows] = await Promise.all([
      db.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', sale_date),'Mon YY') AS month,
               DATE_TRUNC('month', sale_date)                   AS month_date,
               COALESCE(SUM(total),0)                           AS revenue
        FROM sales
        WHERE payment_status='paid' AND sale_date >= NOW()-INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', sale_date)
        ORDER BY month_date
      `),
      db.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', expense_date),'Mon YY') AS month,
               COALESCE(SUM(amount),0)                              AS costs
        FROM expenses
        WHERE expense_date >= NOW()-INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', expense_date)
        ORDER BY DATE_TRUNC('month', expense_date)
      `),
    ]);

    const map = {};
    rvRows.rows.forEach(r  => { map[r.month] = { month: r.month, revenue: pf(r.revenue), costs: 0 }; });
    costRows.rows.forEach(r => {
      if (map[r.month]) map[r.month].costs = pf(r.costs);
      else map[r.month] = { month: r.month, revenue: 0, costs: pf(r.costs) };
    });

    res.json(
      Object.values(map).map(m => ({
        ...m,
        profit:        m.revenue - m.costs, // ← renombrado de net_cashflow a profit (coincide con SummaryTab)
        net_cashflow:  m.revenue - m.costs,
      }))
    );
  } catch (err) {
    console.error("[CASHFLOW]", err);
    res.status(500).json({ message: "Error al obtener flujo de caja" });
  }
};

// ============================================
// 💰 CUENTAS POR COBRAR (AR)
// ============================================
exports.getAccountsReceivable = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        s.id, s.sale_number, s.sale_date, s.total, s.customer_id,
        u.name  AS customer_name,
        u.email AS customer_email,
        u.phone AS customer_phone,
        EXTRACT(DAY FROM NOW() - s.sale_date) AS days_pending
      FROM sales s
      LEFT JOIN users u ON s.customer_id = u.id
      WHERE s.payment_status = 'pending'
      ORDER BY s.sale_date ASC
    `);

    const summary = await db.query(`
      SELECT
        COALESCE(SUM(total), 0)                                                             AS total_pending,
        COUNT(*)                                                                            AS pending_count,
        COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM NOW()-sale_date) > 30 THEN total ELSE 0 END), 0) AS overdue_30,
        COALESCE(SUM(CASE WHEN EXTRACT(DAY FROM NOW()-sale_date) > 60 THEN total ELSE 0 END), 0) AS overdue_60
      FROM sales WHERE payment_status = 'pending'
    `);

    res.json({ invoices: result.rows, summary: summary.rows[0] });
  } catch (err) {
    console.error("[ACCOUNTS RECEIVABLE]", err);
    res.status(500).json({ message: "Error al obtener cuentas por cobrar" });
  }
};

// ============================================
// 🏦 CUENTAS POR PAGAR / DEUDAS PROVEEDORES
// Expuesto como /finance/provider-debts  ← lo que pide el frontend
// ============================================
exports.getProviderDebts = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        p.id,
        p.name,
        p.category,
        p.balance,
        p.credit_limit,
        p.payment_terms_days,
        p.phone,
        p.email,
        CASE WHEN p.credit_limit > 0
             THEN ROUND((p.balance / p.credit_limit * 100)::numeric, 2)
             ELSE 0 END                                                        AS credit_used_pct,
        (SELECT COUNT(*) FROM purchase_orders po
         WHERE po.provider_id = p.id AND po.payment_status = 'pending')        AS pending_orders
      FROM providers p
      WHERE p.is_active = true AND p.balance > 0
      ORDER BY p.balance DESC
    `);

    const summary = await db.query(`
      SELECT
        COALESCE(SUM(balance), 0)                                              AS total_payable,
        COUNT(*)                                                               AS providers_with_debt,
        COALESCE(SUM(CASE WHEN balance >= credit_limit THEN balance ELSE 0 END), 0) AS over_credit_limit
      FROM providers WHERE is_active = true AND balance > 0
    `);

    res.json({ providers: result.rows, summary: summary.rows[0] });
  } catch (err) {
    console.error("[PROVIDER DEBTS]", err);
    res.status(500).json({ message: "Error al obtener deudas de proveedores" });
  }
};

// Alias para compatibilidad con código anterior
exports.getAccountsPayable = exports.getProviderDebts;

// ============================================
// 💸 GASTOS POR CATEGORÍA
// ============================================
exports.getExpensesByCategory = async (req, res) => {
  const { start_date, end_date } = req.query;
  const params = [];
  let where = "";

  if (start_date && end_date) {
    where = "WHERE expense_date BETWEEN $1 AND $2";
    params.push(start_date, end_date);
  }

  try {
    const result = await db.query(
      `SELECT
         expense_type,
         category,
         COUNT(*)                     AS count,
         COALESCE(SUM(amount), 0)     AS total,
         COALESCE(AVG(amount), 0)     AS average
       FROM expenses ${where}
       GROUP BY expense_type, category
       ORDER BY total DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[EXPENSES BY CATEGORY]", err);
    res.status(500).json({ message: "Error al obtener gastos por categoría" });
  }
};

// ============================================
// 📋 HISTORIAL DE MOVIMIENTOS
// ============================================
exports.getExpenses = async (req, res) => {
  const { limit = 100, offset = 0, type } = req.query;
  const params = [parseInt(limit), parseInt(offset)];
  let where = "";

  if (type) {
    where = "WHERE e.expense_type = $3";
    params.push(type);
  }

  try {
    const result = await db.query(
      `SELECT
         e.*,
         p.name    AS provider_name,
         prod.name AS product_name,
         prod.sku
       FROM expenses e
       LEFT JOIN providers p    ON e.provider_id = p.id
       LEFT JOIN products  prod ON e.product_id  = prod.id
       ${where}
       ORDER BY e.expense_date DESC
       LIMIT $1 OFFSET $2`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[GET EXPENSES]", err);
    res.status(500).json({ error: err.message });
  }
};

// ============================================
// ➕ REGISTRAR GASTO O COMPRA
// ============================================
exports.createExpense = async (req, res) => {
  const {
    expense_type, category, description, amount,
    product_id, quantity, provider_id,
    utility_type, utility_value, payment_method, reference_number,
  } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "El monto debe ser mayor a 0" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO expenses
         (expense_type, category, description, amount, provider_id, product_id, quantity,
          utility_type, utility_value, payment_method, reference_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        expense_type || "other",
        category     || "Sin categoría",
        description  || "Gasto registrado",
        amount,
        provider_id  || null,
        product_id   || null,
        quantity     || 1,
        utility_type || null,
        utility_value || 0,
        payment_method || "cash",
        reference_number || null,
      ]
    );

    if (expense_type === "purchase" && product_id) {
      const unitCost = amount / (quantity || 1);
      let salePrice;
      if (utility_type === "percentage" && utility_value) {
        salePrice = unitCost * (1 + utility_value / 100);
      } else if (utility_type === "fixed" && utility_value) {
        salePrice = unitCost + utility_value;
      }

      if (salePrice) {
        await client.query(
          `UPDATE products SET purchase_price=$1, sale_price=$2, stock=stock+$3, updated_at=NOW() WHERE id=$4`,
          [unitCost, salePrice, quantity, product_id]
        );
      } else {
        await client.query(
          `UPDATE products SET purchase_price=$1, stock=stock+$2, updated_at=NOW() WHERE id=$3`,
          [unitCost, quantity, product_id]
        );
      }
    }

    if (provider_id && payment_method === "credit") {
      await client.query(
        "UPDATE providers SET balance=balance+$1, updated_at=NOW() WHERE id=$2",
        [amount, provider_id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[CREATE EXPENSE]", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
         COALESCE(p.purchase_price, 0)                       AS cost_price,
         COALESCE(p.sale_price, 0)                           AS sale_price,
         COALESCE(p.sale_price - p.purchase_price, 0)        AS unit_profit,
         CASE WHEN COALESCE(p.sale_price,0) > 0
              THEN ROUND(((p.sale_price-p.purchase_price)/p.sale_price*100)::numeric,2)
              ELSE 0 END                                      AS margin_pct,
         COALESCE(s.units_sold, 0)                           AS units_sold,
         COALESCE(s.total_revenue, 0)                        AS total_revenue,
         COALESCE(s.total_profit, 0)                         AS realized_profit,
         p.stock * COALESCE(p.purchase_price, 0)             AS inventory_value
       FROM products p
       LEFT JOIN (
         SELECT product_id,
                SUM(quantity)                         AS units_sold,
                SUM(subtotal)                         AS total_revenue,
                SUM(subtotal - unit_cost*quantity)    AS total_profit
         FROM sale_items GROUP BY product_id
       ) s ON s.product_id = p.id
       WHERE COALESCE(p.purchase_price, 0) > 0
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
// 📊 ESTADO DE RESULTADOS (P&L) DETALLADO
// ============================================
exports.getProfitAndLoss = async (req, res) => {
  const { start_date, end_date } = req.query;
  const params     = start_date && end_date ? [start_date, end_date] : [];
  const dateFilter = params.length ? "AND sale_date BETWEEN $1 AND $2"        : "";
  const expFilter  = params.length ? "WHERE expense_date BETWEEN $1 AND $2"   : "";

  try {
    const [revenueRes, cogsRes, expensesRes] = await Promise.all([
      db.query(
        `SELECT
           COALESCE(SUM(total),0)                         AS gross_revenue,
           COALESCE(SUM(discount_amount),0)               AS discounts,
           COALESCE(SUM(total-discount_amount),0)         AS net_revenue
         FROM sales WHERE payment_status='paid' ${dateFilter}`,
        params
      ),
      db.query(
        `SELECT COALESCE(SUM(si.unit_cost*si.quantity),0) AS cogs
         FROM sale_items si
         JOIN sales s ON s.id=si.sale_id
         WHERE s.payment_status='paid' ${dateFilter}`,
        params
      ),
      db.query(
        `SELECT expense_type, COALESCE(SUM(amount),0) AS total
         FROM expenses ${expFilter}
         GROUP BY expense_type`,
        params
      ),
    ]);

    const revenue    = revenueRes.rows[0];
    const cogs       = pf(cogsRes.rows[0].cogs);
    const netRevenue = pf(revenue.net_revenue);
    const grossProfit = netRevenue - cogs;

    const expenses    = {};
    let totalExpenses = 0;
    expensesRes.rows.forEach(row => {
      expenses[row.expense_type] = pf(row.total);
      if (row.expense_type !== "purchase") totalExpenses += pf(row.total);
    });

    const netProfit = grossProfit - totalExpenses;

    res.json({
      revenue: { gross: pf(revenue.gross_revenue), discounts: pf(revenue.discounts), net: netRevenue },
      cogs,
      gross_profit:      grossProfit,
      gross_margin_pct:  netRevenue > 0 ? +((grossProfit / netRevenue) * 100).toFixed(2) : 0,
      operating_expenses: { ...expenses, total: totalExpenses },
      net_profit:        netProfit,
      net_margin_pct:    netRevenue > 0 ? +((netProfit  / netRevenue) * 100).toFixed(2) : 0,
    });
  } catch (err) {
    console.error("[P&L STATEMENT]", err);
    res.status(500).json({ message: "Error al obtener estado de resultados" });
  }
};

// ============================================
// 📊 ANÁLISIS DE PROVEEDORES
// ============================================
exports.getProviderAnalysis = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        pr.name     AS provider_name,
        pr.category,
        pr.balance  AS current_debt,
        COUNT(e.id)                  AS purchase_count,
        COALESCE(SUM(e.amount), 0)   AS total_spent,
        COALESCE(AVG(e.amount), 0)   AS avg_purchase
      FROM providers pr
      LEFT JOIN expenses e ON e.provider_id = pr.id AND e.expense_type = 'purchase'
      WHERE pr.is_active = true
      GROUP BY pr.id, pr.name, pr.category, pr.balance
      HAVING COUNT(e.id) > 0
      ORDER BY total_spent DESC
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("[PROVIDER ANALYSIS]", err);
    res.status(500).json({ message: "Error al analizar proveedores" });
  }
};

// ============================================
// 💳 REGISTRAR PAGO A PROVEEDOR
// ============================================
exports.registerPayment = async (req, res) => {
  const { provider_id, amount, payment_method } = req.body;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO provider_payments (provider_id, amount, payment_method) VALUES ($1,$2,$3)",
      [provider_id, amount, payment_method]
    );
    await client.query(
      "UPDATE providers SET balance = balance - $1 WHERE id = $2",
      [amount, provider_id]
    );
    await client.query("COMMIT");
    res.json({ success: true, message: "Pago registrado y deuda actualizada" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

module.exports = exports;
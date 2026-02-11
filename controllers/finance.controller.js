const db = require("../config/db");

const pf = (v) => parseFloat(v) || 0;

// ============================================
// 📊 RESUMEN GENERAL P&L (Dashboard Principal)
// ============================================
exports.getSummary = async (req, res) => {
  const { start_date, end_date } = req.query;
  const dp = start_date && end_date ? [start_date, end_date] : [];
  const sf = dp.length ? "AND s.created_at BETWEEN $1 AND $2" : "";
  const ef = dp.length ? "WHERE created_at BETWEEN $1 AND $2" : "";

  try {
    const [rvRes, exRes, debtRes] = await Promise.all([
      // Ingresos y COGS
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
      // Gastos operativos y compras
      db.query(
        `SELECT
            COALESCE(SUM(CASE WHEN expense_type IN ('service', 'utility', 'tax', 'salary', 'other') 
                            THEN amount ELSE 0 END), 0) AS operating_expenses,
            COALESCE(SUM(CASE WHEN expense_type = 'purchase' 
                            THEN amount ELSE 0 END), 0) AS purchase_expenses,
            COUNT(DISTINCT CASE WHEN expense_type = 'purchase' THEN id END) AS total_purchases
        FROM expenses ${ef}`,
        dp
      ),
      // Deudas con proveedores
      db.query("SELECT COALESCE(SUM(balance),0) AS provider_debt FROM providers WHERE is_active = true"),
    ]);

    const rv = rvRes.rows[0];
    const ex = exRes.rows[0];

    const totalRevenue      = pf(rv.total_revenue);
    const cogs              = pf(rv.cogs);
    const grossProfit       = pf(rv.gross_profit);
    const operatingExpenses = pf(ex.operating_expenses);
    const netProfit         = grossProfit - operatingExpenses;
    const grossMargin       = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const netMargin         = totalRevenue > 0 ? (netProfit  / totalRevenue) * 100 : 0;

    res.json({
      revenue: {
        total: totalRevenue,
        cogs,
        gross_profit: grossProfit,
        gross_margin_pct: +grossMargin.toFixed(2),
        total_sales: parseInt(rv.total_sales),
        unique_customers: parseInt(rv.unique_customers),
      },
      expenses: {
        operating: operatingExpenses,
        purchases: pf(ex.purchase_expenses),
        total_purchases: parseInt(ex.total_purchases || 0),
      },
      profitability: {
        gross_profit: grossProfit,
        net_profit: netProfit,
        gross_margin_pct: +grossMargin.toFixed(2),
        net_margin_pct: +netMargin.toFixed(2),
      },
      debt: {
        provider_total: pf(debtRes.rows[0].provider_debt)
      },
    });
  } catch (err) {
    console.error("[FINANCE SUMMARY]", err);
    res.status(500).json({ message: "Error al obtener resumen financiero" });
  }
};

// ============================================
// 📈 FLUJO DE CAJA MENSUAL (últimos 6 meses)
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
// 💰 GASTOS POR CATEGORÍA (Para gráficas)
// ============================================
exports.getExpensesByCategory = async (req, res) => {
  const { start_date, end_date } = req.query;
  const params = [];
  let where = "";
  
  if (start_date && end_date) {
    where = "WHERE created_at BETWEEN $1 AND $2";
    params.push(start_date, end_date);
  }
  
  try {
    const result = await db.query(
      `SELECT 
         category,
         COUNT(*) AS count,
         COALESCE(SUM(amount), 0) AS total,
         COALESCE(AVG(amount), 0) AS average
       FROM expenses ${where}
       GROUP BY category 
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
// 📋 HISTORIAL DE MOVIMIENTOS (Gastos + Compras)
// ============================================
exports.getExpenses = async (req, res) => {
  const { limit = 100, offset = 0, type } = req.query;
  const params = [limit, offset];
  let where = "";
  
  if (type) {
    where = "WHERE e.expense_type = $3";
    params.push(type);
  }
  
  try {
    const result = await db.query(
      `SELECT 
         e.*,
         p.name as provider_name,
         prod.name as product_name,
         prod.sku
       FROM expenses e
       LEFT JOIN providers p ON e.provider_id = p.id
       LEFT JOIN products prod ON e.product_id = prod.id
       ${where}
       ORDER BY e.created_at DESC
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
    expense_type,
    category, 
    description,
    amount, 
    product_id, 
    quantity, 
    provider_id, 
    utility_type, 
    utility_value,
    payment_method,
    reference_number
  } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "El monto debe ser mayor a 0" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Registrar el gasto/compra
    const result = await client.query(
      `INSERT INTO expenses 
       (expense_type, category, description, amount, provider_id, product_id, quantity, 
        utility_type, utility_value, payment_method, reference_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
       RETURNING *`,
      [
        expense_type || 'other',
        category || 'Sin categoría',
        description || 'Gasto registrado',
        amount, 
        provider_id || null, 
        product_id || null, 
        quantity || 1, 
        utility_type || null, 
        utility_value || 0,
        payment_method || 'cash',
        reference_number || null
      ]
    );

    // 2. Si es compra, actualizar producto
    if (expense_type === 'purchase' && product_id) {
      const unitCost = amount / (quantity || 1);
      
      // Calcular precio de venta según markup
      let salePrice;
      if (utility_type === 'percentage') {
        salePrice = unitCost * (1 + utility_value / 100);
      } else if (utility_type === 'fixed') {
        salePrice = unitCost + utility_value;
      }

      if (salePrice) {
        await client.query(
          `UPDATE products SET 
            purchase_price = $1,
            sale_price = $2,
            stock = stock + $3,
            updated_at = NOW()
           WHERE id = $4`,
          [unitCost, salePrice, quantity, product_id]
        );
      } else {
        await client.query(
          `UPDATE products SET 
            purchase_price = $1,
            stock = stock + $2,
            updated_at = NOW()
           WHERE id = $3`,
          [unitCost, quantity, product_id]
        );
      }
    }

    // 3. Si es a crédito, actualizar balance del proveedor
    if (provider_id && payment_method === 'credit') {
      await client.query(
        "UPDATE providers SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
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
         COALESCE(p.purchase_price,0)                                                   AS cost_price,
         COALESCE(p.sale_price,0)                                                       AS sale_price,
         COALESCE(p.sale_price - p.purchase_price,0)                                   AS unit_profit,
         CASE WHEN COALESCE(p.sale_price,0)>0
              THEN ROUND(((p.sale_price - p.purchase_price)/p.sale_price*100)::numeric,2)
              ELSE 0 END                                                                 AS margin_pct,
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
             ELSE 0 END AS credit_used_pct
      FROM providers p
      WHERE p.is_active=true AND p.balance > 0
      ORDER BY p.balance DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("[PROVIDER DEBTS]", err);
    res.status(500).json({ message: "Error al obtener deudas" });
  }
};

// ============================================
// 📊 ANÁLISIS DE PROVEEDORES (Para gráficas)
// ============================================
exports.getProviderAnalysis = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        pr.name as provider_name,
        COUNT(e.id) as purchase_count,
        COALESCE(SUM(e.amount), 0) as total_spent,
        COALESCE(AVG(e.amount), 0) as avg_purchase
      FROM providers pr
      LEFT JOIN expenses e ON e.provider_id = pr.id AND e.expense_type = 'purchase'
      WHERE pr.is_active = true
      GROUP BY pr.id, pr.name
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

module.exports = exports;
const db = require("../config/db");

/* =========================
   OBTENER TODOS LOS GASTOS
========================= */
exports.getExpenses = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.*, p.name as provider_name 
       FROM expenses e
       LEFT JOIN providers p ON e.provider_id = p.id
       ORDER BY e.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[GET EXPENSES ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

/* =========================
   CREAR GASTO / COMPRA
========================= */
exports.createExpense = async (req, res) => {
  const { 
    expense_type,  // ✅ CORREGIDO: era 'type'
    category, 
    description,   // ✅ AÑADIDO: es campo obligatorio
    amount, 
    product_id, 
    quantity, 
    provider_id, 
    utility_type, 
    utility_value,
    payment_method,
    reference_number
  } = req.body;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Insertar el registro de gasto/compra
    const result = await client.query(
      `INSERT INTO expenses 
       (expense_type, category, description, amount, provider_id, product_id, quantity, 
        utility_type, utility_value, payment_method, reference_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
       RETURNING *`,
      [
        expense_type, 
        category, 
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

    // 2. Si es una compra (purchase), actualizar producto
    if (expense_type === 'purchase' && product_id) {
      const unitCost = amount / (quantity || 1);

      await client.query(
        `UPDATE products SET 
          purchase_price = $1,
          markup_type = $2,
          markup_value = $3,
          stock = stock + $4,
          sale_price = CASE 
            WHEN $2 = 'percentage' THEN ROUND(($1 * (1 + $3 / 100))::numeric, 2)
            WHEN $2 = 'fixed' THEN $1 + $3
            ELSE sale_price 
          END,
          updated_at = NOW()
         WHERE id = $5`,
        [unitCost, utility_type, utility_value, quantity, product_id]
      );
    }

    // 3. Si es a crédito, actualizar balance del proveedor
    if (provider_id && payment_method === 'credit') {
      await client.query(
        "UPDATE providers SET balance = balance + $1, updated_at = NOW() WHERE id = $2",
        [amount, provider_id]
      );
    }

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[CREATE EXPENSE ERROR]", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
};

/* =========================
   RESUMEN FINANCIERO
========================= */
exports.getFinanceSummary = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN expense_type IN ('service', 'utility', 'tax', 'salary', 'other') 
                          THEN amount ELSE 0 END), 0) AS "totalGastos",
        COALESCE(SUM(CASE WHEN expense_type = 'purchase' 
                          THEN amount ELSE 0 END), 0) AS "totalCompras",
        (SELECT COALESCE(SUM(balance), 0) FROM providers WHERE is_active = true) AS "deudaTotal"
      FROM expenses
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("[FINANCE SUMMARY ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};
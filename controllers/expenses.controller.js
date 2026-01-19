import db from "../config/db.js";

/* =========================
   OBTENER TODOS LOS GASTOS
========================= */
export const getExpenses = async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM expenses ORDER BY created_at DESC"
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/* =========================
   CREAR GASTO / COMPRA
========================= */
export const createExpense = async (req, res) => {
  const { type, category, description, amount } = req.body;

  if (!type || !category || !amount) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  try {
    const { rows } = await db.query(
      `
      INSERT INTO expenses (type, category, description, amount)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [type, category, description, amount]
    );

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/* =========================
   RESUMEN FINANCIERO
========================= */
export const getFinanceSummary = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'gasto' THEN amount ELSE 0 END), 0) AS totalGastos,
        COALESCE(SUM(CASE WHEN type = 'compra' THEN amount ELSE 0 END), 0) AS totalCompras
      FROM expenses
    `);

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

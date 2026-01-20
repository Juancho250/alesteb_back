import db from "../config/db.js";

/* =========================
   OBTENER TODOS LOS GASTOS
========================= */
export const getExpenses = async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM public.expenses ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
    const result = await db.query(
      `
      INSERT INTO public.expenses (type, category, description, amount)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [type, category, description, amount]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

/* =========================
   RESUMEN FINANCIERO
========================= */
export const getFinanceSummary = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'gasto' THEN amount END), 0) AS "totalGastos",
        COALESCE(SUM(CASE WHEN type = 'compra' THEN amount END), 0) AS "totalCompras"
      FROM public.expenses
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

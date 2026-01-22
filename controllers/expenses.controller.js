const db = require("../config/db");


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
// En tu controlador de gastos (backend)
export const createExpense = async (req, res) => {
  // Añadimos product_id al body
  const { type, category, description, amount, product_id, quantity } = req.body;

  if (!type || !category || !amount) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Insertar el registro en la tabla de gastos
    const result = await client.query(
      `INSERT INTO public.expenses (type, category, description, amount)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [type, category, description, amount]
    );

    // 2. SI ES COMPRA Y HAY PRODUCTO, SUMAR STOCK
    if (type === 'compra' && product_id && quantity) {
      const stockUpdate = await client.query(
        `UPDATE products 
         SET stock = stock + $1 
         WHERE id = $2`,
        [quantity, product_id]
      );

      if (stockUpdate.rowCount === 0) {
        throw new Error("El producto seleccionado no existe para actualizar stock");
      }
    }

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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

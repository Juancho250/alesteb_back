const db = require("../config/db");

/* =========================
   OBTENER TODOS LOS GASTOS
========================= */
exports.getExpenses = async (req, res) => {
  try {
    // Agregamos un LEFT JOIN para ver el nombre del proveedor en el listado
    const result = await db.query(
      `SELECT e.*, p.name as provider_name 
       FROM public.expenses e
       LEFT JOIN providers p ON e.provider_id = p.id
       ORDER BY e.created_at DESC`
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
exports.createExpense = async (req, res) => {
  // Añadimos provider_id a la desestructuración
  const { type, category, description, amount, product_id, quantity, provider_id } = req.body;

  if (!type || !category || !amount) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    // 1. Insertar el registro (incluyendo provider_id si existe)
    const result = await client.query(
      `INSERT INTO public.expenses (type, category, description, amount, provider_id, product_id, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [type, category, description, amount, provider_id, product_id, quantity]
    );

    // 2. SI ES COMPRA Y HAY PRODUCTO, SUMAR STOCK
    if (type === 'compra' && product_id && quantity) {
      const stockUpdate = await client.query(
        `UPDATE products SET stock = stock + $1 WHERE id = $2`,
        [quantity, product_id]
      );
      if (stockUpdate.rowCount === 0) throw new Error("Producto no encontrado");
    }

    // 3. NUEVO: SI HAY PROVEEDOR, ACTUALIZAR SU SALDO PENDIENTE
    if (type === 'compra' && provider_id) {
      const providerUpdate = await client.query(
        `UPDATE providers SET balance = balance + $1 WHERE id = $2`,
        [amount, provider_id]
      );
      if (providerUpdate.rowCount === 0) throw new Error("Proveedor no encontrado");
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
   RESUMEN FINANCIERO (CON DEUDA)
========================= */
// Resumen financiero de compras, gastos y rentabilidad
exports.getFinanceSummary = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'gasto' THEN amount END), 0) AS "totalGastos",
        COALESCE(SUM(CASE WHEN type = 'compra' THEN amount END), 0) AS "totalCompras",
        (SELECT COALESCE(SUM(balance), 0) FROM providers) AS "deudaTotal"
      FROM public.expenses
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

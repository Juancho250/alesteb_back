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
/* =========================
   CREAR GASTO / COMPRA (MEJORADO)
========================= */
exports.createExpense = async (req, res) => {
  const { 
    type, category, amount, product_id, quantity, 
    provider_id, utility_type, utility_value 
  } = req.body;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Insertar el registro de gasto/compra con su configuración de utilidad
    const result = await client.query(
      `INSERT INTO public.expenses 
       (type, category, amount, provider_id, product_id, quantity, utility_type, utility_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [type, category, amount, provider_id, product_id, quantity, utility_type, utility_value]
    );

    if (type === 'compra' && product_id) {
      const unitCost = amount / (quantity || 1);

      // 2. ACTUALIZAR EL PRODUCTO: Costo y Precio de Venta sugerido
      await client.query(
        `UPDATE products SET 
          purchase_price = $1,
          markup_type = $2,
          markup_value = $3,
          stock = stock + $4,
          price = CASE 
            WHEN $2 = 'percentage' THEN ROUND(($1 * (1 + $3 / 100))::numeric, 2)
            WHEN $2 = 'fixed' THEN $1 + $3
            ELSE price 
          END
         WHERE id = $5`,
        [unitCost, utility_type, utility_value, quantity, product_id]
      );
    }

    // ... (resto de tu lógica de balance del proveedor)
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
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

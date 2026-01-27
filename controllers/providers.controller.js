const db = require("../config/db");

/* =========================
   OBTENER TODOS
========================= */
exports.getProviders = async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM public.providers ORDER BY name ASC");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   CREAR PROVEEDOR
========================= */
exports.createProvider = async (req, res) => {
  const { name, category, phone, email, address } = req.body;
  try {
    const result = await db.query(
      `INSERT INTO public.providers (name, category, phone, email, address, balance) 
       VALUES ($1, $2, $3, $4, $5, 0) RETURNING *`,
      [name, category, phone, email, address]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/* ==========================================
   HISTORIAL DE COMPRAS DEL PROVEEDOR
========================================== */
exports.getProviderHistory = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT e.*, p.name as product_name 
       FROM public.expenses e
       LEFT JOIN products p ON e.product_id = p.id
       WHERE e.provider_id = $1 
       ORDER BY e.created_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error al obtener historial" });
  }
};

/* ==========================================
   HISTORIAL DE PRECIOS POR PRODUCTO
========================================== */
exports.getProductPriceHistory = async (req, res) => {
  const { provider_id, product_id } = req.params;
  try {
    const result = await db.query(
      `SELECT amount, quantity, (amount / NULLIF(quantity, 0)) as unit_price, created_at 
       FROM public.expenses 
       WHERE provider_id = $1 AND product_id = $2 AND type = 'compra'
       ORDER BY created_at DESC LIMIT 5`,
      [provider_id, product_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error al obtener historial de precios" });
  }
};
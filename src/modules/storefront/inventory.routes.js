"use strict";

const db = require("../../platform/database");

const {
  requireApiPermission,
} = require("../identity/auth");

async function getInventory(req, res) {
  try {
    const adminId = req.apiKey.adminId;
    const { low_stock } = req.query;

    let where = "WHERE p.is_active = true AND p.owner_admin_id = $1";
    if (low_stock === "true") where += " AND p.stock <= p.min_stock";

    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku,
         p.stock, p.min_stock, p.max_stock,
         -- Vocabulario resumido de este endpoint de inventario: out | low | normal.
         -- No confundir con el catálogo público ni con v_stock_disponible.
         CASE
           WHEN p.stock <= 0           THEN 'out'
           WHEN p.stock <= p.min_stock THEN 'low'
           ELSE 'normal'
         END AS stock_status,
         c.name AS category
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}
       ORDER BY p.stock ASC`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /inventory", error);
    res.status(500).json({ success: false, message: "Error al obtener inventario" });
  }
}

async function getInventoryAvailability(req, res) {
  try {
    const adminId   = req.apiKey.adminId;
    const productId = Number(req.query.productId);
    const variantId = req.query.variantId ? Number(req.query.variantId) : null;
    if (!productId) return res.status(400).json({ success: false, message: "productId requerido" });

    const conditions = variantId
      ? ["product_id = $1", "variant_id = $2", "owner_admin_id = $3"]
      : ["product_id = $1", "variant_id IS NULL", "owner_admin_id = $2"];
    const params = variantId ? [productId, variantId, adminId] : [productId, adminId];

    const { rows } = await db.query(
      `SELECT disponible_inmediato, min_stock, safety_stock, fulfillment_mode
       FROM v_stock_disponible WHERE ${conditions.join(" AND ")} LIMIT 1`,
      params
    );
    const row = rows[0] ?? null;
    res.json({ success: true, data: row });
  } catch (err) {
    console.error("[PUBLIC API] GET /inventory/availability", err);
    res.status(500).json({ success: false, message: "Error al verificar disponibilidad" });
  }
}

function registerInventoryListRoute(router) {
  if (!router || typeof router.get !== "function") {
    throw new TypeError(
      "registerInventoryListRoute requiere un router Express válido"
    );
  }

  router.get(
    "/inventory",
    requireApiPermission("inventory:read"),
    getInventory
  );
}

function registerInventoryAvailabilityRoute(router) {
  if (!router || typeof router.get !== "function") {
    throw new TypeError(
      "registerInventoryAvailabilityRoute requiere un router Express válido"
    );
  }

  router.get(
    "/inventory/availability",
    requireApiPermission("products:read"),
    getInventoryAvailability
  );
}

module.exports = Object.freeze({
  registerInventoryListRoute,
  registerInventoryAvailabilityRoute,
  getInventory,
  getInventoryAvailability,
});


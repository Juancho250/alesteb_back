// routes/public-api.routes.js
// Rutas consumibles desde sitios externos via API Key (header X-API-Key).
// NO usan JWT — la autenticación es por API Key del admin.
// Prefijo registrado en app.js: /public-api/v1
const express  = require("express");
const router   = express.Router();
const db       = require("../config/db");
const {
  apiKeyAuth,
  requireApiPermission,
} = require("../middleware/auth.middleware");

// ─── Auth: todas las rutas requieren API Key válida ─────────────────────────
router.use(apiKeyAuth);

// ─── CORS dinámico según whitelist de la key ─────────────────────────────────
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin",  origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
// GET /public-api/v1/ping
router.get("/ping", (req, res) => {
  res.json({
    success:     true,
    message:     "API Key válida y activa",
    api_key:     req.apiKey.name,
    permissions: req.apiKey.permissions,
    timestamp:   new Date().toISOString(),
  });
});

// ─── Productos ────────────────────────────────────────────────────────────────
// GET /public-api/v1/products
router.get("/products", requireApiPermission("products:read"), async (req, res) => {
  try {
    const { category, search, page = 1, limit = 20 } = req.query;
    const safeLimit  = Math.min(parseInt(limit) || 20, 100);
    const offset     = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    let where  = "WHERE p.is_active = true";
    const params = [];

    if (category) {
      params.push(category);
      where += ` AND c.slug = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }

    params.push(safeLimit, offset);

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT
           p.id, p.name, p.sku, p.description, p.sale_price AS price,
           p.stock, p.stock_status,
           c.name AS category, c.slug AS category_slug,
           p.main_image
         FROM v_products_full p
         LEFT JOIN categories c ON c.id = p.category_id
         ${where}
         ORDER BY p.name
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)
         FROM v_products_full p
         LEFT JOIN categories c ON c.id = p.category_id
         ${where}`,
        params.slice(0, -2)
      ),
    ]);

    const total = parseInt(countRow.rows[0].count);

    return res.json({
      success: true,
      data:    rows.rows,
      meta:    { total, page: parseInt(page), limit: safeLimit, pages: Math.ceil(total / safeLimit) },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /products", error);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
});

// GET /public-api/v1/products/:id
router.get("/products/:id", requireApiPermission("products:read"), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku, p.description, p.sale_price AS price,
         p.stock, p.stock_status,
         c.name AS category, c.slug AS category_slug,
         p.main_image,
         json_agg(
           DISTINCT jsonb_build_object('url', pi.url, 'is_main', pi.is_main)
         ) FILTER (WHERE pi.id IS NOT NULL) AS images
       FROM v_products_full p
       LEFT JOIN categories c       ON c.id = p.category_id
       LEFT JOIN product_images pi  ON pi.product_id = p.id
       WHERE p.id = $1 AND p.is_active = true
       GROUP BY p.id, p.name, p.sku, p.description, p.sale_price,
                p.stock, p.stock_status, c.name, c.slug, p.main_image`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("[PUBLIC API] GET /products/:id", error);
    res.status(500).json({ success: false, message: "Error al obtener producto" });
  }
});

// ─── Categorías ───────────────────────────────────────────────────────────────
// GET /public-api/v1/categories
router.get("/categories", requireApiPermission("categories:read"), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         c.id, c.name, c.slug, c.description, c.image_url,
         COUNT(p.id) FILTER (WHERE p.is_active = true)::int AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id
       WHERE c.is_active = true
       GROUP BY c.id
       ORDER BY c.name`
    );
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /categories", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
});

// ─── Crear venta externa ──────────────────────────────────────────────────────
// POST /public-api/v1/sales
router.post("/sales", requireApiPermission("sales:write"), async (req, res) => {
  const client = await db.connect();
  try {
    const {
      items,
      customer_name,
      customer_phone,
      shipping_address,
      payment_method = "transfer",
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Se requiere al menos un item",
        code: "MISSING_ITEMS",
      });
    }

    await client.query("BEGIN");

    let subtotal   = 0;
    const saleItems = [];

    for (const item of items) {
      const productRes = await client.query(
        "SELECT id, name, sale_price, stock, purchase_price FROM products WHERE id = $1 AND is_active = true",
        [item.product_id]
      );

      if (productRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Producto ID ${item.product_id} no encontrado`,
          code: "PRODUCT_NOT_FOUND",
        });
      }

      const product = productRes.rows[0];

      if (product.stock < item.quantity) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Stock insuficiente para "${product.name}". Disponible: ${product.stock}`,
          code: "INSUFFICIENT_STOCK",
        });
      }

      const itemSubtotal = product.sale_price * item.quantity;
      subtotal += itemSubtotal;

      saleItems.push({
        product_id:   product.id,
        quantity:     item.quantity,
        unit_price:   product.sale_price,
        unit_cost:    product.purchase_price,
        subtotal:     itemSubtotal,
        profit_unit:  product.sale_price - product.purchase_price,
        total_profit: (product.sale_price - product.purchase_price) * item.quantity,
      });
    }

    const saleNumber = `WEB-${req.apiKey.adminId}-${Date.now()}`;

    const saleRes = await client.query(
      `INSERT INTO sales
         (sale_number, subtotal, total, payment_method, payment_status,
          sale_type, shipping_address, customer_phone, created_by)
       VALUES ($1, $2, $2, $3, 'pending', 'web', $4, $5, $6)
       RETURNING id, sale_number, total`,
      [
        saleNumber,
        subtotal,
        payment_method,
        shipping_address  || null,
        customer_phone    || null,
        req.apiKey.adminId,
      ]
    );

    const saleId = saleRes.rows[0].id;

    for (const item of saleItems) {
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, quantity, unit_price, unit_cost,
            subtotal, profit_per_unit, total_profit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          saleId, item.product_id, item.quantity,
          item.unit_price, item.unit_cost, item.subtotal,
          item.profit_unit, item.total_profit,
        ]
      );

      await client.query(
        "UPDATE products SET stock = stock - $1 WHERE id = $2",
        [item.quantity, item.product_id]
      );
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Venta registrada correctamente",
      data: {
        sale_id:     saleId,
        sale_number: saleRes.rows[0].sale_number,
        total:       saleRes.rows[0].total,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[PUBLIC API] POST /sales", error);
    res.status(500).json({ success: false, message: "Error al registrar la venta" });
  } finally {
    client.release();
  }
});

module.exports = router;
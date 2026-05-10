// ============================================================
// routes/superadmin.routes.js
// Solo accesible por el rol "superadmin"
// ============================================================
const express             = require("express");
const router              = express.Router();
const superadminCtrl      = require("../controllers/superadmin.controller");
const { auth, requireSuperAdmin } = require("../middleware/auth.middleware");

// Todas las rutas requieren auth + rol superadmin
router.use(auth, requireSuperAdmin);

// Dashboard del sistema
router.get("/stats", superadminCtrl.getSystemStats);

// CRUD de admins
router.get   ("/admins",             superadminCtrl.getAdmins);
router.post  ("/admins",             superadminCtrl.createAdmin);
router.put   ("/admins/:id",         superadminCtrl.updateAdmin);
router.patch ("/admins/:id/toggle",  superadminCtrl.toggleAdminStatus);
router.delete("/admins/:id",         superadminCtrl.deleteAdmin);

module.exports = router;


// ============================================================
// routes/apikeys.routes.js
// Admin gestiona sus propias API keys
// ============================================================
const express2         = require("express");
const router2          = express2.Router();
const apiKeysCtrl      = require("../controllers/apikeys.controller");
const { auth: auth2, requireAdmin } = require("../middleware/auth.middleware");

// Todas las rutas requieren estar autenticado como admin (o superadmin)
router2.use(auth2, requireAdmin);

// Permisos disponibles (para poblar el formulario en el frontend)
router2.get("/permissions",         apiKeysCtrl.getAvailablePermissions);

// CRUD de API keys propias
router2.get   ("/",              apiKeysCtrl.getApiKeys);
router2.post  ("/",              apiKeysCtrl.createApiKey);
router2.put   ("/:id",           apiKeysCtrl.updateApiKey);
router2.patch ("/:id/toggle",    apiKeysCtrl.toggleApiKey);
router2.post  ("/:id/rotate",    apiKeysCtrl.rotateApiKey);
router2.delete("/:id",           apiKeysCtrl.deleteApiKey);
router2.get   ("/:id/logs",      apiKeysCtrl.getApiKeyLogs);

module.exports = router2;


// ============================================================
// routes/public-api.routes.js
// Rutas consumibles desde sitios externos via API Key
// Prefijo sugerido: /public-api/v1/...
// ============================================================
const express3    = require("express");
const router3     = express3.Router();
const db          = require("../config/db");
const {
  apiKeyAuth,
  requireApiPermission,
} = require("../middleware/auth.middleware");

// Todas las rutas de esta sección requieren API Key válida
router3.use(apiKeyAuth);

// CORS dinámico según la key (permitir orígenes de la whitelist)
router3.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ----------------------------------------------------------
// 📦 PRODUCTOS (requiere permiso products:read)
// ----------------------------------------------------------
router3.get("/products", requireApiPermission("products:read"), async (req, res) => {
  try {
    const { category, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);

    let where = "WHERE p.is_active = true";
    const params = [];

    if (category) {
      params.push(category);
      where += ` AND c.slug = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }

    params.push(Math.min(parseInt(limit), 100), offset);

    const result = await db.query(
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
    );

    // Total para paginación
    const countResult = await db.query(
      `SELECT COUNT(*) FROM v_products_full p
       LEFT JOIN categories c ON c.id = p.category_id
       ${where}`,
      params.slice(0, -2)
    );

    return res.json({
      success: true,
      data:    result.rows,
      meta: {
        total:    parseInt(countResult.rows[0].count),
        page:     parseInt(page),
        limit:    Math.min(parseInt(limit), 100),
        pages:    Math.ceil(parseInt(countResult.rows[0].count) / Math.min(parseInt(limit), 100)),
      },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET PRODUCTS ERROR", error);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
});

router3.get("/products/:id", requireApiPermission("products:read"), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku, p.description, p.sale_price AS price,
         p.stock, p.stock_status, p.purchase_price,
         c.name AS category, c.slug AS category_slug,
         p.main_image,
         json_agg(DISTINCT jsonb_build_object('url', pi.url, 'is_main', pi.is_main))
           FILTER (WHERE pi.id IS NOT NULL) AS images
       FROM v_products_full p
       LEFT JOIN categories c  ON c.id = p.category_id
       LEFT JOIN product_images pi ON pi.product_id = p.id
       WHERE p.id = $1 AND p.is_active = true
       GROUP BY p.id, p.name, p.sku, p.description, p.sale_price, p.stock,
                p.stock_status, p.purchase_price, c.name, c.slug, p.main_image`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("[PUBLIC API] GET PRODUCT ERROR", error);
    res.status(500).json({ success: false, message: "Error al obtener producto" });
  }
});

// ----------------------------------------------------------
// 🗂️ CATEGORÍAS (requiere permiso categories:read)
// ----------------------------------------------------------
router3.get("/categories", requireApiPermission("categories:read"), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, slug, description, image_url,
              (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_active = true) AS product_count
       FROM categories c
       WHERE c.is_active = true
       ORDER BY c.name`
    );
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET CATEGORIES ERROR", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
});

// ----------------------------------------------------------
// 🛍️ CREAR VENTA EXTERNA (requiere permiso sales:write)
// ----------------------------------------------------------
router3.post("/sales", requireApiPermission("sales:write"), async (req, res) => {
  const client = await db.connect();
  try {
    const { items, customer_name, customer_phone, shipping_address, payment_method = "transfer" } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Se requieren items", code: "MISSING_ITEMS" });
    }

    await client.query("BEGIN");

    let subtotal = 0;
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
        product_id:    product.id,
        quantity:      item.quantity,
        unit_price:    product.sale_price,
        unit_cost:     product.purchase_price,
        subtotal:      itemSubtotal,
        profit_unit:   product.sale_price - product.purchase_price,
        total_profit:  (product.sale_price - product.purchase_price) * item.quantity,
      });
    }

    // Número de venta
    const saleNumber = `WEB-API-${Date.now()}`;

    const saleRes = await client.query(
      `INSERT INTO sales
         (sale_number, subtotal, total, payment_method, payment_status, sale_type,
          shipping_address, customer_phone, created_by)
       VALUES ($1, $2, $2, $3, 'pending', 'web', $4, $5, $6)
       RETURNING id, sale_number, total`,
      [
        saleNumber,
        subtotal,
        payment_method,
        shipping_address || null,
        customer_phone || null,
        req.apiKey.adminId, // registrada a nombre del admin dueño de la key
      ]
    );

    const saleId = saleRes.rows[0].id;

    for (const item of saleItems) {
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, quantity, unit_price, unit_cost, subtotal, profit_per_unit, total_profit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [saleId, item.product_id, item.quantity, item.unit_price, item.unit_cost,
         item.subtotal, item.profit_unit, item.total_profit]
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
    console.error("[PUBLIC API] CREATE SALE ERROR", error);
    res.status(500).json({ success: false, message: "Error al registrar la venta" });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------
// ✅ Health check público de la API key
// ----------------------------------------------------------
router3.get("/ping", (req, res) => {
  res.json({
    success:     true,
    message:     "API Key válida y activa",
    api_key:     req.apiKey.name,
    permissions: req.apiKey.permissions,
    timestamp:   new Date().toISOString(),
  });
});

module.exports = router3;
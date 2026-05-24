// routes/public-api.routes.js
const express        = require("express");
const router         = express.Router();
const db             = require("../config/db");
const {
  apiKeyAuth,
  requireApiPermission,
  auth,
  checkRateLimit,
} = require("../middleware/auth.middleware");
const storefrontAuth  = require("../controllers/storefront.auth.controller");
const reviewsCtrl     = require("../controllers/reviews.controller");
const { createUpload } = require("../middleware/upload.middleware");

router.use(apiKeyAuth);

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/profile
// ─────────────────────────────────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         ap.business_name,
         ap.tagline,
         ap.description,
         ap.logo_url,
         ap.favicon_url,
         ap.primary_color,
         ap.secondary_color,
         ap.accent_color,
         ap.business_email,
         ap.business_phone,
         ap.website,
         ap.address,
         ap.city,
         ap.department,
         ap.country,
         ap.currency,
         ap.social_links
       FROM admin_profiles ap
       WHERE ap.user_id = $1`,
      [adminId]
    );

    return res.json({
      success: true,
      data:    result.rows[0] ?? null,
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /profile", error);
    res.status(500).json({ success: false, message: "Error al obtener el perfil del negocio" });
  }
});

// GET /public-api/v1/products
router.get("/products", requireApiPermission("products:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const { category, search, page = 1, limit = 20, sort = "name" } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 100);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where = "WHERE p.is_active = true AND p.owner_admin_id = $1";

    if (category) {
      params.push(category);
      where += ` AND c.slug = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }

    const orderMap = {
      name:       "p.name ASC",
      price_asc:  "p.sale_price ASC",
      price_desc: "p.sale_price DESC",
      newest:     "p.created_at DESC",
    };
    const orderBy = orderMap[sort] || "p.name ASC";

    params.push(safeLimit, offset);

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT
           p.id, p.name, p.sku, p.description,
           p.sale_price AS price,
           p.stock,
           p.has_variants,
           CASE
             WHEN p.stock <= 0           THEN 'out'
             WHEN p.stock <= p.min_stock THEN 'low'
             ELSE 'normal'
           END AS stock_status,
           c.name AS category, c.slug AS category_slug,
           (SELECT url FROM product_images
            WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
           COALESCE(
             json_agg(
               DISTINCT jsonb_build_object('url', pi.url, 'is_main', pi.is_main)
             ) FILTER (WHERE pi.id IS NOT NULL), '[]'
           ) AS images,
           COALESCE(
             (SELECT json_agg(DISTINCT jsonb_build_object(
               'variant_id',     pv.id,
               'attribute_slug', at.slug,
               'value',          av.value,
               'display_value',  COALESCE(av.display_value, av.value),
               'hex_color',      av.hex_color,
               'main_image',     (
                 SELECT vi.url FROM variant_images vi
                 WHERE vi.variant_id = pv.id AND vi.is_main = true LIMIT 1
               )
             ))
             FROM product_variants pv
             JOIN variant_attribute_values vav ON vav.variant_id = pv.id
             JOIN attribute_values av ON av.id = vav.attribute_value_id
             JOIN attribute_types  at ON at.id = av.attribute_type_id
             WHERE pv.product_id = p.id AND pv.is_active = true AND pv.stock > 0),
             '[]'
           ) AS variant_swatches
         FROM products p
         LEFT JOIN categories c      ON c.id = p.category_id
         LEFT JOIN product_images pi ON pi.product_id = p.id
         ${where}
         GROUP BY p.id, p.name, p.sku, p.description, p.sale_price,
                  p.stock, p.min_stock, p.has_variants, c.name, c.slug,
                  p.created_at, p.owner_admin_id
         ORDER BY ${orderBy}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         ${where}`,
        params.slice(0, -2)
      ),
    ]);

    const total = parseInt(countRow.rows[0].count);

    return res.json({
      success: true,
      data:    rows.rows,
      meta: {
        total,
        page:  parseInt(page),
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /products", error);
    res.status(500).json({ success: false, message: "Error al obtener productos" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/products/:id
// CORRECCIÓN: se agrega subquery de variant_images para que el carrusel
// de color funcione correctamente en el frontend (selectedVariant.images).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/products/:id", requireApiPermission("products:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku, p.description,
         p.sale_price,
         p.sale_price AS price,
         p.stock,
         p.has_variants,
         CASE
           WHEN p.stock <= 0           THEN 'out'
           WHEN p.stock <= p.min_stock THEN 'low'
           ELSE 'normal'
         END AS stock_status,
         c.name AS category,
         c.name AS category_name,
         c.slug AS category_slug,
         (SELECT url FROM product_images
          WHERE product_id = p.id AND is_main = true LIMIT 1) AS main_image,
         COALESCE(
           (SELECT json_agg(jsonb_build_object('url', pi.url, 'is_main', pi.is_main))
            FROM product_images pi WHERE pi.product_id = p.id),
           '[]'
         ) AS images,
         COALESCE(
           (SELECT json_agg(
             jsonb_build_object(
               'id',         pv.id,
               'sku',        pv.sku,
               'sale_price', COALESCE(pv.sale_price, p.sale_price),
               'price',      COALESCE(pv.sale_price, p.sale_price),
               'stock',      pv.stock,
               'is_active',  pv.is_active,
               'attributes', (
                 SELECT COALESCE(json_agg(
                   jsonb_build_object(
                     'type',               at.name,
                     'slug',               at.slug,
                     'icon',               at.icon,
                     'value',              av.value,
                     'display_value',      COALESCE(av.display_value, av.value),
                     'hex_color',          av.hex_color,
                     'attribute_value_id', av.id
                   ) ORDER BY at.id, av.sort_order
                 ), '[]'::json)
                 FROM variant_attribute_values vav
                 JOIN attribute_values av ON av.id = vav.attribute_value_id
                 JOIN attribute_types  at ON at.id = av.attribute_type_id
                 WHERE vav.variant_id = pv.id
               ),
               'images', (
                 SELECT COALESCE(json_agg(
                   jsonb_build_object('id', vi.id, 'url', vi.url, 'is_main', vi.is_main)
                   ORDER BY vi.is_main DESC, vi.display_order
                 ), '[]'::json)
                 FROM variant_images vi WHERE vi.variant_id = pv.id
               )
             )
           )
           FROM product_variants pv
           WHERE pv.product_id = p.id AND pv.is_active = true),
           '[]'
         ) AS variants
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = $1
         AND p.is_active = true
         AND p.owner_admin_id = $2`,
      [req.params.id, adminId]
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

// GET /public-api/v1/categories
router.get("/categories", requireApiPermission("categories:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         c.id, c.name, c.slug, c.description, c.image_url,
         COUNT(p.id) FILTER (WHERE p.is_active = true)::int AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.owner_admin_id = $1
       WHERE c.is_active = true
         AND c.owner_admin_id = $1
       GROUP BY c.id
       ORDER BY c.name`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /categories", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
});

// GET /public-api/v1/inventory
router.get("/inventory", requireApiPermission("inventory:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const { low_stock } = req.query;

    let where = "WHERE p.is_active = true AND p.owner_admin_id = $1";
    if (low_stock === "true") where += " AND p.stock <= p.min_stock";

    const result = await db.query(
      `SELECT
         p.id, p.name, p.sku,
         p.stock, p.min_stock, p.max_stock,
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
});

// GET /public-api/v1/banners
router.get("/banners", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT id, title, description, image_url, button_text, button_link, display_order, is_active
       FROM banners
       WHERE is_active = true
         AND created_by = $1
       ORDER BY display_order ASC`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /banners", error);
    res.status(500).json({ success: false, message: "Error al obtener banners" });
  }
});

// GET /public-api/v1/discounts
router.get("/discounts", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const now     = new Date();

    const result = await db.query(
      `SELECT
         id, name, code, type, value,
         min_purchase_amount, max_discount_amount,
         starts_at, ends_at,
         usage_limit, times_used,
         description
       FROM discounts
       WHERE active = true
         AND owner_admin_id = $1
         AND starts_at <= $2
         AND ends_at   >= $2
         AND (usage_limit IS NULL OR times_used < usage_limit)
       ORDER BY ends_at ASC`,
      [adminId, now]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /discounts", error);
    res.status(500).json({ success: false, message: "Error al obtener descuentos" });
  }
});

// POST /public-api/v1/discounts/validate
router.post("/discounts/validate", async (req, res) => {
  try {
    const adminId          = req.apiKey.adminId;
    const { code, amount } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: "Código requerido" });
    }

    const now = new Date();

    const result = await db.query(
      `SELECT
         id, name, code, type, value,
         min_purchase_amount, max_discount_amount,
         usage_limit, times_used
       FROM discounts
       WHERE code = $1
         AND owner_admin_id = $2
         AND active = true
         AND starts_at <= $3
         AND ends_at   >= $3
         AND (usage_limit IS NULL OR times_used < usage_limit)`,
      [code.toUpperCase().trim(), adminId, now]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Cupón inválido, expirado o no disponible",
        code:    "INVALID_COUPON",
      });
    }

    const discount = result.rows[0];

    if (amount && parseFloat(amount) < parseFloat(discount.min_purchase_amount)) {
      return res.status(400).json({
        success: false,
        message: `Compra mínima requerida: $${discount.min_purchase_amount}`,
        code:    "MIN_PURCHASE_NOT_MET",
      });
    }

    let discountAmount = 0;
    if (discount.type === "percentage") {
      discountAmount = (parseFloat(amount || 0) * discount.value) / 100;
      if (discount.max_discount_amount) {
        discountAmount = Math.min(discountAmount, parseFloat(discount.max_discount_amount));
      }
    } else {
      discountAmount = parseFloat(discount.value);
    }

    return res.json({
      success: true,
      data: {
        ...discount,
        discount_amount: parseFloat(discountAmount.toFixed(2)),
        final_amount:    parseFloat((parseFloat(amount || 0) - discountAmount).toFixed(2)),
      },
    });
  } catch (error) {
    console.error("[PUBLIC API] POST /discounts/validate", error);
    res.status(500).json({ success: false, message: "Error al validar cupón" });
  }
});

// GET /public-api/v1/sales
router.get("/sales", requireApiPermission("sales:read"), async (req, res) => {
  try {
    const adminId                           = req.apiKey.adminId;
    const { page = 1, limit = 20, status } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 50);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where    = "WHERE s.owner_admin_id = $1";

    if (status) {
      params.push(status);
      where += ` AND s.payment_status = $${params.length}`;
    }

    params.push(safeLimit, offset);

    const result = await db.query(
      `SELECT
         s.id, s.sale_number, s.sale_date,
         s.subtotal, s.discount_amount, s.total,
         s.payment_method, s.payment_status, s.sale_type,
         s.shipping_address, s.customer_phone,
         COUNT(si.id)::int                  AS items_count,
         COALESCE(SUM(si.quantity), 0)::int AS units_total
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id = s.id
       ${where}
       GROUP BY s.id
       ORDER BY s.sale_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({
      success: true,
      data:    result.rows,
      meta: { page: parseInt(page), limit: safeLimit },
    });
  } catch (error) {
    console.error("[PUBLIC API] GET /sales", error);
    res.status(500).json({ success: false, message: "Error al obtener ventas" });
  }
});

// POST /public-api/v1/sales
router.post("/sales", requireApiPermission("sales:write"), async (req, res) => {
  const client = await db.connect();
  try {
    const adminId = req.apiKey.adminId;
    const {
      items,
      customer_phone,
      shipping_address,
      shipping_city,
      shipping_notes,
      payment_method = "transfer",
      coupon_code,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Se requiere al menos un item", code: "MISSING_ITEMS" });
    }

    await client.query("BEGIN");

    let subtotal    = 0;
    const saleItems = [];

    for (const item of items) {
      if (!item.product_id || !item.quantity || item.quantity < 1) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Cada item requiere product_id y quantity válidos", code: "INVALID_ITEM" });
      }

      const productRes = await client.query(
        `SELECT id, name, sale_price, stock, purchase_price
         FROM products
         WHERE id = $1 AND is_active = true AND owner_admin_id = $2`,
        [item.product_id, adminId]
      );

      if (productRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Producto ID ${item.product_id} no encontrado`, code: "PRODUCT_NOT_FOUND" });
      }

      const product = productRes.rows[0];

      if (product.stock < item.quantity) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Stock insuficiente para "${product.name}". Disponible: ${product.stock}`, code: "INSUFFICIENT_STOCK" });
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

    let discountAmount = 0;
    let discountId     = null;

    if (coupon_code) {
      const now = new Date();
      const couponRes = await client.query(
        `SELECT id, type, value, min_purchase_amount, max_discount_amount
         FROM discounts
         WHERE code = $1 AND owner_admin_id = $2 AND active = true
           AND starts_at <= $3 AND ends_at >= $3
           AND (usage_limit IS NULL OR times_used < usage_limit)`,
        [coupon_code.toUpperCase().trim(), adminId, now]
      );

      if (couponRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: "Cupón inválido o expirado", code: "INVALID_COUPON" });
      }

      const coupon = couponRes.rows[0];

      if (subtotal < parseFloat(coupon.min_purchase_amount)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `Compra mínima requerida: $${coupon.min_purchase_amount}`, code: "MIN_PURCHASE_NOT_MET" });
      }

      if (coupon.type === "percentage") {
        discountAmount = (subtotal * coupon.value) / 100;
        if (coupon.max_discount_amount) discountAmount = Math.min(discountAmount, parseFloat(coupon.max_discount_amount));
      } else {
        discountAmount = parseFloat(coupon.value);
      }

      discountId = coupon.id;
      await client.query("UPDATE discounts SET times_used = times_used + 1 WHERE id = $1", [coupon.id]);
    }

    const total      = Math.max(0, subtotal - discountAmount);
    const saleNumber = `WEB-${adminId}-${Date.now()}`;

    const saleRes = await client.query(
      `INSERT INTO sales (
         sale_number, subtotal, discount_amount, total,
         payment_method, payment_status, sale_type,
         shipping_address, shipping_city, shipping_notes,
         customer_phone, owner_admin_id, created_by
       ) VALUES ($1,$2,$3,$4,$5,'pending','web',$6,$7,$8,$9,$10,$10)
       RETURNING id, sale_number, subtotal, discount_amount, total`,
      [saleNumber, subtotal, discountAmount, total, payment_method,
       shipping_address || null, shipping_city || null,
       shipping_notes || null, customer_phone || null, adminId]
    );

    const saleId = saleRes.rows[0].id;

    for (const item of saleItems) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, subtotal, profit_per_unit, total_profit, discount_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [saleId, item.product_id, item.quantity, item.unit_price, item.unit_cost, item.subtotal, item.profit_unit, item.total_profit, discountId]
      );
      await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [item.quantity, item.product_id]);
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Venta registrada correctamente",
      data: {
        sale_id:         saleId,
        sale_number:     saleRes.rows[0].sale_number,
        subtotal:        saleRes.rows[0].subtotal,
        discount_amount: saleRes.rows[0].discount_amount,
        total:           saleRes.rows[0].total,
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

// GET /public-api/v1/customers
router.get("/customers", requireApiPermission("customers:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const { search, page = 1, limit = 20 } = req.query;
    const safeLimit = Math.min(parseInt(limit) || 20, 50);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where = `WHERE u.owner_admin_id = $1 AND r.name = 'user' AND u.is_active = true`;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`;
    }

    params.push(safeLimit, offset);

    const result = await db.query(
      `SELECT
         u.id, u.name, u.email, u.phone,
         u.city, u.created_at,
         COUNT(DISTINCT s.id)::int          AS total_orders,
         COALESCE(SUM(s.total), 0)::numeric AS total_spent
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r       ON r.id = ur.role_id
       LEFT JOIN sales s       ON s.customer_id = u.id AND s.owner_admin_id = $1
       ${where}
       GROUP BY u.id
       ORDER BY total_spent DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /customers", error);
    res.status(500).json({ success: false, message: "Error al obtener clientes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔐 AUTH DEL STOREFRONT
// Todas las rutas ya están cubiertas por apiKeyAuth (global arriba).
// Las rutas que requieren usuario logueado añaden el middleware `auth` (JWT).
// ─────────────────────────────────────────────────────────────────────────────

// POST /public-api/v1/auth/register
router.post(
  "/auth/register",
  checkRateLimit("ip", 10, 60 * 60 * 1000),
  storefrontAuth.register
);

// POST /public-api/v1/auth/verify
router.post("/auth/verify", storefrontAuth.verifyEmail);

// POST /public-api/v1/auth/resend-code
router.post(
  "/auth/resend-code",
  checkRateLimit("email", 3, 60 * 60 * 1000),
  storefrontAuth.resendCode
);

// POST /public-api/v1/auth/login
router.post(
  "/auth/login",
  checkRateLimit("email", 5, 15 * 60 * 1000),
  storefrontAuth.login
);

// POST /public-api/v1/auth/refresh  (API Key + refresh token → nuevo access token)
router.post("/auth/refresh", storefrontAuth.refreshToken);

// POST /public-api/v1/auth/logout   (requiere JWT del cliente)
router.post("/auth/logout", auth, storefrontAuth.logout);

// GET  /public-api/v1/auth/profile  (requiere JWT del cliente)
router.get("/auth/profile", auth, storefrontAuth.getProfile);

// PUT  /public-api/v1/auth/profile  (requiere JWT del cliente)
router.put("/auth/profile", auth, storefrontAuth.updateProfile);

// ─────────────────────────────────────────────────────────────────────────────
// HISTORIAL Y ESTADÍSTICAS DEL USUARIO (requieren JWT de cliente)
// Los handlers del panel filtran por owner_admin_id aquí para aislar al tenant.
// ─────────────────────────────────────────────────────────────────────────────

// GET /public-api/v1/sales/user/history
router.get("/sales/user/history", auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         s.id,
         s.sale_number     AS order_code,
         s.sale_date       AS created_at,
         s.total, s.amount_paid, s.payment_status, s.payment_method,
         s.sale_type, s.subtotal, s.tax_amount, s.discount_amount,
         s.credit_due_date, s.shipping_address, s.shipping_city, s.shipping_notes
       FROM sales s
       WHERE s.customer_id    = $1
         AND s.owner_admin_id = $2
       ORDER BY s.sale_date DESC`,
      [req.user.id, req.apiKey.adminId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[PUBLIC API] GET /sales/user/history:", err);
    res.status(500).json({ success: false, message: "Error al obtener historial" });
  }
});

// GET /public-api/v1/sales/user/stats
router.get("/sales/user/stats", auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(DISTINCT s.id) AS total_orders,
         COALESCE(SUM(CASE WHEN s.payment_status = 'paid'    THEN s.total ELSE 0 END), 0) AS total_invested,
         COALESCE(SUM(CASE WHEN s.payment_status = 'pending' THEN s.total ELSE 0 END), 0) AS pending_amount,
         COALESCE(SUM(CASE WHEN s.payment_status = 'partial' THEN (s.total - s.amount_paid) ELSE 0 END), 0) AS partial_pending,
         COUNT(DISTINCT CASE WHEN s.payment_status = 'paid'    THEN s.id END) AS completed_orders,
         COUNT(DISTINCT CASE WHEN s.payment_status = 'pending' THEN s.id END) AS pending_orders,
         COUNT(DISTINCT CASE WHEN s.payment_status = 'partial' THEN s.id END) AS partial_orders
       FROM sales s
       WHERE s.customer_id    = $1
         AND s.owner_admin_id = $2`,
      [req.user.id, req.apiKey.adminId]
    );
    res.json({ success: true, summary: rows[0] });
  } catch (err) {
    console.error("[PUBLIC API] GET /sales/user/stats:", err);
    res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESEÑAS
// ─────────────────────────────────────────────────────────────────────────────

// GET  /public-api/v1/products/:productId/reviews  (JWT opcional — enriquece con has_reviewed)
router.get("/products/:productId/reviews", reviewsCtrl.getProductReviews);

// GET  /public-api/v1/reviews/my/:productId  (requiere JWT de cliente)
router.get("/reviews/my/:productId", auth, reviewsCtrl.getUserReviewForProduct);

// POST /public-api/v1/reviews  (requiere JWT de cliente)
router.post("/reviews", auth, reviewsCtrl.createReview);

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD DE IMÁGENES (para reseñas u otros usos del storefront)
// ─────────────────────────────────────────────────────────────────────────────
const _uploadStorefront = createUpload("storefront", 5);

// POST /public-api/v1/upload
router.post("/upload", auth, _uploadStorefront.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No se recibió ningún archivo", code: "NO_FILE" });
  }
  res.json({
    success: true,
    data: {
      url:       req.file.path,
      public_id: req.file.filename,
    },
  });
});

module.exports = router;
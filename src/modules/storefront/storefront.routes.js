// src/modules/storefront/storefront.routes.js
const express        = require("express");
const router         = express.Router();
const { registerAuthRoutes } = require("./auth.routes");
const { registerAccountRoutes } = require("./account.routes");
const { registerCustomerRoutes } = require("./customers.routes");
const { registerSalesRoutes } = require("./sales.routes");
const { registerInventoryListRoute, registerInventoryAvailabilityRoute } = require("./inventory.routes");
const { registerReviewsRoutes } = require("./reviews.routes");
const { registerUploadRoutes } = require("./uploads.routes");
const { registerPaymentRoutes } = require("./payments.routes");
const { registerReservationRoutes } = require("./reservations.routes");
const db             = require("../../platform/database");
const {
  apiKeyAuth,
  requireApiPermission,
} = require("../identity/auth");


const analyticsCtrl   = require("../analytics").controller;


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

// POST /public-api/v1/analytics/pageview
router.post("/analytics/pageview", requireApiPermission("analytics:write"), analyticsCtrl.trackPageview);

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/profile
// ─────────────────────────────────────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         ap.business_name, ap.tagline, ap.description,
         ap.logo_url, ap.favicon_url,
         ap.primary_color, ap.secondary_color, ap.accent_color,
         ap.business_email, ap.business_phone, ap.website,
         ap.address, ap.city, ap.department, ap.country,
         ap.currency, ap.social_links,
         ap.store_navbar_bg, ap.store_navbar_text, ap.store_page_bg, ap.store_font
       FROM admin_profiles ap
       WHERE ap.user_id = $1`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows[0] ?? null });
  } catch (error) {
    console.error("[PUBLIC API] GET /profile", error);
    res.status(500).json({ success: false, message: "Error al obtener el perfil del negocio" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/products
// Incluye LATERAL JOIN para precio final con descuentos de scope 'web' o 'all'
// ─────────────────────────────────────────────────────────────────────────────
router.get("/products", requireApiPermission("products:read"), async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const { search, page = 1, limit = 20, sort = "name" } = req.query;
    const category = req.query.category || req.query.categoria;
    const safeLimit = Math.min(parseInt(limit) || 20, 100);
    const offset    = (Math.max(parseInt(page) || 1, 1) - 1) * safeLimit;

    const params = [adminId];
    let where = "WHERE p.is_active = true AND p.owner_admin_id = $1";

    if (category) {
      const { rows: catRows } = await db.query(
        `WITH RECURSIVE cat_tree AS (
           SELECT id FROM categories WHERE slug = $1 AND owner_admin_id = $2 AND is_active = true
           UNION ALL
           SELECT c.id FROM categories c
           JOIN cat_tree ct ON c.parent_id = ct.id
           WHERE c.is_active = true AND c.owner_admin_id = $2
         )
         SELECT id FROM cat_tree`,
        [category, adminId]
      );
      if (catRows.length === 0) {
        return res.json({ success: true, data: [], meta: { total: 0, page: parseInt(page), limit: safeLimit, pages: 0 } });
      }
      params.push(catRows.map(r => Number(r.id)));
      where += ` AND p.category_id = ANY($${params.length})`;
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
           p.sale_price,
           p.sale_price AS price,
           p.stock,
           GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) AS disponible_inmediato,
           p.has_variants,
           p.fulfillment_mode,
           p.supplier_lead_time_days,
           p.fulfillment_mode IN ('hybrid', 'on_demand') AS can_order_on_demand,
           CASE
             WHEN NOT p.has_variants
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                  AND p.fulfillment_mode IN ('hybrid', 'on_demand')
               THEN true ELSE false
           END AS is_on_demand,
           CASE
             WHEN NOT p.has_variants
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                  AND p.fulfillment_mode IN ('hybrid', 'on_demand')
               THEN 'on_demand' ELSE 'stock'
           END AS sale_mode,
           CASE
             WHEN NOT p.has_variants
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                  AND p.fulfillment_mode IN ('hybrid', 'on_demand')
               THEN 'Venta bajo pedido'
             ELSE 'Disponible para entrega inmediata'
           END AS availability_label,
           -- Vocabulario del catálogo público: on_demand | out | low | normal.
           -- No confundir con stock_status de v_stock_disponible.
           CASE
             WHEN p.fulfillment_mode IN ('hybrid', 'on_demand')
                  AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
               THEN 'on_demand'
             WHEN GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0 THEN 'out'
             WHEN p.stock <= p.min_stock THEN 'low'
             ELSE 'normal'
           END AS stock_status,
           c.name AS category, c.name AS category_name, c.slug AS category_slug,
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
           ) AS variant_swatches,
           best_discount.type  AS discount_type,
           best_discount.value AS discount_value,
           COALESCE(best_discount.final_price, p.sale_price) AS final_price
         FROM products p
         LEFT JOIN categories c      ON c.id = p.category_id
         LEFT JOIN product_images pi ON pi.product_id = p.id
         LEFT JOIN LATERAL (
           SELECT d.type, d.value,
             CASE
               WHEN d.type = 'percentage'
                 THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
               WHEN d.type = 'fixed'
                 THEN p.sale_price - d.value
               ELSE p.sale_price
             END AS final_price
           FROM discount_targets dt
           JOIN discounts d ON d.id = dt.discount_id
           WHERE (
             (dt.target_type = 'product'  AND dt.target_id = p.id::text)
             OR
             (dt.target_type = 'category' AND dt.target_id = p.category_id::text
              AND p.category_id IS NOT NULL)
           )
             AND d.active = true
             AND NOW() BETWEEN d.starts_at AND d.ends_at
             AND (d.scope = 'web' OR d.scope = 'all')
           ORDER BY final_price ASC
           LIMIT 1
         ) best_discount ON true
         ${where}
         GROUP BY p.id, p.name, p.sku, p.description, p.sale_price,
                  p.stock, p.min_stock, p.has_variants, p.fulfillment_mode,
                  p.supplier_lead_time_days, c.name, c.slug,
                  p.created_at, p.owner_admin_id,
                  best_discount.type, best_discount.value, best_discount.final_price
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
         GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) AS disponible_inmediato,
         p.has_variants,
         p.fulfillment_mode,
         p.supplier_lead_time_days,
         p.fulfillment_mode IN ('hybrid', 'on_demand') AS can_order_on_demand,
         CASE
           WHEN NOT p.has_variants
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                AND p.fulfillment_mode IN ('hybrid', 'on_demand')
             THEN true ELSE false
         END AS is_on_demand,
         CASE
           WHEN NOT p.has_variants
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                AND p.fulfillment_mode IN ('hybrid', 'on_demand')
             THEN 'on_demand' ELSE 'stock'
         END AS sale_mode,
         CASE
           WHEN NOT p.has_variants
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
                AND p.fulfillment_mode IN ('hybrid', 'on_demand')
             THEN 'Venta bajo pedido'
           ELSE 'Disponible para entrega inmediata'
         END AS availability_label,
         -- Vocabulario del catálogo público: on_demand | out | low | normal.
         -- No confundir con stock_status de v_stock_disponible.
         CASE
           WHEN p.fulfillment_mode IN ('hybrid', 'on_demand')
                AND GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0
             THEN 'on_demand'
           WHEN GREATEST(0, p.stock - p.stock_reserved - p.stock_safety) <= 0 THEN 'out'
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
         ) AS variants,
         d.name  AS discount_name,
         d.type  AS discount_type,
         d.value AS discount_value,
         CASE
           WHEN d.type = 'percentage'
             THEN ROUND((p.sale_price - (p.sale_price * (d.value / 100)))::numeric, 2)
           WHEN d.type = 'fixed' THEN p.sale_price - d.value
           ELSE p.sale_price
         END AS final_price
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN discount_targets dt ON (
         (dt.target_type = 'product'  AND dt.target_id = p.id::text) OR
         (dt.target_type = 'category' AND dt.target_id = p.category_id::text
          AND p.category_id IS NOT NULL)
       )
       LEFT JOIN discounts d
         ON dt.discount_id = d.id
         AND d.active = true
         AND NOW() BETWEEN d.starts_at AND d.ends_at
         AND (d.scope = 'web' OR d.scope = 'all')
       WHERE p.id = $1
         AND p.is_active = true
         AND p.owner_admin_id = $2
       LIMIT 1`,
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
         c.id, c.name, c.slug, c.description, c.image_url, c.parent_id,
         COUNT(p.id) FILTER (WHERE p.is_active = true)::int AS product_count
       FROM categories c
       LEFT JOIN products p ON p.category_id = c.id AND p.owner_admin_id = $1
       WHERE c.is_active = true
         AND c.owner_admin_id = $1
       GROUP BY c.id, c.name, c.slug, c.description, c.image_url, c.parent_id
       ORDER BY c.name`,
      [adminId]
    );

    const rows = result.rows.map(r => ({
      ...r,
      id:        Number(r.id),
      parent_id: r.parent_id != null ? Number(r.parent_id) : null,
    }));

    const buildTree = (items, parentId = null) =>
      items
        .filter(i => i.parent_id === parentId)
        .map(i => ({ ...i, children: buildTree(items, i.id) }));

    return res.json({ success: true, data: buildTree(rows) });
  } catch (error) {
    console.error("[PUBLIC API] GET /categories", error);
    res.status(500).json({ success: false, message: "Error al obtener categorías" });
  }
});

registerInventoryListRoute(router);

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

// ─────────────────────────────────────────────────────────────────────────────
// GET /public-api/v1/discounts
// Solo retorna descuentos con scope 'web' o 'all', activos y vigentes.
// Incluye targets para que el frontend pueda aplicar descuentos por producto/categoría.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/discounts", async (req, res) => {
  try {
    const adminId = req.apiKey.adminId;
    const now     = new Date();

    const result = await db.query(
      `SELECT
         d.id, d.name, d.code, d.type, d.value, d.scope,
         d.min_purchase_amount, d.max_discount_amount,
         d.starts_at, d.ends_at,
         d.usage_limit, d.times_used,
         d.description,
         COALESCE(
           (SELECT json_agg(json_build_object(
             'target_type', dt.target_type,
             'target_id',   dt.target_id
           ))
           FROM discount_targets dt
           WHERE dt.discount_id = d.id),
           '[]'
         ) AS targets
       FROM discounts d
       WHERE d.active = true
         AND d.owner_admin_id = $1
         AND d.starts_at <= $2
         AND d.ends_at   >= $2
         AND (d.scope = 'web' OR d.scope = 'all')
         AND (d.usage_limit IS NULL OR d.times_used < d.usage_limit)
       ORDER BY d.ends_at ASC`,
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
         AND (scope = 'web' OR scope = 'all')
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

registerSalesRoutes(router);

registerInventoryAvailabilityRoute(router);

registerCustomerRoutes(router);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH DEL STOREFRONT
// ─────────────────────────────────────────────────────────────────────────────

registerAuthRoutes(router);









// ─────────────────────────────────────────────────────────────────────────────
// HISTORIAL Y ESTADÍSTICAS DEL USUARIO
// ─────────────────────────────────────────────────────────────────────────────

registerAccountRoutes(router);

// ─────────────────────────────────────────────────────────────────────────────
// RESEÑAS
// ─────────────────────────────────────────────────────────────────────────────

registerReviewsRoutes(router);



// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────────────────────────────────────────

registerUploadRoutes(router);

// RESERVAS DE STOCK
// ─────────────────────────────────────────────────────────────────────────────

registerReservationRoutes(router);

// WOMPI
// ─────────────────────────────────────────────────────────────────────────────

registerPaymentRoutes(router);


module.exports = router;

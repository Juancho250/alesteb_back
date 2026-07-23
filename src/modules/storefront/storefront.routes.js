// src/modules/storefront/storefront.routes.js
const express        = require("express");
const router         = express.Router();
const { registerAuthRoutes } = require("./auth.routes");
const { registerAccountRoutes } = require("./account.routes");
const { registerCustomerRoutes } = require("./customers.routes");
const { registerSalesRoutes } = require("./sales.routes");
const { registerInventoryListRoute, registerInventoryAvailabilityRoute } = require("./inventory.routes");
const { registerCatalogRoutes } = require("./catalog.routes");
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
registerCatalogRoutes(router);

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

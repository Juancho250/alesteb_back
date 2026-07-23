// src/modules/storefront/storefront.routes.js
const express        = require("express");
const router         = express.Router();
const { registerAuthRoutes } = require("./auth.routes");
const { registerAccountRoutes } = require("./account.routes");
const { registerCustomerRoutes } = require("./customers.routes");
const { registerSalesRoutes } = require("./sales.routes");
const { registerInventoryListRoute, registerInventoryAvailabilityRoute } = require("./inventory.routes");
const { registerCatalogRoutes } = require("./catalog.routes");
const { registerDiscountRoutes } = require("./discounts.routes");
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
registerDiscountRoutes(router);

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

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
const { registerBannerRoutes } = require("./banners.routes");
const { registerProfileRoutes } = require("./profile.routes");
const { registerReviewsRoutes } = require("./reviews.routes");
const { registerUploadRoutes } = require("./uploads.routes");
const { registerPaymentRoutes } = require("./payments.routes");
const { registerReservationRoutes } = require("./reservations.routes");
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
registerProfileRoutes(router);

registerCatalogRoutes(router);

registerInventoryListRoute(router);

registerBannerRoutes(router);

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

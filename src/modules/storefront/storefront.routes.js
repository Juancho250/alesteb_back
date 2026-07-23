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
const { registerSystemRoutes } = require("./system.routes");
const { registerReviewsRoutes } = require("./reviews.routes");
const { registerUploadRoutes } = require("./uploads.routes");
const { registerPaymentRoutes } = require("./payments.routes");
const { registerReservationRoutes } = require("./reservations.routes");
const {
  apiKeyAuth,
} = require("../identity/auth");




router.use(apiKeyAuth);

registerSystemRoutes(router);

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

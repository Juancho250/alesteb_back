"use strict";

const express = require("express");

const { registerAuthRoutes } = require("./auth.routes");
const { registerAccountRoutes } = require("./account.routes");
const { registerCustomerRoutes } = require("./customers.routes");
const { registerSalesRoutes } = require("./sales.routes");
const {
  registerInventoryListRoute,
  registerInventoryAvailabilityRoute,
} = require("./inventory.routes");
const { registerCatalogRoutes } = require("./catalog.routes");
const { registerDiscountRoutes } = require("./discounts.routes");
const { registerBannerRoutes } = require("./banners.routes");
const { registerProfileRoutes } = require("./profile.routes");
const { registerSystemRoutes } = require("./system.routes");
const { registerReviewsRoutes } = require("./reviews.routes");
const { registerUploadRoutes } = require("./uploads.routes");
const { registerPaymentRoutes } = require("./payments.routes");
const {
  registerReservationRoutes,
} = require("./reservations.routes");

const { apiKeyAuth } = require("../identity/auth");

const router = express.Router();

router.use(apiKeyAuth);

/*
 * El orden de registro forma parte del contrato HTTP.
 * No reorganizar sin comparar previamente el router.
 */
registerSystemRoutes(router);
registerProfileRoutes(router);
registerCatalogRoutes(router);
registerInventoryListRoute(router);
registerBannerRoutes(router);
registerDiscountRoutes(router);
registerSalesRoutes(router);
registerInventoryAvailabilityRoute(router);
registerCustomerRoutes(router);
registerAuthRoutes(router);
registerAccountRoutes(router);
registerReviewsRoutes(router);
registerUploadRoutes(router);
registerReservationRoutes(router);
registerPaymentRoutes(router);

module.exports = router;

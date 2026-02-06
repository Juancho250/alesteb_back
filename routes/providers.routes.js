const { Router } = require("express");
const { 
  getProviders, 
  createProvider, 
  getProviderHistory,
  getProductPriceHistory 
} = require("../controllers/providers.controller");

const router = Router();

router.get("/", getProviders);
router.post("/", createProvider);
router.get("/:id/history", getProviderHistory);
router.get("/:provider_id/product/:product_id/prices", getProductPriceHistory);

module.exports = router;
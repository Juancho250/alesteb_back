// src/routes/variants_bundles.routes.js
// Agregar estas rutas en products.routes.js o como archivo separado

const express = require("express");
const router  = express.Router();
const { auth, requireManager } = require("../middleware/auth.middleware");
const upload = require("../middleware/upload.middleware");
const varCtrl    = require("../controllers/variants.controller");
const bundleCtrl = require("../controllers/bundles.controller");

// ── Atributos ────────────────────────────────────────────────────────────────
router.get ("/attributes",                    auth, varCtrl.getAttributeTypes);
router.post("/attributes/:typeId/values",     auth, requireManager, varCtrl.createAttributeValue);

// ── Variantes de un producto ─────────────────────────────────────────────────
router.get ("/products/:productId/variants",           auth, varCtrl.list);
router.post("/products/:productId/variants",           auth, requireManager, varCtrl.create);
router.put ("/products/:productId/variants/:variantId",auth, requireManager, varCtrl.update);
router.delete("/products/:productId/variants/:variantId", auth, requireManager, varCtrl.remove);

// ── Bundle items ──────────────────────────────────────────────────────────────
router.get ("/products/:bundleId/bundle-items",  auth, bundleCtrl.getBundleItems);
router.put ("/products/:bundleId/bundle-items",  auth, requireManager, bundleCtrl.updateBundleItems);

// ── Crear bundle (POST /bundles para separarlo de products) ───────────────────
router.post("/bundles", auth, requireManager, upload.array("images", 4), bundleCtrl.createBundle);

module.exports = router;
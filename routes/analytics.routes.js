// routes/analytics.routes.js
const express    = require("express");
const router     = express.Router();
const ctrl       = require("../controllers/analytics.controller");
const { auth, requireManager } = require("../src/modules/identity/auth");
const { adminScope } = require("../middleware/adminScope");
const { requireFeature } = require("../middleware/subscription.middleware");

// ── Pública — storefront sin auth ─────────────────────────────────
router.post("/pageview", ctrl.trackPageview);

// ── Privadas — auth + adminScope para todo lo de abajo ────────────
router.use(auth);
router.use(adminScope);
router.use(requireManager);
router.use(requireFeature("has_analytics"));

router.get("/summary", ctrl.getSummary);
router.get("/detail",  ctrl.getDetail);

module.exports = router;

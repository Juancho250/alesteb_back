// routes/analytics.routes.js
const express    = require("express");
const router     = express.Router();
const ctrl       = require("../controllers/analytics.controller");
const { auth }   = require("../middleware/auth.middleware");

// POST /api/analytics/pageview  ← lo llama la web pública (sin auth)
router.post("/pageview", ctrl.trackPageview);

// GET  /api/analytics/summary   ← lo consume el panel admin (con auth)
router.get("/summary", auth, ctrl.getSummary);

module.exports = router;
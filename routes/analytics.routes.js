// routes/analytics.routes.js  ← reemplaza el archivo completo
const express  = require("express");
const router   = express.Router();
const ctrl     = require("../controllers/analytics.controller");
const { auth } = require("../middleware/auth.middleware");

// POST /api/analytics/pageview  ← la web pública (sin auth)
router.post("/pageview", ctrl.trackPageview);

// GET  /api/analytics/summary   ← panel admin (con auth)
router.get("/summary", auth, ctrl.getSummary);

// GET  /api/analytics/detail    ← panel admin (con auth)
// Query params opcionales:
//   period=today|week|month
//   page=/ruta           → filtra a una sola página
//   search=texto         → busca en label, session_id, user.name, user.email
router.get("/detail", auth, ctrl.getDetail);

module.exports = router;
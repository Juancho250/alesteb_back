// src/routes/notifications.routes.js
const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl    = require("../controllers/notifications.controller");
const pushCtrl = require("../controllers/pushSubscription.controller");

const router = express.Router();

/** GET  /api/notifications          — Panel de alertas */
router.get("/",           auth, requireManager, ctrl.getAll);

/** GET  /api/notifications/push-key — Clave pública VAPID (pública) */
router.get("/push-key",   pushCtrl.getPublicKey);

/** POST /api/notifications/subscribe   — Guardar suscripción push */
router.post("/subscribe",   auth, pushCtrl.subscribe);

/** POST /api/notifications/unsubscribe — Cancelar suscripción push */
router.post("/unsubscribe", auth, pushCtrl.unsubscribe);

module.exports = router;
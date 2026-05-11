// routes/sales.routes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/sales.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");

// ── Middleware global — auth + adminScope para todas ─────────
router.use(auth);
router.use(adminScope);

// ── Rutas estáticas primero ───────────────────────────────────
router.get ("/",             requireManager, ctrl.getAllSales);
router.get ("/user/history",                ctrl.getUserOrderHistory);
router.get ("/user/stats",                  ctrl.getUserStats);
router.post("/",                            ctrl.createOrder);
router.post("/checkout",                    ctrl.createOrder);

// ── Rutas con :id ─────────────────────────────────────────────
router.get ("/:id/payments",                ctrl.getSalePayments);
router.post("/:id/payments", requireManager,ctrl.registerPayment);
router.post("/:id/cancel",                  ctrl.cancelOrder);
router.get ("/:id",                         ctrl.getOrderDetail);

module.exports = router;
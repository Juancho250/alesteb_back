// src/routes/sales.routes.js
const express = require("express");
const router  = express.Router();

const ctrl              = require("../controllers/sales.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ── Rutas estáticas primero ──────────────────────────────────
router.get("/",             auth, ctrl.getAllSales);
router.get("/user/history", auth, ctrl.getUserOrderHistory);
router.get("/user/stats",   auth, ctrl.getUserStats);

router.post("/",         auth, ctrl.createOrder);
router.post("/checkout", auth, ctrl.createOrder);

// ── Rutas con :id ────────────────────────────────────────────
router.get( "/:id/payments", auth,                     ctrl.getSalePayments);   // historial de pagos
router.post("/:id/payments", auth, requireManager,     ctrl.registerPayment);   // registrar abono
router.post("/:id/cancel",   auth,                     ctrl.cancelOrder);       // cancelar
router.get( "/:id",          auth,                     ctrl.getOrderDetail);    // ítems

module.exports = router;
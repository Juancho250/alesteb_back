// src/routes/sales.routes.js
const express = require("express");
const router  = express.Router();

const salesController = require("../controllers/sales.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ── Rutas estáticas primero (antes de /:id) ──────────────────────────────────

router.get("/",             auth, salesController.getAllSales);
router.get("/user/history", auth, salesController.getUserOrderHistory);
router.get("/user/stats",   auth, salesController.getUserStats);

router.post("/",            auth, salesController.createOrder);
router.post("/checkout",    auth, salesController.createOrder);

// ── Rutas con :id ────────────────────────────────────────────────────────────
// Cancelar pedido (cliente)
router.post("/:id/cancel", auth, salesController.cancelOrder);

// Detalle de pedido — siempre al final
router.get("/:id", auth, salesController.getOrderDetail);

module.exports = router;
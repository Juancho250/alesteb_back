// routes/sales.routes.js
const express      = require("express");
const router       = express.Router();
const ctrl         = require("../controllers/sales.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope }           = require("../middleware/adminScope");
const uploadProof  = require("../middleware/upload_proof.middleware");

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
router.get ("/:id/payments",                                     ctrl.getSalePayments);
router.post("/:id/payments",          requireManager,            ctrl.registerPayment);
router.post("/:id/cancel",          ctrl.cancelOrder);
router.post("/:id/mark-delivered",  requireManager, ctrl.markSaleAsDelivered);

// ── Comprobantes de pago ──────────────────────────────────────
// Cualquier parte autorizada (admin, gerente o el cliente dueño de la venta) puede subir/borrar
router.post  ("/:id/payments/:paymentId/proof", uploadProof.single("proof"), ctrl.uploadPaymentProof);
router.delete("/:id/payments/:paymentId/proof", requireManager,              ctrl.deletePaymentProof);

router.get ("/:id",                         ctrl.getOrderDetail);

module.exports = router;
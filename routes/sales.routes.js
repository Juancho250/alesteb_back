// src/routes/sales.routes.js
const express = require("express");
const router  = express.Router();

const salesController = require("../controllers/sales.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");
const uploadProof = require("../middleware/upload_proof.middleware");

// ── Rutas estáticas primero (antes de /:id) ──────────────────────────────────

router.get("/",               auth, salesController.getAllSales);
router.get("/user/history",   auth, salesController.getUserOrderHistory);
router.get("/user/stats",     auth, salesController.getUserStats);

router.post("/",              auth, salesController.createOrder);
router.post("/checkout",      auth, salesController.createOrder);

// ── Rutas con :id ────────────────────────────────────────────────────────────

// Cancelar pedido (cliente)
router.post("/:id/cancel",           auth,                    salesController.cancelOrder);

// Confirmar pago (admin/gerente)
router.post("/:id/confirm-payment",  auth, requireManager,    salesController.confirmPayment);

// Subir comprobante (cliente — usa multer + cloudinary)
router.post("/:id/upload-proof",     auth, uploadProof.single("proof"), salesController.uploadPaymentProof);

// Ver comprobante (admin/gerente)
router.get("/:id/proof",             auth, requireManager,    salesController.getPaymentProof);

// Detalle de pedido — SIEMPRE al final para no capturar las rutas anteriores
router.get("/:id",                   auth,                    salesController.getOrderDetail);

module.exports = router;
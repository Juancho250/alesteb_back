const express = require("express");
const router = express.Router();
const {
  createSale,
  getSales,
  getSaleById,
  getUserSales,
  getUserStats,
  updatePaymentStatus,
} = require("../controllers/sales.controller");

// Rutas para el Usuario/Cliente (Dashboard)
router.get("/user/history", getUserSales);
router.get("/user/stats", getUserStats);

// Rutas Generales / Admin
router.post("/", createSale); // ✅ Permite tanto ventas físicas (admin) como online (página)
router.get("/", getSales);
router.get("/:id", getSaleById);

// ✨ NUEVA RUTA: Actualizar estado de pago
router.patch("/:id/payment-status", updatePaymentStatus);

module.exports = router;
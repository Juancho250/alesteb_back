const express = require("express");
const router = express.Router();
const { auth, requireManager } = require("../middleware/auth.middleware");
const {
  createSale,
  getSales,
  getSaleById,
} = require("../controllers/sales.controller");

// ============================================
// 🛒 RUTAS DE VENTAS
// ============================================

/**
 * @route   POST /api/sales
 * @desc    Crear nueva venta
 * @access  Private (Todos los autenticados)
 */
router.post("/", auth, createSale);

/**
 * @route   GET /api/sales
 * @desc    Obtener todas las ventas (historial)
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, getSales);

/**
 * @route   GET /api/sales/:id
 * @desc    Obtener detalles de una venta específica
 * @access  Private (Admin y Gerente)
 */
router.get("/:id", auth, requireManager, getSaleById);

module.exports = router;
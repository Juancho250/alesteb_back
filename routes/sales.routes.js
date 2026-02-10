const express = require("express");
const router = express.Router();
const { auth, requireManager } = require("../middleware/auth.middleware");
const {
  createSale,
  getSales,
  getSaleById,
  getMyOrders,
  getSalesSummary,
} = require("../controllers/sales.controller");

// ============================================
// 🛒 RUTAS DE VENTAS
// ============================================

/**
 * @route   POST /api/sales
 * @desc    Crear nueva venta (física desde panel admin u online desde la web)
 *          sale_type: "fisica" | "online"
 * @access  Private (todos los autenticados — admin, gerente, cliente)
 */
router.post("/", auth, createSale);

/**
 * @route   GET /api/sales/my-orders
 * @desc    El cliente autenticado consulta SUS propias órdenes online
 *          ⚠️ Debe ir ANTES de /:id para que Express no lo interprete como ID
 * @access  Private (cualquier usuario autenticado)
 */
router.get("/my-orders", auth, getMyOrders);

/**
 * @route   GET /api/sales/summary
 * @desc    Resumen estadístico de ventas
 * @access  Private (Admin y Gerente)
 */
router.get("/summary", auth, requireManager, getSalesSummary);

/**
 * @route   GET /api/sales
 * @desc    Todas las ventas (historial completo del panel admin)
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, getSales);

/**
 * @route   GET /api/sales/:id
 * @desc    Detalle de una venta específica
 * @access  Private (Admin y Gerente)
 */
router.get("/:id", auth, requireManager, getSaleById);

module.exports = router;
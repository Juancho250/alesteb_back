const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/purchase_orders.controller");

const router = express.Router();

// ============================================
// 📋 ÓRDENES DE COMPRA
// ============================================

/**
 * @route   GET /api/purchase-orders
 * @desc    Ver todas las órdenes de compra
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, ctrl.getAll);

/**
 * @route   GET /api/purchase-orders/:id
 * @desc    Obtener orden específica
 * @access  Private (Admin y Gerente)
 */
router.get("/:id", auth, requireManager, ctrl.getById);

/**
 * @route   POST /api/purchase-orders
 * @desc    Crear orden de compra
 * @access  Private (Admin y Gerente)
 */
router.post("/", auth, requireManager, ctrl.create);

/**
 * @route   PUT /api/purchase-orders/:id
 * @desc    Actualizar orden (solo borradores y pendientes)
 * @access  Private (Admin y Gerente)
 */
router.put("/:id", auth, requireManager, ctrl.update);

/**
 * @route   POST /api/purchase-orders/:id/approve
 * @desc    Aprobar orden
 * @access  Private (Admin y Gerente)
 */
router.post("/:id/approve", auth, requireManager, ctrl.approve);

/**
 * @route   POST /api/purchase-orders/:id/receive
 * @desc    Recibir orden (actualiza inventario)
 * @access  Private (Admin y Gerente)
 */
router.post("/:id/receive", auth, requireManager, ctrl.receive);

/**
 * @route   POST /api/purchase-orders/:id/cancel
 * @desc    Cancelar orden
 * @access  Private (Admin y Gerente)
 */
router.post("/:id/cancel", auth, requireManager, ctrl.cancel);

/**
 * @route   DELETE /api/purchase-orders/:id
 * @desc    Eliminar orden (solo borradores)
 * @access  Private (Admin y Gerente)
 */
router.delete("/:id", auth, requireManager, ctrl.remove);

// ============================================
// 📊 REPORTES
// ============================================

/**
 * @route   GET /api/purchase-orders/reports/profit-analysis
 * @desc    Análisis de utilidades esperadas
 * @access  Private (Admin y Gerente)
 */
router.get("/reports/profit-analysis", auth, requireManager, ctrl.getProfitAnalysis);

/**
 * @route   GET /api/purchase-orders/reports/top-products
 * @desc    Productos más comprados
 * @access  Private (Admin y Gerente)
 */
router.get("/reports/top-products", auth, requireManager, ctrl.getTopProducts);

/**
 * @route   GET /api/purchase-orders/products/:product_id/price-comparison
 * @desc    Comparación de precios por producto
 * @access  Private (Admin y Gerente)
 */
router.get("/products/:product_id/price-comparison", auth, requireManager, ctrl.getPriceComparison);

module.exports = router;
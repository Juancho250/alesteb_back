const express = require("../middleware/auth.middleware");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/providers.controller");

const router = express.Router();

// ============================================
// 📦 RUTAS DE PROVEEDORES
// ============================================

/**
 * @route   GET /api/providers
 * @desc    Obtener todos los proveedores
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, ctrl.getAll);

/**
 * @route   GET /api/providers/:id
 * @desc    Obtener proveedor específico
 * @access  Private (Admin y Gerente)
 */
router.get("/:id", auth, requireManager, ctrl.getById);

/**
 * @route   POST /api/providers
 * @desc    Crear nuevo proveedor
 * @access  Private (Admin y Gerente)
 */
router.post("/", auth, requireManager, ctrl.create);

/**
 * @route   PUT /api/providers/:id
 * @desc    Actualizar proveedor
 * @access  Private (Admin y Gerente)
 */
router.put("/:id", auth, requireManager, ctrl.update);

/**
 * @route   DELETE /api/providers/:id
 * @desc    Eliminar proveedor
 * @access  Private (Admin y Gerente)
 */
router.delete("/:id", auth, requireManager, ctrl.remove);

// ============================================
// 💰 PAGOS
// ============================================

/**
 * @route   POST /api/providers/payments
 * @desc    Registrar pago a proveedor
 * @access  Private (Admin y Gerente)
 */
router.post("/payments", auth, requireManager, ctrl.registerPayment);

/**
 * @route   GET /api/providers/:id/payments
 * @desc    Obtener historial de pagos
 * @access  Private (Admin y Gerente)
 */
router.get("/:id/payments", auth, requireManager, ctrl.getPaymentHistory);

// ============================================
// 📊 HISTORIAL Y REPORTES
// ============================================

/**
 * @route   GET /api/providers/:id/purchases
 * @desc    Obtener historial de compras
 * @access  Private (Admin y Gerente)
 */
router.get("/:id/purchases", auth, requireManager, ctrl.getPurchaseHistory);

/**
 * @route   GET /api/providers/price-comparison
 * @desc    Comparar precios entre proveedores
 * @access  Private (Admin y Gerente)
 */
router.get("/price-comparison", auth, requireManager, ctrl.getPriceComparison);

/**
 * @route   GET /api/providers/:id/stats
 * @desc    Obtener estadísticas del proveedor
 * @access  Private (Admin y Gerente)
 */
router.get("/:id/stats", auth, requireManager, ctrl.getStats);

module.exports = router;
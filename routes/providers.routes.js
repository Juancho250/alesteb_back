const express = require("express");
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

router.post("/payments", auth, requireManager, ctrl.registerPayment);
router.get("/:id/payments", auth, requireManager, ctrl.getPaymentHistory);

// ============================================
// 📊 HISTORIAL Y REPORTES
// ============================================

router.get("/:id/purchases", auth, requireManager, ctrl.getPurchaseHistory);
router.get("/price-comparison", auth, requireManager, ctrl.getPriceComparison);
router.get("/:id/stats", auth, requireManager, ctrl.getStats);

module.exports = router;

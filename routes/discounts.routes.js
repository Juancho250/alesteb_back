const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/discounts.controller");

const router = express.Router();

// ============================================
// 💰 RUTAS DE DESCUENTOS
// ============================================

/**
 * @route   GET /api/discounts
 * @desc    Obtener todos los descuentos
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, ctrl.getAll);

/**
 * @route   POST /api/discounts
 * @desc    Crear nuevo descuento
 * @access  Private (Admin y Gerente)
 */
router.post("/", auth, requireManager, ctrl.create);

/**
 * @route   PUT /api/discounts/:id
 * @desc    Actualizar descuento
 * @access  Private (Admin y Gerente)
 */
router.put("/:id", auth, requireManager, ctrl.update);

/**
 * @route   DELETE /api/discounts/:id
 * @desc    Eliminar descuento
 * @access  Private (Admin y Gerente)
 */
router.delete("/:id", auth, requireManager, ctrl.remove);

router.patch("/:id", auth, requireManager, ctrl.toggleActive);
module.exports = router;
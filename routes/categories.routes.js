const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/categories.controller");

const router = express.Router();

// ============================================
// 🌐 RUTAS PÚBLICAS
// ============================================

/**
 * @route   GET /api/categories
 * @desc    Obtener categorías con estructura jerárquica
 * @access  Public
 */
router.get("/", ctrl.getAll);

/**
 * @route   GET /api/categories/flat
 * @desc    Obtener lista plana de categorías (para selects)
 * @access  Public
 */
router.get("/flat", ctrl.getFlat);

// ============================================
// 🔐 RUTAS PRIVADAS
// ============================================

/**
 * @route   POST /api/categories
 * @desc    Crear nueva categoría
 * @access  Private (Admin y Gerente)
 */
router.post("/", auth, requireManager, ctrl.create);

/**
 * @route   PUT /api/categories/:id
 * @desc    Actualizar categoría
 * @access  Private (Admin y Gerente)
 */
router.put("/:id", auth, requireManager, ctrl.update);

/**
 * @route   DELETE /api/categories/:id
 * @desc    Eliminar categoría
 * @access  Private (Admin y Gerente)
 */
router.delete("/:id", auth, requireManager, ctrl.remove);

module.exports = router;
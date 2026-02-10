const express = require("express");
const router = express.Router();
const bannerController = require("../controllers/banners.controller");
const upload = require("../middleware/upload.middleware");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ============================================
// 🌐 RUTAS PÚBLICAS
// ============================================

/**
 * @route   GET /api/banners
 * @desc    Obtener todos los banners (para carrusel público)
 * @access  Public
 */
router.get("/", bannerController.getAll);

// ============================================
// 🔐 RUTAS PRIVADAS (Panel de Administración)
// ============================================

/**
 * @route   POST /api/banners
 * @desc    Crear nuevo banner
 * @access  Private (Admin y Gerente)
 */
router.post(
    "/", 
    auth, 
    requireManager,
    upload.single("image"), 
    bannerController.create
);

/**
 * @route   PUT /api/banners/:id
 * @desc    Actualizar banner
 * @access  Private (Admin y Gerente)
 */
router.put(
    "/:id", 
    auth, 
    requireManager,
    upload.single("image"), 
    bannerController.update
);

/**
 * @route   DELETE /api/banners/:id
 * @desc    Eliminar banner
 * @access  Private (Admin y Gerente)
 */
router.delete(
    "/:id", 
    auth, 
    requireManager,
    bannerController.delete
);

module.exports = router;
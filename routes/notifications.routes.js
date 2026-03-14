// src/routes/notifications.routes.js
const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/notifications.controller");

const router = express.Router();

/**
 * @route   GET /api/notifications
 * @desc    Obtener todas las notificaciones del sistema
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, ctrl.getAll);

module.exports = router;
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/discounts.controller");
const { auth, requireRole, apiLimiter, auditLog, sanitizeParams } = require("../middleware/auth.middleware");

// ===============================
// RUTAS PÚBLICAS
// ===============================

// Obtener descuentos activos (para mostrar en tienda)
router.get("/active",
  sanitizeParams,
  apiLimiter,
  ctrl.getAll
);

// ===============================
// RUTAS PROTEGIDAS (Admin)
// ===============================

// Obtener todos los descuentos
router.get("/",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  apiLimiter,
  ctrl.getAll
);

// Obtener descuento por ID
router.get("/:id",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  apiLimiter,
  ctrl.getById
);

// Crear descuento
router.post("/",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  ctrl.create
);

// Actualizar descuento
router.put("/:id",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  ctrl.update
);

// Activar/Desactivar descuento
router.patch("/:id/toggle",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  ctrl.toggleActive
);

// Eliminar descuento
router.delete("/:id",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  ctrl.remove
);

module.exports = router;
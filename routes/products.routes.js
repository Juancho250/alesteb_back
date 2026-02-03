const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/products.controller");
const upload = require("../middleware/upload.middleware");
const { auth, requireRole, apiLimiter, auditLog, sanitizeParams } = require("../middleware/auth.middleware");

// ===============================
// RUTAS PÚBLICAS
// ===============================

// Obtener todos los productos (catálogo público)
router.get("/",
  sanitizeParams,
  apiLimiter,
  ctrl.getAll
);

// Obtener producto por ID (detalle público)
router.get("/:id",
  sanitizeParams,
  apiLimiter,
  ctrl.getById
);

// ===============================
// RUTAS PROTEGIDAS (Admin)
// ===============================

// Historial de compras del producto
router.get("/:id/purchase-history",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  apiLimiter,
  ctrl.getPurchaseHistory
);

// Crear producto
router.post("/",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  upload.array("images", 10),
  ctrl.create
);

// Actualizar producto
router.put("/:id",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  upload.array("images", 10),
  ctrl.update
);

// Eliminar producto
router.delete("/:id",
  sanitizeParams,
  auth,
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  ctrl.remove
);

module.exports = router;
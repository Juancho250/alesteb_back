const express = require("express");
const router = express.Router();
const bannerController = require("../controllers/banners.controller");
const upload = require("../middleware/upload.middleware");
const { auth, requireRole, apiLimiter, auditLog, sanitizeParams } = require("../middleware/auth.middleware");

// ===============================
// RUTAS PÚBLICAS
// ===============================

// Obtener todos los banners (público)
router.get("/", 
  sanitizeParams,
  apiLimiter,
  bannerController.getAll
);

// Obtener banner por ID (público)
router.get("/:id", 
  sanitizeParams,
  apiLimiter,
  bannerController.getById
);

// ===============================
// RUTAS PROTEGIDAS (Solo Admin)
// ===============================

// Crear banner (solo admin)
router.post("/", 
  sanitizeParams,
  auth, 
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  upload.single("image"), 
  bannerController.create
);

// Actualizar banner (solo admin)
router.put("/:id", 
  sanitizeParams,
  auth, 
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  upload.single("image"), 
  bannerController.update
);

// Activar/Desactivar banner (solo admin)
router.patch("/:id/toggle", 
  sanitizeParams,
  auth, 
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  bannerController.toggleActive
);

// Eliminar banner (solo admin)
router.delete("/:id", 
  sanitizeParams,
  auth, 
  requireRole(['admin', 'super_admin']),
  auditLog,
  apiLimiter,
  bannerController.delete
);

module.exports = router;
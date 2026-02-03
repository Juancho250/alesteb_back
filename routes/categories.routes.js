const express = require("express");
const router = express.Router();
const categoriesController = require("../controllers/categories.controller");
const { auth, requireRole, apiLimiter, auditLog, sanitizeParams } = require("../middleware/auth.middleware");

// ===============================
// RUTAS PÚBLICAS
// ===============================

// Obtener árbol de categorías (para menú de tienda)
router.get("/",
  sanitizeParams,
  apiLimiter,
  categoriesController.getTree
);

// Obtener categoría por slug (para páginas de categoría)
router.get("/slug/:slug",
  sanitizeParams,
  apiLimiter,
  categoriesController.getBySlug
);

// Obtener conteo de productos por categoría (público)
router.get("/product-count",
  sanitizeParams,
  apiLimiter,
  categoriesController.getProductCount
);

// ===============================
// RUTAS PROTEGIDAS (Admin)
// ===============================

// Obtener lista plana (para selectores en admin)
router.get("/flat",
  sanitizeParams,
  auth,
  requireRole(["admin", "super_admin"]),
  apiLimiter,
  categoriesController.getFlatList
);

// Obtener categoría por ID
router.get("/:id",
  sanitizeParams,
  auth,
  requireRole(["admin", "super_admin"]),
  apiLimiter,
  categoriesController.getById
);

// Crear categoría
router.post("/",
  sanitizeParams,
  auth,
  requireRole(["admin", "super_admin"]),
  auditLog,
  apiLimiter,
  categoriesController.create
);

// Actualizar categoría
router.put("/:id",
  sanitizeParams,
  auth,
  requireRole(["admin", "super_admin"]),
  auditLog,
  apiLimiter,
  categoriesController.update
);

// Eliminar categoría
router.delete("/:id",
  sanitizeParams,
  auth,
  requireRole(["admin", "super_admin"]),
  auditLog,
  apiLimiter,
  categoriesController.remove
);

module.exports = router;
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/providers.controller");
const { auth, requireRole, apiLimiter, auditLog, sanitizeParams } = require("../middleware/auth.middleware");

// ===============================
// MIDDLEWARE APLICADO A TODAS LAS RUTAS
// (Todos los endpoints de proveedores requieren autenticación admin)
// ===============================

router.use(auth);
router.use(requireRole(['admin', 'super_admin']));
router.use(sanitizeParams);
router.use(apiLimiter);

// ===============================
// RUTAS DE PROVEEDORES
// ===============================

// Obtener todos los proveedores
router.get("/",
  ctrl.getProviders
);

// Obtener proveedor por ID
router.get("/:id",
  ctrl.getProviderById
);

// Crear proveedor
router.post("/",
  auditLog,
  ctrl.createProvider
);

// Actualizar proveedor
router.put("/:id",
  auditLog,
  ctrl.updateProvider
);

// Eliminar proveedor
router.delete("/:id",
  auditLog,
  ctrl.deleteProvider
);

// ===============================
// RUTAS DE HISTORIAL Y ANÁLISIS
// ===============================

// Historial de compras del proveedor
router.get("/:id/history",
  ctrl.getProviderHistory
);

// Historial de precios de un producto específico del proveedor
router.get("/:provider_id/product/:product_id/prices",
  ctrl.getProductPriceHistory
);

// Estadísticas del proveedor
router.get("/:id/stats",
  ctrl.getProviderStats
);

// Rentabilidad por proveedor
router.get("/:provider_id/profitability",
  ctrl.getProfitByProvider
);

// Comparar proveedores para un producto
router.get("/compare/product/:product_id",
  ctrl.compareProvidersProfit
);

// ===============================
// RUTAS DE PAGOS
// ===============================

// Registrar pago a proveedor
router.post("/payments",
  auditLog,
  ctrl.registerPayment
);

// Historial de pagos de un proveedor
router.get("/:id/payments",
  ctrl.getPaymentHistory
);

module.exports = router;
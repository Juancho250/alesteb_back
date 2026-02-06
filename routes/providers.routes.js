const express = require("express");
const { auth, requirePermission } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/providers.controller");

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(auth);

// Obtener todos los proveedores
router.get("/", 
  requirePermission("providers.view"), 
  ctrl.getAll
);

// Obtener proveedor específico
router.get("/:id", 
  requirePermission("providers.view"), 
  ctrl.getById
);

// Crear proveedor
router.post("/", 
  requirePermission("providers.create"), 
  ctrl.create
);

// Actualizar proveedor
router.put("/:id", 
  requirePermission("providers.edit"), 
  ctrl.update
);

// Eliminar proveedor
router.delete("/:id", 
  requirePermission("providers.delete"), 
  ctrl.remove
);

// === PAGOS ===
router.post("/payments", 
  requirePermission("providers.payments"), 
  ctrl.registerPayment
);

router.get("/:id/payments", 
  requirePermission("providers.view"), 
  ctrl.getPaymentHistory
);

// === HISTORIAL Y REPORTES ===
router.get("/:id/purchases", 
  requirePermission("providers.view"), 
  ctrl.getPurchaseHistory
);

router.get("/price-comparison", 
  requirePermission("providers.view"), 
  ctrl.getPriceComparison
);

router.get("/:id/stats", 
  requirePermission("providers.view"), 
  ctrl.getStats
);

module.exports = router;
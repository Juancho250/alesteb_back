const express = require("express");
const { auth, requirePermission } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/purchase_orders.controller");

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(auth);

// Ver órdenes de compra
router.get("/", 
  requirePermission("purchase_orders.view"), 
  ctrl.getAll
);

// Obtener orden específica
router.get("/:id", 
  requirePermission("purchase_orders.view"), 
  ctrl.getById
);

// Crear orden de compra
router.post("/", 
  requirePermission("purchase_orders.create"), 
  ctrl.create
);

// Actualizar orden (solo borradores y pendientes)
router.put("/:id", 
  requirePermission("purchase_orders.edit"), 
  ctrl.update
);

// Aprobar orden
router.post("/:id/approve", 
  requirePermission("purchase_orders.approve"), 
  ctrl.approve
);

// Recibir orden (actualiza inventario)
router.post("/:id/receive", 
  requirePermission("purchase_orders.receive"), 
  ctrl.receive
);

// Cancelar orden
router.post("/:id/cancel", 
  requirePermission("purchase_orders.edit"), 
  ctrl.cancel
);

// Eliminar orden (solo borradores)
router.delete("/:id", 
  requirePermission("purchase_orders.delete"), 
  ctrl.remove
);

// === REPORTES ===
router.get("/reports/profit-analysis", 
  requirePermission("purchase_orders.view"), 
  ctrl.getProfitAnalysis
);

router.get("/reports/top-products", 
  requirePermission("purchase_orders.view"), 
  ctrl.getTopProducts
);

router.get("/products/:product_id/price-comparison", 
  requirePermission("purchase_orders.view"), 
  ctrl.getPriceComparison
);

module.exports = router;
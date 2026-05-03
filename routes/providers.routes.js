const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/providers.controller");

const router = express.Router();

// ============================================================
// RUTAS DE PROVEEDORES
// Regla: rutas estáticas SIEMPRE antes de /:id
// ============================================================

// ── Colección (sin parámetro :id) ──────────────────────────
router.get   ("/",                auth, requireManager, ctrl.getAll);
router.post  ("/",                auth, requireManager, ctrl.create);
router.post  ("/payments",        auth, requireManager, ctrl.registerPayment);
router.get   ("/price-comparison",auth, requireManager, ctrl.getPriceComparison);

// ── Recurso por ID ──────────────────────────────────────────
router.get   ("/:id",             auth, requireManager, ctrl.getById);
router.put   ("/:id",             auth, requireManager, ctrl.update);
router.delete("/:id",             auth, requireManager, ctrl.remove);
router.patch ("/:id/toggle-active", auth, requireManager, ctrl.toggleActive);

// ── Sub-recursos de un proveedor concreto ──────────────────
router.get   ("/:id/payments",    auth, requireManager, ctrl.getPaymentHistory);
router.get   ("/:id/purchases",   auth, requireManager, ctrl.getPurchaseHistory);
router.get   ("/:id/stats",       auth, requireManager, ctrl.getStats);

module.exports = router;
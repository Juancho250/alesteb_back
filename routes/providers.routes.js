const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/providers.controller");

const router = express.Router();

// ============================================
// 📦 RUTAS DE PROVEEDORES
// ============================================

/**
 * @route   GET /api/providers
 * @desc    Obtener todos los proveedores
 * @access  Private (Admin y Gerente)
 */
router.get("/", auth, requireManager, ctrl.getAll);

// ============================================
// ✅ CORRECCIÓN BUG #4: Rutas estáticas ANTES de /:id
//
// El orden anterior era:
//   GET /:id          ← capturaba "price-comparison" como id="price-comparison"
//   GET /price-comparison  ← nunca se alcanzaba
//
// Express evalúa las rutas en orden de declaración. Cualquier ruta
// con segmento estático (/payments, /price-comparison) debe declararse
// ANTES de la ruta dinámica (/:id), o Express la tratará como un parámetro.
// ============================================

// ── Rutas estáticas de colección (sin :id) ───────────────────────
router.post("/payments",          auth, requireManager, ctrl.registerPayment);
router.get ("/price-comparison",  auth, requireManager, ctrl.getPriceComparison);

// ── Rutas dinámicas con :id ──────────────────────────────────────
/**
 * @route   GET /api/providers/:id
 * @desc    Obtener proveedor específico
 * @access  Private (Admin y Gerente)
 */
router.get("/:id",           auth, requireManager, ctrl.getById);

/**
 * @route   POST /api/providers
 * @desc    Crear nuevo proveedor
 * @access  Private (Admin y Gerente)
 */
router.post("/",             auth, requireManager, ctrl.create);

/**
 * @route   PUT /api/providers/:id
 * @desc    Actualizar proveedor
 * @access  Private (Admin y Gerente)
 */
router.put("/:id",           auth, requireManager, ctrl.update);

/**
 * @route   DELETE /api/providers/:id
 * @desc    Eliminar proveedor
 * @access  Private (Admin y Gerente)
 */
router.delete("/:id",        auth, requireManager, ctrl.remove);

// ── Sub-recursos de un proveedor concreto ───────────────────────
router.get("/:id/payments",  auth, requireManager, ctrl.getPaymentHistory);
router.get("/:id/purchases", auth, requireManager, ctrl.getPurchaseHistory);
router.get("/:id/stats",     auth, requireManager, ctrl.getStats);

module.exports = router;
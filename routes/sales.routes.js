const express = require("express");
const router = express.Router();

const {
  createSale,
  getSales,
  getSaleById,
  getUserSales,
  getUserStats,
  updatePaymentStatus,
} = require("../controllers/sales.controller");

const {
  auth,
  isAdmin,
  checkOwnership,
  sanitizeParams,
  allowFields,
  strictApiLimiter,
} = require("../middleware/auth.middleware");

// ─── Sanitizar params en todas las rutas de este router ──────────
router.use(sanitizeParams);

// ═══════════════════════════════════════════════════════════════════
// RUTAS DEL USUARIO / CLIENTE
// Requieren autenticación. El controlador verifica ownership en
// segundo nivel (defensa en profundidad).
// ═══════════════════════════════════════════════════════════════════

// GET /api/sales/user/history?userId=X
router.get("/user/history", auth, getUserSales);

// GET /api/sales/user/stats?userId=X
router.get("/user/stats", auth, getUserStats);

// ═══════════════════════════════════════════════════════════════════
// CREAR VENTA
// Cualquier usuario autenticado puede crear su propia venta (online).
// El controlador verifica que customer_id === req.user.id si no es admin.
// ═══════════════════════════════════════════════════════════════════

// POST /api/sales
router.post(
  "/",
  auth,
  strictApiLimiter,                                            // máximo 10 ventas/min por IP
  allowFields(["items", "total", "sale_type", "customer_id"]), // prevenir mass-assignment
  createSale
);

// ═══════════════════════════════════════════════════════════════════
// RUTAS ADMIN
// ═══════════════════════════════════════════════════════════════════

// GET /api/sales  — lista total de ventas (solo admin)
router.get("/", auth, isAdmin, getSales);

// GET /api/sales/:id  — detalle de una venta
// Un usuario normal solo puede ver sus propias ventas.
// Un admin puede ver cualquiera.
router.get("/:id", auth, checkOwnership("sale"), getSaleById);

// PATCH /api/sales/:id/payment-status  — confirmar/cancelar pago (solo admin)
router.patch(
  "/:id/payment-status",
  auth,
  isAdmin,
  allowFields(["payment_status"]),
  updatePaymentStatus
);

module.exports = router;
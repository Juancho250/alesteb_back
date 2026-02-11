const express = require("express");
const router = express.Router();
const salesController = require("../controllers/salesController");
const { verifyToken } = require("../middleware/authMiddleware");

// ============================================
// 📦 RUTAS PARA CLIENTES (sus propios pedidos)
// ============================================

// Obtener historial de pedidos del usuario
// GET /api/sales/user/history?userId=123
router.get("/user/history", verifyToken, salesController.getUserOrderHistory);

// Obtener estadísticas del usuario
// GET /api/sales/user/stats?userId=123
router.get("/user/stats", verifyToken, salesController.getUserStats);

// Obtener detalle de un pedido específico (con items)
// GET /api/sales/123
router.get("/:id", verifyToken, salesController.getOrderDetail);

// ============================================
// 🛒 CREAR PEDIDO (CHECKOUT)
// ============================================

// Crear nuevo pedido (cliente hace checkout)
// POST /api/sales/checkout
router.post("/checkout", verifyToken, salesController.createOrder);

// ============================================
// ❌ CANCELAR PEDIDO
// ============================================

// Cancelar pedido (solo si está pending)
// POST /api/sales/123/cancel
router.post("/:id/cancel", verifyToken, salesController.cancelOrder);

module.exports = router;
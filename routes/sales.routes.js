const express = require("express");
const router = express.Router();
const salesController = require("../controllers/salesController");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ============================================
// 📦 RUTAS PARA CLIENTES (sus propios pedidos)
// ============================================

/**
 * @route   GET /api/sales/user/history
 * @desc    Obtener historial de pedidos del usuario
 * @query   userId - ID del usuario
 * @access  Private (Cliente autenticado)
 */
router.get("/user/history", auth, salesController.getUserOrderHistory);

/**
 * @route   GET /api/sales/user/stats
 * @desc    Obtener estadísticas del usuario
 * @query   userId - ID del usuario
 * @access  Private (Cliente autenticado)
 */
router.get("/user/stats", auth, salesController.getUserStats);

/**
 * @route   GET /api/sales/:id
 * @desc    Obtener detalle de un pedido específico (con items)
 * @params  id - ID del pedido
 * @access  Private (Cliente autenticado)
 */
router.get("/:id", auth, salesController.getOrderDetail);

// ============================================
// 🛒 CREAR PEDIDO (CHECKOUT)
// ============================================

/**
 * @route   POST /api/sales/checkout
 * @desc    Crear nuevo pedido (cliente hace checkout)
 * @body    { customer_id, items, payment_method, discount_amount, tax_amount }
 * @access  Private (Cliente autenticado)
 * @note    ✅ Genera asientos automáticos: reduce inventario, calcula COGS
 */
router.post("/checkout", auth, salesController.createOrder);

// ============================================
// ❌ CANCELAR PEDIDO
// ============================================

/**
 * @route   POST /api/sales/:id/cancel
 * @desc    Cancelar pedido (solo si está pending)
 * @params  id - ID del pedido
 * @body    { user_id }
 * @access  Private (Cliente autenticado)
 * @note    ✅ Restaura inventario automáticamente
 */
router.post("/:id/cancel", auth, salesController.cancelOrder);

// ============================================
// 💰 CONFIRMAR PAGO (Admin/Gerente)
// ============================================

/**
 * @route   POST /api/sales/:id/confirm-payment
 * @desc    Confirmar pago de un pedido
 * @params  id - ID del pedido
 * @body    { payment_method }
 * @access  Private (Admin, Gerente)
 * @note    ✅ Genera asientos: Ingresos ↑, Impuestos ↑, AR ↓, Banco ↑
 */
router.post("/:id/confirm-payment", auth, requireManager, salesController.confirmPayment);

module.exports = router;
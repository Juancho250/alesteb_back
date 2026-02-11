const express = require("express");
const router  = express.Router();

// ⚠️  Ajusta el nombre del archivo a como lo tengas en disco:
//     salesController.js  →  require("../controllers/salesController")
//     sales.controller.js →  require("../controllers/sales.controller")
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

// ============================================
// 🛒 CREAR PEDIDO (CHECKOUT)
// ============================================

/**
 * @route   POST /api/sales          ← ruta que llama CartFloating
 * @route   POST /api/sales/checkout ← alias legacy
 * @desc    Crear nuevo pedido online
 * @body    { customer_id, items, payment_method, shipping_address, shipping_city, shipping_notes }
 * @access  Private (Cliente autenticado)
 * @note    Reduce inventario, envía email de confirmación
 */
router.post("/",        auth, salesController.createOrder);   // ← CartFloating usa esta
router.post("/checkout", auth, salesController.createOrder);  // ← alias por compatibilidad

// ============================================
// ❌ CANCELAR PEDIDO
// ============================================

/**
 * @route   POST /api/sales/:id/cancel
 * @desc    Cancelar pedido pendiente
 * @params  id - ID del pedido
 * @body    { user_id }
 * @access  Private (Cliente autenticado)
 * @note    Restaura inventario automáticamente
 */
router.post("/:id/cancel", auth, salesController.cancelOrder);

// ============================================
// 💰 CONFIRMAR PAGO (Admin/Gerente)
// ============================================

/**
 * @route   POST /api/sales/:id/confirm-payment
 * @desc    Confirmar pago de un pedido pendiente
 * @params  id - ID del pedido
 * @body    { payment_method }
 * @access  Private (Admin, Gerente)
 */
router.post("/:id/confirm-payment", auth, requireManager, salesController.confirmPayment);

// ============================================
// 📄 DETALLE DE PEDIDO
// ============================================

/**
 * @route   GET /api/sales/:id
 * @desc    Obtener items de un pedido específico
 * @params  id - ID del pedido
 * @access  Private (Cliente autenticado)
 * @note    Esta ruta debe ir AL FINAL para no capturar /user/history, /user/stats, /checkout
 */
router.get("/:id", auth, salesController.getOrderDetail);

module.exports = router;
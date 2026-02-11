const express = require("express");
const router  = express.Router();

const salesController = require("../controllers/sales.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ============================================
// 📋 LISTAR TODAS LAS VENTAS (HISTORIAL)
// ============================================

/**
 * @route   GET /api/sales
 * @desc    Obtener todas las ventas (admin/gerente) o solo las del usuario
 * @access  Private (Requiere autenticación)
 * @note    ⚠️ ESTA RUTA DEBE IR PRIMERO para no ser capturada por /:id
 */
router.get("/", auth, salesController.getAllSales);

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
 * @route   POST /api/sales
 * @route   POST /api/sales/checkout
 * @desc    Crear nuevo pedido online o venta física
 * @body    { customer_id, items, payment_method, sale_type, shipping_address, shipping_city, shipping_notes }
 * @access  Private (Cliente autenticado)
 * @note    Reduce inventario, envía email de confirmación para online
 */
router.post("/",        auth, salesController.createOrder);
router.post("/checkout", auth, salesController.createOrder);

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
 * @note    ⚠️ Esta ruta debe ir AL FINAL para no capturar /user/history, /user/stats, etc.
 */
router.get("/:id", auth, salesController.getOrderDetail);

module.exports = router;
const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/accounting.controller");

const router = express.Router();

// ============================================
// 📊 CONTABILIDAD / P&L
// ============================================

/**
 * @route   GET /api/accounting/summary
 * @desc    Resumen general P&L (ingresos, costos, utilidad, márgenes)
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * @access  Admin, Gerente
 */
router.get("/summary", auth, requireManager, ctrl.getSummary);

/**
 * @route   GET /api/accounting/cashflow
 * @desc    Flujo de ingresos vs costos por mes (últimos 6 meses)
 * @access  Admin, Gerente
 */
router.get("/cashflow", auth, requireManager, ctrl.getCashflow);

/**
 * @route   GET /api/accounting/profit-by-product
 * @desc    Rentabilidad por producto (costo, precio, margen, utilidad realizada)
 * @query   ?limit=100
 * @access  Admin, Gerente
 */
router.get("/profit-by-product", auth, requireManager, ctrl.getProfitByProduct);

/**
 * @route   POST /api/accounting/register-purchase
 * @desc    Registrar una compra rápida (actualiza stock, costo y precio del producto)
 * @body    { product_id, provider_id, quantity, unit_cost, sale_price, payment_method }
 * @access  Admin, Gerente
 */
router.post("/register-purchase", auth, requireManager, ctrl.registerPurchase);

/**
 * @route   GET /api/accounting/purchases
 * @desc    Historial de compras con márgenes esperados
 * @query   ?limit=50&offset=0
 * @access  Admin, Gerente
 */
router.get("/purchases", auth, requireManager, ctrl.getPurchaseHistory);

/**
 * @route   GET /api/accounting/expenses
 * @desc    Desglose de gastos operativos por categoría
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * @access  Admin, Gerente
 */
router.get("/expenses", auth, requireManager, ctrl.getExpensesBreakdown);

/**
 * @route   GET /api/accounting/provider-debts
 * @desc    Estado de deuda con cada proveedor activo
 * @access  Admin, Gerente
 */
router.get("/provider-debts", auth, requireManager, ctrl.getProviderDebts);

module.exports = router;
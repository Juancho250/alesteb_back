const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/finance.controller");

const router = express.Router();

// ============================================
// 💰 FINANZAS - RUTAS UNIFICADAS
// ============================================

/**
 * @route   GET /api/finance/summary
 * @desc    Dashboard principal - Resumen P&L completo
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * @access  Admin, Gerente
 */
router.get("/summary", auth, requireManager, ctrl.getSummary);

/**
 * @route   GET /api/finance/cashflow
 * @desc    Flujo de caja mensual (últimos 6 meses)
 * @access  Admin, Gerente
 */
router.get("/cashflow", auth, requireManager, ctrl.getCashflow);

/**
 * @route   GET /api/finance/expenses
 * @desc    Historial de todos los movimientos (gastos + compras)
 * @query   ?limit=100&offset=0&type=purchase|service|utility|tax|salary|other
 * @access  Admin, Gerente
 */
router.get("/expenses", auth, requireManager, ctrl.getExpenses);

/**
 * @route   GET /api/finance/expenses/by-category
 * @desc    Gastos agrupados por categoría (para gráficas)
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * @access  Admin, Gerente
 */
router.get("/expenses/by-category", auth, requireManager, ctrl.getExpensesByCategory);

/**
 * @route   POST /api/finance/expenses
 * @desc    Registrar un nuevo gasto o compra
 * @body    { expense_type, category, amount, description, product_id, quantity, provider_id, utility_type, utility_value, payment_method }
 * @access  Admin, Gerente
 */
router.post("/expenses", auth, requireManager, ctrl.createExpense);

/**
 * @route   GET /api/finance/profit-by-product
 * @desc    Rentabilidad por producto
 * @query   ?limit=100
 * @access  Admin, Gerente
 */
router.get("/profit-by-product", auth, requireManager, ctrl.getProfitByProduct);

/**
 * @route   GET /api/finance/provider-debts
 * @desc    Estado de deuda con proveedores activos
 * @access  Admin, Gerente
 */
router.get("/provider-debts", auth, requireManager, ctrl.getProviderDebts);

/**
 * @route   GET /api/finance/provider-analysis
 * @desc    Análisis de compras por proveedor (para gráficas)
 * @access  Admin, Gerente
 */
router.get("/provider-analysis", auth, requireManager, ctrl.getProviderAnalysis);

module.exports = router;
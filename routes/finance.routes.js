const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/finance.controller");

const router = express.Router();

// ============================================
// 📚 LIBRO MAYOR GENERAL (GL)
// ============================================

/**
 * @route   GET /api/finance/general-ledger
 * @desc    Libro Mayor General - Vista completa del ERP
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * @access  Admin, Gerente
 * @returns Balance General + Estado de Resultados + Métricas
 */
router.get("/general-ledger", auth, requireManager, ctrl.getGeneralLedger);

/**
 * @route   GET /api/finance/profit-and-loss
 * @desc    Estado de Resultados detallado (P&L)
 * @query   ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 * @access  Admin, Gerente
 */
router.get("/profit-and-loss", auth, requireManager, ctrl.getProfitAndLoss);

// ============================================
// 💰 CUENTAS POR COBRAR (AR)
// ============================================

/**
 * @route   GET /api/finance/accounts-receivable
 * @desc    Cuentas por cobrar - Facturas pendientes de clientes
 * @access  Admin, Gerente
 * @returns Lista de ventas pending + resumen de aging
 */
router.get("/accounts-receivable", auth, requireManager, ctrl.getAccountsReceivable);

// ============================================
// 🏦 CUENTAS POR PAGAR (AP)
// ============================================

/**
 * @route   GET /api/finance/accounts-payable
 * @desc    Cuentas por pagar - Deudas con proveedores
 * @access  Admin, Gerente
 * @returns Lista de proveedores con balance + resumen
 */
router.get("/accounts-payable", auth, requireManager, ctrl.getAccountsPayable);

// ============================================
// 📈 FLUJO DE CAJA
// ============================================

/**
 * @route   GET /api/finance/cashflow
 * @desc    Flujo de caja mensual (últimos 6 meses)
 * @access  Admin, Gerente
 */
router.get("/cashflow", auth, requireManager, ctrl.getCashflow);

// ============================================
// 💸 GASTOS Y COMPRAS
// ============================================

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
 * @note    ✅ Genera asientos automáticos en GL, actualiza inventario y AP
 */
router.post("/expenses", auth, requireManager, ctrl.createExpense);

// ============================================
// 📊 ANÁLISIS Y REPORTES
// ============================================

/**
 * @route   GET /api/finance/profit-by-product
 * @desc    Rentabilidad por producto
 * @query   ?limit=100
 * @access  Admin, Gerente
 */
router.get("/profit-by-product", auth, requireManager, ctrl.getProfitByProduct);

/**
 * @route   GET /api/finance/provider-analysis
 * @desc    Análisis de compras por proveedor (para gráficas)
 * @access  Admin, Gerente
 */
router.get("/provider-analysis", auth, requireManager, ctrl.getProviderAnalysis);

module.exports = router;
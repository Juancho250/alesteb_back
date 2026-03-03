const express = require("express");
const router = express.Router();
const fc = require("../controllers/finance.controller");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ── Middleware global ────────────────────────────────────────────
router.use(auth, requireManager);

// ============================================
// 📊 RESUMEN Y REPORTES
// ============================================
router.get("/summary",           fc.getSummary);
router.get("/cashflow",          fc.getCashflow);
router.get("/profit-by-product", fc.getProfitByProduct);
router.get("/provider-debts",    fc.getProviderDebts);
router.get("/provider-analysis", fc.getProviderAnalysis);

// ============================================
// 📄 FACTURAS
// ============================================

/**
 * GET  /api/finance/invoices
 * @query type       'service' | 'purchase'
 * @query status     'paid' | 'pending' | 'partial'
 * @query start_date, end_date
 * @query limit, offset
 */
router.get("/invoices",      fc.getInvoices);

/**
 * POST /api/finance/invoices
 * @body invoice_type   'service' | 'purchase'
 * @body provider_id    number  (requerido para compras)
 * @body invoice_number string  (opcional)
 * @body invoice_date   date
 * @body due_date       date    (opcional)
 * @body description    string
 * @body total_amount   number
 * @body payment_method 'cash' | 'credit' | 'transfer' | 'check'
 * @body items          [{ product_id, quantity, unit_price }]  (solo compras)
 * @body notes          string  (opcional)
 *
 * - payment_method='credit' queda como deuda pendiente
 * - Compras actualizan stock y purchase_price del producto
 * - Compras registran historial de precios si el precio cambia
 */
router.post("/invoices",     fc.createInvoice);

/**
 * POST /api/finance/invoices/pay
 * @body invoice_id     number
 * @body amount         number
 * @body payment_method string
 * @body payment_date   date    (opcional)
 * @body notes          string  (opcional)
 */
router.post("/invoices/pay", fc.payInvoice);

// ============================================
// 💸 GASTOS DIRECTOS
// ============================================

/**
 * GET  /api/finance/expenses
 * @query type       expense_type enum
 * @query start_date, end_date
 * @query limit, offset
 */
router.get("/expenses",             fc.getExpenses);

/**
 * GET  /api/finance/expenses/by-category
 * Agrupa gastos de los últimos 3 meses por categoría
 */
router.get("/expenses/by-category", fc.getExpensesByCategory);

/**
 * POST /api/finance/expenses
 * @body expense_type   'purchase'|'service'|'utility'|'tax'|'salary'|'other'
 * @body category       string  (opcional)
 * @body description    string
 * @body amount         number
 * @body payment_method 'cash' | 'credit' | 'transfer' | 'check'
 * @body provider_id    number  (opcional)
 * @body product_id     number  (opcional, si expense_type='purchase')
 * @body quantity       number  (opcional, default 1)
 * @body notes          string  (opcional)
 * @body expense_date   date    (opcional, default hoy)
 *
 * - Si expense_type='purchase' y product_id existe, actualiza stock y precio
 */
router.post("/expenses",            fc.createExpense);

module.exports = router;
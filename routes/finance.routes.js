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
router.get("/invoices",           fc.getInvoices);
router.post("/invoices",          fc.createInvoice);
router.post("/invoices/pay",      fc.payInvoice);

// ============================================
// 💳 PAGO DIRECTO A PROVEEDOR  ← NUEVO
// ============================================
/**
 * POST /api/finance/provider-payment
 * @body provider_id     number
 * @body amount          number
 * @body payment_method  'transfer' | 'cash' | 'check'
 * @body notes           string (opcional)
 *
 * - Valida que el monto no supere el balance actual
 * - Registra en provider_payments
 * - Reduce el balance del proveedor
 */
router.post("/provider-payment",  fc.payProvider);

// ============================================
// 💸 GASTOS DIRECTOS
// ============================================
router.get("/expenses",             fc.getExpenses);
router.get("/expenses/by-category", fc.getExpensesByCategory);
router.post("/expenses",            fc.createExpense);

module.exports = router;
const express = require("express");
const router  = express.Router();
const fc      = require("../controllers/financeController");
const { auth, requireManager } = require("../middleware/auth.middleware");

// ── Resumen unificado (KPIs del dashboard) ──────────────────────────
router.get("/summary",                auth, requireManager, fc.getSummary);

// ── Flujo de caja ───────────────────────────────────────────────────
router.get("/cashflow",               auth, requireManager, fc.getCashflow);

// ── Gastos ──────────────────────────────────────────────────────────
router.get("/expenses",               auth, requireManager, fc.getExpenses);
router.get("/expenses/by-category",   auth, requireManager, fc.getExpensesByCategory);
router.post("/expenses",              auth, requireManager, fc.createExpense);

// ── Rentabilidad ────────────────────────────────────────────────────
router.get("/profit-by-product",      auth, requireManager, fc.getProfitByProduct);
router.get("/profit-and-loss",        auth, requireManager, fc.getProfitAndLoss);

// ── Deudas / proveedores ────────────────────────────────────────────
router.get("/provider-debts",         auth, requireManager, fc.getProviderDebts);      // ← antes faltaba
router.get("/provider-analysis",      auth, requireManager, fc.getProviderAnalysis);
router.post("/provider-payment",      auth, requireManager, fc.registerPayment);

// ── Cuentas por cobrar ──────────────────────────────────────────────
router.get("/accounts-receivable",    auth, requireManager, fc.getAccountsReceivable);

// ── Alias de compatibilidad (libro mayor legacy) ─────────────────────
router.get("/general-ledger",         auth, requireManager, fc.getGeneralLedger);

module.exports = router;
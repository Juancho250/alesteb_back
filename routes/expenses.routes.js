const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenses.controller');

// ⚠️ ORDEN CRÍTICO: Rutas específicas PRIMERO

// === RUTAS DE ANÁLISIS Y RESUMEN ===
router.get('/expenses/summary', expenseController.getFinanceSummary);
router.get('/expenses/product-profitability', expenseController.getProductProfitability);
router.get('/expenses/provider-profitability', expenseController.getProviderProfitability);
router.get('/expenses/provider-payments', expenseController.getProviderPayments);

// === PURCHASE ORDERS ===
router.get('/expenses/purchase-orders/:id', expenseController.getPurchaseOrderDetails);
router.get('/expenses/purchase-orders', expenseController.getPurchaseOrders);
router.post('/expenses/purchase-orders', expenseController.createPurchaseOrder);

// === PROVIDER PAYMENTS ===
router.post('/expenses/provider-payments', expenseController.recordProviderPayment);

// === RUTAS GENERALES (AL FINAL) ===
router.get('/expenses', expenseController.getExpenses);
router.post('/expenses', expenseController.createExpense);

module.exports = router;
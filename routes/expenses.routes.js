const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenses.controller');

// ⚠️ ORDEN CRÍTICO: Las rutas específicas PRIMERO, las dinámicas DESPUÉS

// 1. RUTAS ESPECÍFICAS (deben ir primero)
router.get('/expenses/summary', expenseController.getFinanceSummary);
router.get('/expenses/product-profitability', expenseController.getProductProfitability);
router.get('/expenses/provider-profitability', expenseController.getProviderProfitability);
router.get('/expenses/provider-payments', expenseController.getProviderPayments);

// 2. PURCHASE ORDERS - RUTAS ESPECÍFICAS
router.post('/expenses/purchase-orders', expenseController.createPurchaseOrder);
router.get('/expenses/purchase-orders', expenseController.getPurchaseOrders);
router.get('/expenses/purchase-orders/:id', expenseController.getPurchaseOrderDetails);
router.post('/expenses/provider-payments', expenseController.recordProviderPayment);

// 3. RUTAS GENERALES (al final)
router.get('/expenses', expenseController.getExpenses);
router.post('/expenses', expenseController.createExpense);

module.exports = router;
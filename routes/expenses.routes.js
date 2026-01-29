const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenses.controller');

// Rutas existentes (NO las borres)
router.get('/expenses', expenseController.getExpenses);
router.post('/expenses', expenseController.createExpense);
router.get('/expenses/summary', expenseController.getFinanceSummary);

// ✨ NUEVAS RUTAS - Agregar estas
router.post('/expenses/purchase-orders', expenseController.createPurchaseOrder);
router.get('/expenses/purchase-orders', expenseController.getPurchaseOrders);
router.get('/expenses/purchase-orders/:id', expenseController.getPurchaseOrderDetails);
router.get('/expenses/product-profitability', expenseController.getProductProfitability);
router.get('/expenses/provider-profitability', expenseController.getProviderProfitability);
router.post('/expenses/provider-payments', expenseController.recordProviderPayment);
router.get('/expenses/provider-payments', expenseController.getProviderPayments);

module.exports = router;
const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');

// Gastos básicos
router.get('/expenses', expenseController.getExpenses);
router.post('/expenses', expenseController.createExpense);
router.get('/expenses/summary', expenseController.getFinanceSummary);

// Órdenes de Compra
router.post('/expenses/purchase-orders', expenseController.createPurchaseOrder);
router.get('/expenses/purchase-orders', expenseController.getPurchaseOrders);
router.get('/expenses/purchase-orders/:id', expenseController.getPurchaseOrderDetails);

// Análisis de Rentabilidad
router.get('/expenses/product-profitability', expenseController.getProductProfitability);
router.get('/expenses/provider-profitability', expenseController.getProviderProfitability);

// Pagos a Proveedores
router.post('/expenses/provider-payments', expenseController.recordProviderPayment);
router.get('/expenses/provider-payments', expenseController.getProviderPayments);

module.exports = router;
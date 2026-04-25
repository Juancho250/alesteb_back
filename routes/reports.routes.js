// routes/reports.routes.js
const express = require('express');
const router  = express.Router();
const {
  getReportSummary,
  getSalesOverTime,
  getTopProducts,
  getSalesByPaymentMethod,
  getExpensesBreakdown,
  getInventoryReport,
  getTopCustomers,
  getCashflow,
  getProvidersReport,
  getProfitByCategory,
} = require('../controllers/reports.controller');
const { auth } = require('../middleware/auth.middleware');

router.get('/summary',             auth, getReportSummary);
router.get('/sales-over-time',     auth, getSalesOverTime);
router.get('/top-products',        auth, getTopProducts);
router.get('/payment-methods',     auth, getSalesByPaymentMethod);
router.get('/expenses',            auth, getExpensesBreakdown);
router.get('/inventory',           auth, getInventoryReport);
router.get('/top-customers',       auth, getTopCustomers);
router.get('/cashflow',            auth, getCashflow);
router.get('/providers',           auth, getProvidersReport);
router.get('/profit-by-category',  auth, getProfitByCategory);

module.exports = router;
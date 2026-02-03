const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenses.controller');
const { auth, requireRole, apiLimiter, auditLog, sanitizeParams } = require('../middleware/auth.middleware');

// ===============================
// MIDDLEWARE APLICADO A TODAS LAS RUTAS
// ===============================

// Todas las rutas de expenses requieren autenticación de admin
router.use(auth);
router.use(requireRole(['admin', 'super_admin']));
router.use(sanitizeParams);
router.use(apiLimiter);

// ===============================
// RUTAS DE ANÁLISIS Y RESUMEN
// (Rutas específicas PRIMERO)
// ===============================

router.get('/expenses/summary', 
  expenseController.getFinanceSummary
);

router.get('/expenses/product-profitability', 
  expenseController.getProductProfitability
);

router.get('/expenses/provider-profitability', 
  expenseController.getProviderProfitability
);

router.get('/expenses/provider-payments', 
  expenseController.getProviderPayments
);

// ===============================
// PURCHASE ORDERS
// ===============================

// Detalle de orden específica (ANTES de la ruta general)
router.get('/expenses/purchase-orders/:id', 
  expenseController.getPurchaseOrderDetails
);

// Lista de órdenes
router.get('/expenses/purchase-orders', 
  expenseController.getPurchaseOrders
);

// Crear orden de compra
router.post('/expenses/purchase-orders', 
  auditLog,
  expenseController.createPurchaseOrder
);

// ===============================
// PROVIDER PAYMENTS
// ===============================

router.post('/expenses/provider-payments', 
  auditLog,
  expenseController.recordProviderPayment
);

// ===============================
// RUTAS GENERALES DE GASTOS
// (AL FINAL para evitar conflictos)
// ===============================

router.get('/expenses', 
  expenseController.getExpenses
);

router.post('/expenses', 
  auditLog,
  expenseController.createExpense
);

module.exports = router;
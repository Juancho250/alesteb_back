// routes/subscription.routes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/subscription.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { adminScope } = require('../middleware/adminScope');
const { requireRole } = require('../middleware/auth.middleware'); // ajusta al tuyo

// ────────────────────────────────────────────────
// PÚBLICO (sin auth requerida)
// ────────────────────────────────────────────────
router.get('/plans', ctrl.getPublicPlans);
router.post('/coupons/validate', ctrl.validateCoupon);

// ────────────────────────────────────────────────
// AUTENTICADO: cualquier admin
// ────────────────────────────────────────────────
router.use(authenticate);

router.get('/me',           ctrl.getMySubscription);
router.get('/me/invoices',  ctrl.getMyInvoices);
router.post('/cancel',      ctrl.cancelSubscription);
router.post('/reactivate',  ctrl.reactivateSubscription);
router.post('/change-plan', ctrl.changePlan);

// ────────────────────────────────────────────────
// SUPERADMIN: gestión global
// ────────────────────────────────────────────────
// Cambia 'superadmin' al nombre de rol que uses en tu sistema
router.use(requireRole('superadmin'));

router.get('/admin/all',          ctrl.getAllSubscriptions);
router.get('/admin/stats',        ctrl.getSubscriptionStats);
router.post('/admin/assign',      ctrl.assignSubscription);
router.get('/admin/coupons',      ctrl.getCoupons);
router.post('/admin/coupons',     ctrl.createCoupon);
router.patch('/admin/plans/:id',  ctrl.updatePlan);

module.exports = router;

// ────────────────────────────────────────────────
// USO DEL MIDDLEWARE EN OTRAS RUTAS (ejemplo)
// ────────────────────────────────────────────────
/*
  En app.js / index.js, importa y aplica el middleware globalmente
  o por módulo:

  const { attachSubscription, requireActiveSubscription,
          requireFeature, requireLimit, syncUsageAfter } =
    require('./middleware/subscription.middleware');

  // Aplicar a todas las rutas de admin:
  app.use('/api', authenticate, attachSubscription);

  // En products.routes.js:
  router.post('/', requireActiveSubscription, requireLimit('products'), createProduct, syncUsageAfter);
  router.delete('/:id', requireActiveSubscription, deleteProduct, syncUsageAfter);

  // En agent.routes.js:
  router.post('/chat', requireActiveSubscription, requireFeature('ai_agent'), agentChat);

  // En analytics.routes.js:
  router.get('/dashboard', requireActiveSubscription, requireFeature('analytics'), getAnalytics);

  // En apikeys.routes.js:
  router.post('/', requireActiveSubscription, requireFeature('api_access'), requireLimit('api_keys'), createApiKey, syncUsageAfter);

  // En users.routes.js (crear sub-usuarios):
  router.post('/', requireActiveSubscription, requireLimit('users'), createUser, syncUsageAfter);

  // En categories.routes.js:
  router.post('/', requireActiveSubscription, requireLimit('categories'), createCategory, syncUsageAfter);

  // En providers.routes.js:
  router.post('/', requireActiveSubscription, requireLimit('providers'), createProvider, syncUsageAfter);

  // En banners.routes.js:
  router.post('/', requireActiveSubscription, requireLimit('banners'), createBanner, syncUsageAfter);

  // En finance.routes.js:
  router.get('/', requireActiveSubscription, requireFeature('financial_reports'), getFinance);

  // En products.routes.js (purchase orders):
  router.post('/purchase-orders', requireActiveSubscription, requireFeature('purchase_orders'), createPO);
*/
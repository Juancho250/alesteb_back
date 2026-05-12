// routes/subscription.routes.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/subscription.controller');
const { auth, requireRole }  = require('../middleware/auth.middleware');
const { adminScope }         = require('../middleware/adminScope');

// ─────────────────────────────────────────────────────────────────
// PÚBLICO — sin auth
// ─────────────────────────────────────────────────────────────────
router.get('/plans',             ctrl.getPublicPlans);
router.post('/coupons/validate', ctrl.validateCoupon);

// ─────────────────────────────────────────────────────────────────
// AUTENTICADO — cualquier rol del panel
// ─────────────────────────────────────────────────────────────────
router.use(auth);
router.use(adminScope);

router.get ('/me',           ctrl.getMySubscription);
router.get ('/me/invoices',  ctrl.getMyInvoices);
router.post('/cancel',       ctrl.cancelSubscription);
router.post('/reactivate',   ctrl.reactivateSubscription);
router.post('/change-plan',  ctrl.changePlan);

// ─────────────────────────────────────────────────────────────────
// SUPERADMIN — gestión global
// ─────────────────────────────────────────────────────────────────
router.use(requireRole(['superadmin']));

router.get  ('/admin/all',         ctrl.getAllSubscriptions);
router.get  ('/admin/stats',       ctrl.getSubscriptionStats);
router.post ('/admin/assign',      ctrl.assignSubscription);
router.get  ('/admin/coupons',     ctrl.getCoupons);
router.post ('/admin/coupons',     ctrl.createCoupon);
router.patch('/admin/plans/:id',   ctrl.updatePlan);

module.exports = router;
// routes/subscription.routes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/subscription.controller");
const { auth, requireAdmin } = require("../middleware/auth.middleware");

// ── Pública (no necesita auth) ─────────────────────────────────
router.get("/plans", ctrl.getPublicPlans);  // ← esta es la que falla ahora

// ── Protegidas ──────────────────────────────────────────────────
router.get ("/me",               auth, requireAdmin, ctrl.getMySubscription);
router.get ("/me/invoices",      auth, requireAdmin, ctrl.getMyInvoices);
router.post("/coupons/validate", auth, requireAdmin, ctrl.validateCoupon);
router.post("/cancel",          auth, requireAdmin, ctrl.cancelSubscription);
router.post("/reactivate",      auth, requireAdmin, ctrl.reactivateSubscription);
router.post("/change-plan",     auth, requireAdmin, ctrl.changePlan);

// ── Superadmin ──────────────────────────────────────────────────
const { requireSuperAdmin } = require("../middleware/auth.middleware");
router.get ("/admin/all",          auth, requireSuperAdmin, ctrl.getAllSubscriptions);
router.post("/admin/assign",       auth, requireSuperAdmin, ctrl.assignSubscription);
router.get ("/admin/stats",        auth, requireSuperAdmin, ctrl.getSubscriptionStats);
router.post("/admin/coupons",      auth, requireSuperAdmin, ctrl.createCoupon);
router.get ("/admin/coupons",      auth, requireSuperAdmin, ctrl.getCoupons);
router.patch("/admin/plans/:id",   auth, requireSuperAdmin, ctrl.updatePlan);

module.exports = router;
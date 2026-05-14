// routes/superadmin.routes.js  — ACTUALIZADO
const express        = require("express");
const router         = express.Router();
const superadminCtrl = require("../controllers/superadmin.controller");
const { auth, requireSuperAdmin } = require("../middleware/auth.middleware");

router.use(auth, requireSuperAdmin);

// Dashboard global
router.get("/stats", superadminCtrl.getSystemStats);

// CRUD admins
router.get   ("/admins",                          superadminCtrl.getAdmins);
router.post  ("/admins",                          superadminCtrl.createAdmin);      // ahora acepta plan_slug, trial_days
router.put   ("/admins/:id",                      superadminCtrl.updateAdmin);
router.patch ("/admins/:id/toggle",               superadminCtrl.toggleAdminStatus);
router.delete("/admins/:id",                      superadminCtrl.deleteAdmin);

// Suscripción por admin (para el panel de superadmin)
router.get   ("/admins/:id/subscription",         superadminCtrl.getAdminSubscription);
router.post  ("/admins/:id/subscription",         superadminCtrl.setAdminSubscription);

module.exports = router;
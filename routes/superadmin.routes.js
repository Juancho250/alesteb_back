// routes/superadmin.routes.js
// Solo accesible por el rol "superadmin"
const express        = require("express");
const router         = express.Router();
const superadminCtrl = require("../controllers/superadmin.controller");
const { auth, requireSuperAdmin } = require("../middleware/auth.middleware");

// Todas las rutas requieren auth + rol superadmin
router.use(auth, requireSuperAdmin);

// Dashboard global del sistema
router.get("/stats", superadminCtrl.getSystemStats);

// CRUD de admins
router.get   ("/admins",            superadminCtrl.getAdmins);
router.post  ("/admins",            superadminCtrl.createAdmin);
router.put   ("/admins/:id",        superadminCtrl.updateAdmin);
router.patch ("/admins/:id/toggle", superadminCtrl.toggleAdminStatus);
router.delete("/admins/:id",        superadminCtrl.deleteAdmin);

module.exports = router;
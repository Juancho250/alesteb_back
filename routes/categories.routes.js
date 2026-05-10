const express = require("express");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope } = require("../middleware/adminScope");
const ctrl = require("../controllers/categories.controller");

const router = express.Router();

// ── Públicas ──────────────────────────────────────────────────────────────────
router.get("/",    ctrl.getAll);
router.get("/flat", ctrl.getFlat);

// ── Privadas ──────────────────────────────────────────────────────────────────
router.post(  "/",    auth, adminScope, requireManager, ctrl.create);
router.put(   "/:id", auth, adminScope, requireManager, ctrl.update);
router.delete("/:id", auth, adminScope, requireManager, ctrl.remove);

module.exports = router;
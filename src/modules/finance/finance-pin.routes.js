// src/modules/finance/finance-pin.routes.js
const express = require("express");
const router  = express.Router();
const ctrl    = require("./finance-pin.controller");
const { auth, checkRateLimit } = require("../identity/auth");
const { adminScope }           = require("../../../middleware/adminScope");

router.use(auth);
router.use(adminScope);

router.get ("/status",  ctrl.getStatus);
router.post("/setup",   ctrl.setPin);
router.post("/verify",
  checkRateLimit((req) => `fp:${req.adminId}`, 5, 15 * 60 * 1000),
  ctrl.verifyPin
);
router.post("/lock",    ctrl.lockPin);

module.exports = router;

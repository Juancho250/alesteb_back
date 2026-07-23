// src/modules/stats/stats.routes.js
const express = require("express");
const router  = express.Router();
const { auth }       = require("../identity/auth");
const { adminScope } = require("../../../middleware/adminScope");
const { getDashboardStats } = require("./stats.controller");

router.use(auth);
router.use(adminScope);

router.get("/dashboard", getDashboardStats);

module.exports = router;
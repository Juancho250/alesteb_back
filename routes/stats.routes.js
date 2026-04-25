// routes/stats.routes.js
const express = require("express");
const router  = express.Router();
const { auth } = require("../middleware/auth.middleware");
const { getDashboardStats } = require("../controllers/stats.controller");

// GET /api/stats/dashboard
router.get("/dashboard", auth, getDashboardStats);

module.exports = router;
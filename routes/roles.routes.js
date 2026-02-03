const express = require("express");
const router = express.Router();

const { getDashboard } = require("../controllers/dashboard.controller");
const { auth, isAdmin } = require("../middleware/auth.middleware");

// Solo admin puede ver el dashboard
router.get("/", auth, isAdmin, getDashboard);

module.exports = router;
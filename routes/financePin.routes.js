// routes/financePin.routes.js
const express = require("express");
const router = express.Router();
const financePinController = require("../controllers/financePin.controller");
const { authenticateToken } = require("../middleware/auth"); // ajusta si tu middleware tiene otro nombre

router.get("/status",  authenticateToken, financePinController.getStatus);
router.post("/set",    authenticateToken, financePinController.setPin);
router.post("/verify", authenticateToken, financePinController.verifyPin);

module.exports = router;
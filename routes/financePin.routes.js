// routes/financePin.routes.js
const express = require("express");
const router = express.Router();
const financePinController = require("../controllers/financePin.controller");
const { auth } = require("../middleware/auth.middleware");

router.get("/status",  auth, financePinController.getStatus);
router.post("/set",    auth, financePinController.setPin);
router.post("/verify", auth, financePinController.verifyPin);

module.exports = router;
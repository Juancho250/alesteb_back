// routes/auth.routes.js
const express = require("express");
const router = express.Router();
const { login, register, verifyCode } = require("../controllers/auth.controller");

router.post("/login", login);
router.post("/register", register);
router.post("/verify", verifyCode); // Nueva ruta

module.exports = router;
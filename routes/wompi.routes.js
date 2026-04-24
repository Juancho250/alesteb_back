// routes/wompi.routes.js
const express  = require("express");
const { auth } = require("../middleware/auth.middleware");
const {
  getSession,
  handleWebhook,
  verifyByReference,
} = require("../controllers/wompi.controller");

const router = express.Router();

// ⚠️ El webhook NO lleva auth — Wompi lo llama directamente
router.post("/webhook", handleWebhook);

// Autenticados
router.get("/session/:sale_id",       auth, getSession);
router.get("/verify/:reference",      auth, verifyByReference);

module.exports = router;
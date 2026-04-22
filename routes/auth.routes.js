// routes/auth.routes.js
const express = require("express");
const router  = express.Router();

const authController            = require("../controllers/auth.controller");
const { auth, checkRateLimit }  = require("../middleware/auth.middleware");

// ============================================
// 🔓 RUTAS PÚBLICAS
// ============================================

router.post(
  "/login",
  checkRateLimit("email", 5, 15 * 60 * 1000),
  authController.login
);

router.post(
  "/register",
  checkRateLimit("ip", 3, 60 * 60 * 1000),
  authController.register
);

router.post("/verify",     authController.verifyEmail);

router.post(
  "/resend-code",
  checkRateLimit("email", 3, 60 * 60 * 1000),
  authController.resendVerificationCode
);

router.post("/refresh",    authController.refreshToken);

// ============================================
// 🛠️ SETUP — SOLO FUNCIONA SI NO HAY ADMINS
// Requiere SETUP_SECRET_KEY en el body
// DESHABILITA esta ruta una vez tengas tu primer admin creado
// ============================================
router.post("/setup",      authController.setupAdmin);

// ============================================
// 🔐 RUTAS PROTEGIDAS
// ============================================

router.post("/logout",     auth, authController.logout);
router.get ("/profile",    auth, authController.getProfile);
router.put ("/profile",    auth, authController.updateProfile);

router.get("/verify-token", auth, (req, res) => {
  res.json({
    success: true,
    message: "Token válido",
    data: { user: req.user },
  });
});

module.exports = router;
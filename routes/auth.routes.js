const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const { auth, checkRateLimit } = require("../middleware/auth.middleware");

// ============================================
// 🔓 RUTAS PÚBLICAS (No requieren autenticación)
// ============================================

/**
 * @route   POST /api/auth/login
 * @desc    Iniciar sesión y obtener tokens
 * @access  Public
 * @body    { email, password, deviceInfo? }
 */
router.post(
  "/login", 
  checkRateLimit('email', 5, 15 * 60 * 1000), // 5 intentos por 15 minutos
  authController.login
);

/**
 * @route   POST /api/auth/register
 * @desc    Registrar nuevo usuario (requiere verificación de email)
 * @access  Public
 * @body    { email, password, name, cedula, phone? }
 */
router.post(
  "/register",
  checkRateLimit('ip', 3, 60 * 60 * 1000), // 3 registros por IP por hora
  authController.register
);

/**
 * @route   POST /api/auth/verify
 * @desc    Verificar email con código de 6 dígitos
 * @access  Public
 * @body    { email, code }
 */
router.post("/verify", authController.verifyEmail);

/**
 * @route   POST /api/auth/resend-code
 * @desc    Reenviar código de verificación
 * @access  Public
 * @body    { email }
 */
router.post(
  "/resend-code", 
  checkRateLimit('email', 3, 60 * 60 * 1000), // Máx 3 reenvíos por hora
  authController.resendVerificationCode
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Renovar access token usando refresh token
 * @access  Public
 * @body    { refreshToken }
 */
router.post("/refresh", authController.refreshToken);

// ============================================
// 🔐 RUTAS PROTEGIDAS (Requieren autenticación)
// ============================================

/**
 * @route   POST /api/auth/logout
 * @desc    Cerrar sesión y revocar tokens
 * @access  Private
 * @body    { refreshToken? }
 */
router.post("/logout", auth, authController.logout);

/**
 * @route   GET /api/auth/profile
 * @desc    Obtener perfil del usuario autenticado
 * @access  Private
 */
router.get("/profile", auth, authController.getProfile);

/**
 * @route   GET /api/auth/verify-token
 * @desc    Verificar si el token actual es válido
 * @access  Private
 */
router.get("/verify-token", auth, (req, res) => {
  res.json({
    success: true,
    message: "Token válido",
    data: {
      user: req.user
    }
  });
});

module.exports = router;
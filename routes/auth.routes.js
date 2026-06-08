// routes/auth.routes.js
// ARQUITECTURA:
//   - superadmin crea admins → via /api/superadmin/admins
//   - admin crea sus usuarios → via /api/users
//   - El registro público (/register) queda desactivado en esta arquitectura
//     porque los usuarios los crea directamente el admin desde el panel.
//   - Si en el futuro quieres auto-registro en el sitio web del admin,
//     usa la ruta /public-api/v1/register con API Key.

const express = require("express");
const router  = express.Router();

const authController           = require("../controllers/auth.controller");
const { auth, checkRateLimit } = require("../middleware/auth.middleware");

// ============================================
// 🔓 RUTAS PÚBLICAS
// ============================================

// Login — panel admin y app cliente
router.post(
  "/login",
  checkRateLimit("email", 20, 15 * 60 * 1000),
  authController.login
);

// Verificación de email (para el flujo de auto-registro si lo habilitas)
router.post("/verify",     authController.verifyEmail);
router.post(
  "/resend-code",
  checkRateLimit("email", 3, 60 * 60 * 1000),
  authController.resendVerificationCode
);

// Renovación de token
router.post("/refresh",    authController.refreshToken);

// ============================================
// SETUP INICIAL — solo disponible fuera de producción
// ============================================
if (process.env.NODE_ENV !== "production") {
  router.post("/setup", authController.setupAdmin);
}

// ============================================
// 🔐 RUTAS PROTEGIDAS
// ============================================

router.post("/logout",     auth, authController.logout);
router.get ("/profile",    auth, authController.getProfile);
router.put ("/profile",    auth, authController.updateProfile);

// Cambio de contraseña propio
router.post("/change-password", auth, authController.changePassword);

// Verificar token activo (útil para el frontend al iniciar)
router.get("/verify-token", auth, (req, res) => {
  res.json({
    success: true,
    message: "Token válido",
    data: { user: req.user },
  });
});

module.exports = router;
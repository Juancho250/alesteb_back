// ============================================
// 🔓 RUTAS PÚBLICAS (No requieren autenticación)
// ============================================

router.post(
  "/login", 
  checkRateLimit('email', 5, 15 * 60 * 1000),
  authController.login
);

router.post(
  "/register",
  checkRateLimit('ip', 3, 60 * 60 * 1000),
  authController.register
);

router.post("/verify", authController.verifyEmail);

router.post(
  "/resend-code", 
  checkRateLimit('email', 3, 60 * 60 * 1000),
  authController.resendVerificationCode
);

router.post("/refresh", authController.refreshToken);

// ============================================
// 🔐 RUTAS PROTEGIDAS (Requieren autenticación)
// ============================================

router.post("/logout", auth, authController.logout);

router.get("/profile", auth, authController.getProfile);

router.put("/profile", auth, authController.updateProfile); // ← NUEVA

router.get("/verify-token", auth, (req, res) => {
  res.json({
    success: true,
    message: "Token válido",
    data: { user: req.user }
  });
});

module.exports = router;
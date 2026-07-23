// routes/index.js
const router = require("express").Router();
const { auth }       = require("../src/modules/identity/auth");
const { adminScope } = require("../middleware/adminScope");

// ── Rutas públicas (sin auth) ─────────────────────────
router.use("/auth",       require("../src/modules/identity/auth").routes);
router.use("/public-api", require("./public-api.routes")); // API key auth propia

// ── Middleware global para TODO lo de abajo ───────────
router.use(auth);        // ← verifica JWT
router.use(adminScope);  // ← inyecta req.isSuperAdmin y req.adminId

// ── Rutas del panel (todas protegidas) ────────────────
router.use("/products",       require("../src/modules/catalog").productsRoutes);
router.use("/categories",     require("../src/modules/catalog").categoriesRoutes);
router.use("/providers",      require("../src/modules/providers").routes);
router.use("/sales",          require("../src/modules/sales").routes);
router.use("/users",          require("../src/modules/identity/users").routes);
router.use("/banners",        require("../src/modules/banners").routes);
router.use("/discounts",      require("../src/modules/discounts").routes);
router.use("/finance",        require("../src/modules/finance").routes);
router.use("/analytics",      require("../src/modules/analytics").routes);
router.use("/stats",          require("../src/modules/stats").routes);
router.use("/agent",          require("../src/modules/aura").agentRoutes);
router.use("/chat",           require("../src/modules/chat").routes);
router.use("/contact",        require("../src/modules/contact").routes);
router.use("/notifications",  require("../src/modules/notifications").routes);
router.use("/roles",          require("../src/modules/identity/roles").routes);
router.use("/api-keys",       require("../src/modules/identity/api-keys").routes);
router.use("/superadmin",     require("../src/modules/identity/superadmin").routes);
router.use("/variants",       require("../src/modules/catalog").variantsRoutes);
router.use("/wompi",          require("../src/modules/payments").wompiRoutes);
// Agrega esta línea junto a las demás rutas del panel
router.use("/subscriptions", require("../src/modules/subscriptions").routes);

module.exports = router;
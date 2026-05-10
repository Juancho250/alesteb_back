// app.js
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");

const app = express();

// ============================================
// 🛡️ MIDDLEWARES GLOBALES
// ============================================
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(morgan("dev"));

// ============================================
// 🔧 HELPER: Carga segura de módulos
// ============================================
function safeRequire(path, label) {
  try {
    const mod = require(path);
    console.log(`  ✅ ${label}`);
    return mod;
  } catch (e) {
    console.error(`  ❌ ${label} → ${e.message}`);
    console.error(e.stack);
    return null;
  }
}

console.log("\n[APP] Cargando rutas...");

// ============================================
// 🗺️ RUTAS — Panel de administración
// ============================================

// Auth (login, logout, perfil, refresh token)
const authRoutes       = safeRequire("./routes/auth.routes",       "auth.routes");

// Superadmin: gestión de admins y estadísticas globales
const superadminRoutes = safeRequire("./routes/superadmin.routes", "superadmin.routes");

// Admin: gestión de sus propios usuarios
const usersRoutes      = safeRequire("./routes/users.routes",      "users.routes");

// Roles del sistema (lectura para admin, escritura solo superadmin)
const rolesRoutes      = safeRequire("./routes/roles.routes",      "roles.routes");

// API Keys: cada admin gestiona las suyas
const apiKeysRoutes    = safeRequire("./routes/apikeys.routes",    "apikeys.routes");

// Resto del panel
const statsRoutes         = safeRequire("./routes/stats.routes",              "stats.routes");
const providersRoutes     = safeRequire("./routes/providers.routes",          "providers.routes");
const financeRoutes       = safeRequire("./routes/finance.routes",            "finance.routes");
const productsRoutes      = safeRequire("./routes/products.routes",           "products.routes");
const categoriesRoutes    = safeRequire("./routes/categories.routes",         "categories.routes");
const discountsRoutes     = safeRequire("./routes/discounts.routes",          "discounts.routes");
const salesRoutes         = safeRequire("./routes/sales.routes",              "sales.routes");
const bannersRoutes       = safeRequire("./routes/banners.routes",            "banners.routes");
const notificationsRoutes = safeRequire("./routes/notifications.routes",      "notifications.routes");
const agentRoutes         = safeRequire("./routes/agent.routes",              "agent.routes");
const variantsRoutes      = safeRequire("./routes/variants_bundles.routes",   "variants_bundles.routes");
const chatRoutes          = safeRequire("./routes/chat.routes",               "chat.routes");
const wompiRoutes         = safeRequire("./routes/wompi.routes",              "wompi.routes");
const analyticsRoutes     = safeRequire("./routes/analytics.routes",          "analytics.routes");
const contactRoutes       = safeRequire("./routes/contact.routes",            "contact.routes");

// ============================================
// 🌐 RUTAS — API Pública (consumida via API Key desde sitios externos)
// ============================================
const publicApiRoutes  = safeRequire("./routes/public-api.routes", "public-api.routes");

console.log("[APP] Rutas cargadas.\n");

// ============================================
// ⏱️ TAREAS PROGRAMADAS
// ============================================
require("./services/agent.cron");            // Agente autónomo (stock, reportes, facturas)
require("./services/notificationScheduler"); // Push notifications automáticas

// ============================================
// 🔌 REGISTRO DE RUTAS
// ============================================

// — Auth —
if (authRoutes)       app.use("/api/auth",       authRoutes);

// — Panel de administración —
if (superadminRoutes) app.use("/api/superadmin",  superadminRoutes); // Solo superadmin
if (usersRoutes)      app.use("/api/users",        usersRoutes);      // Admin gestiona sus users
if (rolesRoutes)      app.use("/api/roles",        rolesRoutes);      // Lectura admin / escritura superadmin
if (apiKeysRoutes)    app.use("/api/api-keys",     apiKeysRoutes);    // Admin gestiona sus API keys

// — Resto del panel —
if (statsRoutes)         app.use("/api/stats",         statsRoutes);
if (providersRoutes)     app.use("/api/providers",     providersRoutes);
if (financeRoutes)       app.use("/api/finance",       financeRoutes);
if (productsRoutes)      app.use("/api/products",      productsRoutes);
if (categoriesRoutes)    app.use("/api/categories",    categoriesRoutes);
if (salesRoutes)         app.use("/api/sales",         salesRoutes);
if (discountsRoutes)     app.use("/api/discounts",     discountsRoutes);
if (bannersRoutes)       app.use("/api/banners",       bannersRoutes);
if (notificationsRoutes) app.use("/api/notifications", notificationsRoutes);
if (variantsRoutes)      app.use("/api",               variantsRoutes);
if (chatRoutes)          app.use("/api/chat",          chatRoutes);
if (agentRoutes)         app.use("/api/agent",         agentRoutes);
if (wompiRoutes)         app.use("/api/wompi",         wompiRoutes);
if (analyticsRoutes)     app.use("/api/analytics",     analyticsRoutes);
if (contactRoutes)       app.use("/api/contact",       contactRoutes);

// — API pública (requiere X-API-Key, sin JWT) —
if (publicApiRoutes)  app.use("/public-api/v1",    publicApiRoutes);

// ============================================
// ❤️ HEALTH CHECK
// ============================================
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    routes: {
      auth:               !!authRoutes,
      superadmin:         !!superadminRoutes,
      users:              !!usersRoutes,
      roles:              !!rolesRoutes,
      apiKeys:            !!apiKeysRoutes,
      stats:              !!statsRoutes,
      providers:          !!providersRoutes,
      finance:            !!financeRoutes,
      products:           !!productsRoutes,
      categories:         !!categoriesRoutes,
      sales:              !!salesRoutes,
      discounts:          !!discountsRoutes,
      banners:            !!bannersRoutes,
      notifications:      !!notificationsRoutes,
      variants:           !!variantsRoutes,
      chat:               !!chatRoutes,
      agent:              !!agentRoutes,
      wompi:              !!wompiRoutes,
      analytics:          !!analyticsRoutes,
      contact:            !!contactRoutes,
      publicApi:          !!publicApiRoutes,
    },
    services: {
      agent_cron:             true,
      notification_scheduler: true,
    },
  });
});

app.get("/", (req, res) =>
  res.json({ message: "API Alesteb OK", timestamp: new Date() })
);

// ============================================
// 🚨 MANEJO GLOBAL DE ERRORES
// ============================================
app.use((err, req, res, next) => {
  console.error("[EXPRESS ERROR]", err.stack);
  res.status(500).json({ success: false, message: err.message });
});

module.exports = app;
// app.js
const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const morgan      = require("morgan");
const compression = require("compression");
const crypto      = require("crypto");

const app    = express();
const isProd = process.env.NODE_ENV === "production";

// ============================================
// MIDDLEWARES GLOBALES
// ============================================

// X-Request-Id — trazabilidad en logs y respuestas
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
});

// Compresión gzip/brotli — reduce payload hasta un 70%
app.use(compression());

app.use(helmet({
  crossOriginResourcePolicy:  { policy: "cross-origin" },
  crossOriginOpenerPolicy:    false,   // ← permite que el popup de Google se comunique
}));

// CORS — solo origenes explícitamente permitidos
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:5174,http://localhost:3000")
  .split(",").map((o) => o.trim()).filter(Boolean);

const CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

// API pública: acepta cualquier origen (acceso controlado por API Key en BD)
// Panel admin: solo origenes en ALLOWED_ORIGINS
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/public-api/")) {
    return cors({
      origin:         true,
      methods:        CORS_METHODS,
      allowedHeaders: ["Content-Type", "X-API-Key", "Authorization", "X-Tenant-Admin-Id"],
      maxAge:         86400,
    })(req, res, next);
  }
  return cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(Object.assign(new Error("Origin no permitido"), { status: 403 }));
    },
    credentials:    true,
    methods:        CORS_METHODS,
    allowedHeaders: ["Content-Type", "Authorization", "X-Tenant-Admin-Id"],
  })(req, res, next);
});

// Wompi webhook — raw body MUST be captured before express.json() parses other routes
// express.raw() only runs for this exact path; all other routes use express.json() below
app.post("/api/wompi/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => require("./src/modules/payments").wompiController.handleWebhook(req, res)
);

app.use(express.json({
  limit: process.env.REQUEST_LIMIT || "10mb",
  verify: (req, _res, buf) => {
    // Preserve raw body for webhook HMAC verification
    if (req.originalUrl.startsWith('/api/notifications/webhook')) {
      req.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({ extended: false, limit: process.env.REQUEST_LIMIT || "10mb" }));
app.use(morgan(isProd ? "combined" : "dev"));

// Timeout por petición — evita que conexiones colgadas agoten el pool
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT) || 30_000;
app.use((req, res, next) => {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({ success: false, message: "Tiempo de espera agotado", code: "REQUEST_TIMEOUT" });
    }
  });
  next();
});

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
const authModule = safeRequire("./src/modules/identity/auth", "identity.auth.module");
const superadminModule = safeRequire("./src/modules/identity/superadmin", "identity.superadmin.module");
const usersModule = safeRequire("./src/modules/identity/users", "identity.users.module");
const rolesModule = safeRequire("./src/modules/identity/roles", "identity.roles.module");
const apiKeysModule = safeRequire("./src/modules/identity/api-keys", "identity.api-keys.module");
const tenantProfileModule = safeRequire("./src/modules/tenant/profile", "tenant.profile.module");
const subscriptionsModule = safeRequire("./src/modules/subscriptions", "subscriptions.module");

const statsModule = safeRequire("./src/modules/stats", "stats.module");
const providersModule = safeRequire("./src/modules/providers", "providers.module");
const financeModule = safeRequire("./src/modules/finance", "finance.module");
const catalogModule = safeRequire("./src/modules/catalog", "catalog.module");

const discountsModule = safeRequire("./src/modules/discounts", "discounts.module");
const salesModule = safeRequire("./src/modules/sales", "sales.module");
const bannersModule = safeRequire("./src/modules/banners", "banners.module");
const notificationsModule = safeRequire("./src/modules/notifications", "notifications.module");
const agentRoutes         = safeRequire("./routes/agent.routes",            "agent.routes");
const auraRoutes          = safeRequire("./routes/aura.routes",             "aura.routes");

const reviewsModule = safeRequire("./src/modules/reviews", "reviews.module");
const chatModule = safeRequire("./src/modules/chat", "chat.module");
const paymentsModule = safeRequire("./src/modules/payments", "payments.module");

const analyticsModule = safeRequire("./src/modules/analytics", "analytics.module");
const contactModule = safeRequire("./src/modules/contact", "contact.module");
const inventoryModule = safeRequire("./src/modules/inventory", "inventory.module");
const procurementModule = safeRequire("./src/modules/procurement", "procurement.module");


// ============================================
// 🌐 RUTAS — API Pública
// ============================================
const publicApiRoutes = safeRequire("./routes/public-api.routes", "public-api.routes");

console.log("[APP] Rutas cargadas.\n");

// Las tareas programadas se inician exclusivamente desde worker.js.
// El proceso web nunca registra crons para evitar ejecuciones duplicadas por réplica.

// ============================================
// 🔌 REGISTRO DE RUTAS
// ============================================

// — Auth —
if (salesModule?.creditPayRoutes) app.use("/pay", salesModule.creditPayRoutes);
if (authModule?.routes) app.use("/api/auth", authModule.routes);

// — Panel de administración —
if (superadminModule?.routes) app.use("/api/superadmin", superadminModule.routes);
if (usersModule?.routes) app.use("/api/users", usersModule.routes);
if (rolesModule?.routes) app.use("/api/roles", rolesModule.routes);
if (apiKeysModule?.routes) app.use("/api/api-keys", apiKeysModule.routes);
if (tenantProfileModule?.routes) app.use("/api/admin-profile", tenantProfileModule.routes);
if (subscriptionsModule?.routes) app.use("/api/subscriptions", subscriptionsModule.routes);

// — Resto del panel —
if (statsModule?.routes) app.use("/api/stats", statsModule.routes);
if (providersModule?.routes) app.use("/api/providers", providersModule.routes);
if (financeModule?.routes) app.use("/api/finance", financeModule.routes);
if (catalogModule?.productsRoutes) app.use("/api/products", catalogModule.productsRoutes);
if (catalogModule?.categoriesRoutes) app.use("/api/categories", catalogModule.categoriesRoutes);
if (salesModule?.routes) app.use("/api/sales", salesModule.routes);
if (discountsModule?.routes) app.use("/api/discounts", discountsModule.routes);
if (bannersModule?.routes) app.use("/api/banners", bannersModule.routes);
if (notificationsModule?.routes) app.use("/api/notifications", notificationsModule.routes);
if (catalogModule?.variantsRoutes) app.use("/api", catalogModule.variantsRoutes);
if (reviewsModule?.routes) app.use("/api", reviewsModule.routes);
if (chatModule?.routes) app.use("/api/chat", chatModule.routes);
if (agentRoutes)         app.use("/api/agent",         agentRoutes);
if (auraRoutes)          app.use("/api/aura",          auraRoutes);
if (paymentsModule?.wompiRoutes) app.use("/api/wompi", paymentsModule.wompiRoutes);
if (paymentsModule?.paymentAccountsRoutes) app.use("/api/payment-accounts", paymentsModule.paymentAccountsRoutes);
if (analyticsModule?.routes) app.use("/api/analytics", analyticsModule.routes);
if (contactModule?.routes) app.use("/api/contact", contactModule.routes);
if (inventoryModule?.routes) app.use("/api/inventory", inventoryModule.routes);
if (procurementModule?.routes) app.use("/api/procurement", procurementModule.routes);
if (financeModule?.pinRoutes) app.use("/api/finance-pin", financeModule.pinRoutes);

// — API pública —
if (publicApiRoutes)     app.use("/public-api/v1",     publicApiRoutes);

// ============================================
// HEALTH CHECK
// ============================================
app.get("/api/health", (req, res) => {
  const base = { status: "ok", timestamp: new Date().toISOString() };
  if (isProd) return res.json(base);
  res.json({
    ...base,
    routes: {
      auth:          !!authModule?.routes,
      superadmin:    !!superadminModule?.routes,
      users:         !!usersModule?.routes,
      roles:         !!rolesModule?.routes,
      apiKeys:       !!apiKeysModule?.routes,
      adminProfile:  !!tenantProfileModule?.routes,
      subscriptions: !!subscriptionsModule?.routes,
      stats:         !!statsModule?.routes,
      providers:     !!providersModule?.routes,
      finance:       !!financeModule?.routes,
      products:      !!catalogModule?.productsRoutes,
      categories:    !!catalogModule?.categoriesRoutes,
      sales:         !!salesModule?.routes,
      discounts:     !!discountsModule?.routes,
      banners:       !!bannersModule?.routes,
      notifications: !!notificationsModule?.routes,
      variants:      !!catalogModule?.variantsRoutes,
      reviews:       !!reviewsModule?.routes,
      chat:          !!chatModule?.routes,
      agent:         !!agentRoutes,
      aura:          !!auraRoutes,
      financePin:    !!financeModule?.pinRoutes,
      creditPay:     !!salesModule?.creditPayRoutes,
      wompi:          !!paymentsModule?.wompiRoutes,
      paymentAccounts: !!paymentsModule?.paymentAccountsRoutes,
      analytics:      !!analyticsModule?.routes,
      contact:       !!contactModule?.routes,
      publicApi:     !!publicApiRoutes,
    },
    services: {
      agent_cron:             false,
      notification_scheduler: false,
      subscription_cron:      false,
      inventory_jobs:         false,
      notification_worker:    false,
      external_worker:        true,
    },
  });
});

app.get("/", (req, res) =>
  res.json({ message: "API Alesteb OK", timestamp: new Date() })
);

// ============================================
// 404 — Ruta no encontrada
// ============================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Ruta no encontrada: ${req.method} ${req.path}`,
    code: "NOT_FOUND",
  });
});

// ============================================
// MANEJO GLOBAL DE ERRORES
// ============================================
app.use((err, req, res, _next) => {
  const reqId  = req.id || "-";
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[EXPRESS ERROR] [${reqId}]`, err.stack);
  const message = isProd && status === 500 ? "Error interno del servidor" : err.message;
  res.status(status).json({ success: false, message, ...(isProd ? {} : { requestId: reqId }) });
});

module.exports = app;

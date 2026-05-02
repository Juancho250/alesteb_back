// app.js  ← VA EN LA RAÍZ del proyecto (mismo nivel que server.js)
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(morgan("dev"));

function safeRequire(path, label) {
  try {
    const mod = require(path);
    console.log(`[OK] ${label}`);
    return mod;
  } catch (e) {
    console.error(`[CRASH] ${label} →`, e.message);
    console.error(e.stack);
    return null;
  }
}

// Rutas
const authRoutes          = safeRequire("./routes/auth.routes",               "auth.routes");
const usersRoutes         = safeRequire("./routes/users.routes",              "users.routes");
const rolesRoutes         = safeRequire("./routes/roles.routes",              "roles.routes");
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
const reportsRoutes       = safeRequire("./routes/reports.routes",            "reports.routes");
const analyticsRoutes     = safeRequire("./routes/analytics.routes",          "analytics.routes");
const contactRoutes       = safeRequire("./routes/contact.routes",          "contact.routes");

// Agente autónomo — tareas programadas (stock, reportes, facturas)
require("./services/agent.cron");

if (authRoutes)          app.use("/api/auth",          authRoutes);
if (usersRoutes)         app.use("/api/users",         usersRoutes);
if (rolesRoutes)         app.use("/api/roles",         rolesRoutes);
if (providersRoutes)     app.use("/api/providers",     providersRoutes);
if (statsRoutes)         app.use("/api/stats",         statsRoutes);
if (productsRoutes)      app.use("/api/products",      productsRoutes);
if (categoriesRoutes)    app.use("/api/categories",    categoriesRoutes);
if (salesRoutes)         app.use("/api/sales",         salesRoutes);
if (discountsRoutes)     app.use("/api/discounts",     discountsRoutes);
if (bannersRoutes)       app.use("/api/banners",       bannersRoutes);
if (financeRoutes)       app.use("/api/finance",       financeRoutes);
if (notificationsRoutes) app.use("/api/notifications", notificationsRoutes);
if (variantsRoutes)      app.use("/api",               variantsRoutes);
if (chatRoutes)          app.use("/api/chat",          chatRoutes);
if (agentRoutes)         app.use("/api/agent",         agentRoutes);
if (wompiRoutes)         app.use("/api/wompi",         wompiRoutes);
if (reportsRoutes)       app.use("/api/reports",       reportsRoutes);
if (analyticsRoutes)     app.use("/api/analytics",     analyticsRoutes);
if (contactRoutes)       app.use("/api/contact",       contactRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    auth:          !!authRoutes,
    users:         !!usersRoutes,
    roles:         !!rolesRoutes,
    providers:     !!providersRoutes,
    products:      !!productsRoutes,
    categories:    !!categoriesRoutes,
    sales:         !!salesRoutes,
    discounts:     !!discountsRoutes,
    banners:       !!bannersRoutes,
    finance:       !!financeRoutes,
    notifications: !!notificationsRoutes,
    variants:      !!variantsRoutes,
    stats:         !!statsRoutes,
    chat:          !!chatRoutes,
    wompi:         !!wompiRoutes,
    reports:       !!reportsRoutes,
    analytics:     !!analyticsRoutes,
      contact:       !!contactRoutes,
    agent_cron:    true,
  });
});

app.get("/", (req, res) =>
  res.json({ message: "API Alesteb OK", timestamp: new Date() })
);

app.use((err, req, res, next) => {
  console.error("[EXPRESS ERROR]", err.stack);
  res.status(500).json({ success: false, message: err.message });
});

module.exports = app;
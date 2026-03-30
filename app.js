// app.js  ← RAÍZ del proyecto
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");
const path    = require("path");

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(morgan("dev"));

/**
 * 🔥 Helper a prueba de Vercel + /src
 * Siempre resuelve desde la raíz real del proyecto
 */
function safeRequire(relativePath, label) {
  try {
    const absolutePath = path.join(__dirname, relativePath);
    const mod = require(absolutePath);
    console.log(`[OK] ${label} → ${relativePath}`);
    return mod;
  } catch (e) {
    console.error(`\n[CRASH] ${label}`);
    console.error("Path:", relativePath);
    console.error(e.message);
    console.error(e.stack);
    return null;
  }
}

/**
 * ✅ TODAS LAS RUTAS APUNTAN A /src
 */
const authRoutes          = safeRequire("src/routes/auth.routes.js",               "auth.routes");
const usersRoutes         = safeRequire("src/routes/users.routes.js",              "users.routes");
const rolesRoutes         = safeRequire("src/routes/roles.routes.js",              "roles.routes");
const providersRoutes     = safeRequire("src/routes/providers.routes.js",          "providers.routes");
const financeRoutes       = safeRequire("src/routes/finance.routes.js",            "finance.routes");
const productsRoutes      = safeRequire("src/routes/products.routes.js",           "products.routes");
const categoriesRoutes    = safeRequire("src/routes/categories.routes.js",         "categories.routes");
const discountsRoutes     = safeRequire("src/routes/discounts.routes.js",          "discounts.routes");
const salesRoutes         = safeRequire("src/routes/sales.routes.js",              "sales.routes");
const bannersRoutes       = safeRequire("src/routes/banners.routes.js",            "banners.routes");
const notificationsRoutes = safeRequire("src/routes/notifications.routes.js",      "notifications.routes");
const variantsRoutes      = safeRequire("src/routes/variants_bundles.routes.js",   "variants_bundles.routes");

/**
 * 🔗 Montaje de rutas
 */
if (authRoutes)          app.use("/api/auth",          authRoutes);
if (usersRoutes)         app.use("/api/users",         usersRoutes);
if (rolesRoutes)         app.use("/api/roles",         rolesRoutes);
if (providersRoutes)     app.use("/api/providers",     providersRoutes);
if (productsRoutes)      app.use("/api/products",      productsRoutes);
if (categoriesRoutes)    app.use("/api/categories",    categoriesRoutes);
if (salesRoutes)         app.use("/api/sales",         salesRoutes);
if (discountsRoutes)     app.use("/api/discounts",     discountsRoutes);
if (bannersRoutes)       app.use("/api/banners",       bannersRoutes);
if (financeRoutes)       app.use("/api/finance",       financeRoutes);
if (notificationsRoutes) app.use("/api/notifications", notificationsRoutes);
if (variantsRoutes)      app.use("/api",               variantsRoutes);

/**
 * 🩺 Health check REAL
 */
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
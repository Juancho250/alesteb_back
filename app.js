const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");

const loadErrors = [];

const safeRequire = (path) => {
  try {
    return require(path);
  } catch (e) {
    loadErrors.push({ path, error: e.message });
    return null;
  }
};

// ── Config primero ────────────────────────────────────────────────────────────
const db         = safeRequire("./config/db");
const cloudinary = safeRequire("./config/cloudinary");

// ── Rutas — nombres EXACTOS de tus archivos ───────────────────────────────────
const authRoutes            = safeRequire("./routes/auth.routes");
const usersRoutes           = safeRequire("./routes/users.routes");
const rolesRoutes           = safeRequire("./routes/roles.routes");
const providersRoutes       = safeRequire("./routes/providers.routes");
const financeRoutes         = safeRequire("./routes/finance.routes");
const productsRoutes        = safeRequire("./routes/products.routes");
const variantsBundlesRoutes = safeRequire("./routes/variants_bundles.routes"); // ← guion bajo
const categoriesRoutes      = safeRequire("./routes/categories.routes");
const discountsRoutes       = safeRequire("./routes/discounts.routes");
const salesRoutes           = safeRequire("./routes/sales.routes");
const bannersRoutes         = safeRequire("./routes/banners.routes");
const notificationsRoutes   = safeRequire("./routes/notifications.routes");
const statsRoutes           = safeRequire("./routes/stats.routes"); // ← existe en tu carpeta

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

const mount = (path, router) => {
  if (router) app.use(path, router);
};

// ── ORDEN CRÍTICO ─────────────────────────────────────────────────────────────
mount("/api",               variantsBundlesRoutes);
mount("/api/products",      productsRoutes);
mount("/api/auth",          authRoutes);
mount("/api/users",         usersRoutes);
mount("/api/roles",         rolesRoutes);
mount("/api/providers",     providersRoutes);
mount("/api/categories",    categoriesRoutes);
mount("/api/sales",         salesRoutes);
mount("/api/discounts",     discountsRoutes);
mount("/api/banners",       bannersRoutes);
mount("/api/finance",       financeRoutes);
mount("/api/notifications", notificationsRoutes);
mount("/api/stats",         statsRoutes);

// ── Health check con diagnóstico completo ─────────────────────────────────────
app.get("/", (req, res) => res.json({
  ok: loadErrors.length === 0,
  timestamp: new Date().toISOString(),
  config: {
    db:        !!db,
    cloudinary: !!cloudinary,
  },
  routes: {
    auth:            !!authRoutes,
    users:           !!usersRoutes,
    roles:           !!rolesRoutes,
    providers:       !!providersRoutes,
    finance:         !!financeRoutes,
    products:        !!productsRoutes,
    variantsBundles: !!variantsBundlesRoutes,
    categories:      !!categoriesRoutes,
    discounts:       !!discountsRoutes,
    sales:           !!salesRoutes,
    banners:         !!bannersRoutes,
    notifications:   !!notificationsRoutes,
    stats:           !!statsRoutes,
  },
  // ← EL CAMPO MÁS IMPORTANTE: qué falló y por qué
  errors: loadErrors
}));

app.use((err, req, res, next) => {
  console.error("[GLOBAL ERROR]", err.message);
  res.status(500).json({ success: false, message: err.message });
});

module.exports = app;
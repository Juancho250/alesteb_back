const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");

// ── Captura errores de arranque ANTES de cualquier require ────────────────────
process.on("uncaughtException", (err) => {
  console.error("💥 UNCAUGHT EXCEPTION:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("💥 UNHANDLED REJECTION:", reason);
});

// ── Helper: require con reporte de error claro ────────────────────────────────
const safeRequire = (path) => {
  try {
    return require(path);
  } catch (e) {
    console.error(`❌ No se pudo cargar el módulo: ${path}`);
    console.error(`   Motivo: ${e.message}`);
    return null;
  }
};

// ── Rutas (carga segura) ──────────────────────────────────────────────────────
const authRoutes            = safeRequire("./routes/auth.routes");
const usersRoutes           = safeRequire("./routes/users.routes");
const rolesRoutes           = safeRequire("./routes/roles.routes");
const providersRoutes       = safeRequire("./routes/providers.routes");
const financeRoutes         = safeRequire("./routes/finance.routes");
const productsRoutes        = safeRequire("./routes/products.routes");
const variantsBundlesRoutes = safeRequire("./routes/variants_bundles.routes");
const categoriesRoutes      = safeRequire("./routes/categories.routes");
const discountsRoutes       = safeRequire("./routes/discounts.routes");
const salesRoutes           = safeRequire("./routes/sales.routes");
const bannersRoutes         = safeRequire("./routes/banners.routes");
const notificationsRoutes   = safeRequire("./routes/notifications.routes");

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true })); // ← necesario para FormData sin multer
app.use(morgan("dev"));

// ── Helper: montar ruta solo si el módulo cargó ───────────────────────────────
const mount = (path, router) => {
  if (!router) {
    console.warn(`⚠️  Ruta no montada: ${path} (módulo no disponible)`);
    return;
  }
  app.use(path, router);
};

// ── ORDEN CRÍTICO: variantsBundles ANTES que products ────────────────────────
// Esto es necesario porque variants_bundles.routes usa prefijos /products/:id/...
// que de lo contrario serían capturados por el GET /:id de products.routes
mount("/api",              variantsBundlesRoutes);
mount("/api/products",     productsRoutes);
mount("/api/auth",         authRoutes);
mount("/api/users",        usersRoutes);
mount("/api/roles",        rolesRoutes);
mount("/api/providers",    providersRoutes);
mount("/api/categories",   categoriesRoutes);
mount("/api/sales",        salesRoutes);
mount("/api/discounts",    discountsRoutes);
mount("/api/banners",      bannersRoutes);
mount("/api/finance",      financeRoutes);
mount("/api/notifications", notificationsRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  message: "API Alesteb OK",
  timestamp: new Date().toISOString(),
  routes: {
    auth:          !!authRoutes,
    products:      !!productsRoutes,
    variantsBundles: !!variantsBundlesRoutes,
    notifications: !!notificationsRoutes,
    finance:       !!financeRoutes,
  }
}));

// ── Error handler global ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("[GLOBAL ERROR]", err.message, err.stack);
  res.status(500).json({
    success: false,
    message: "Error interno del servidor",
    ...(process.env.NODE_ENV !== "production" && { detail: err.message })
  });
});

module.exports = app;
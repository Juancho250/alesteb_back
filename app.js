const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const authRoutes           = require("./routes/auth.routes");
const usersRoutes          = require("./routes/users.routes");
const rolesRoutes          = require("./routes/roles.routes");
const providersRoutes      = require("./routes/providers.routes");
const financeRoutes        = require("./routes/finance.routes");
const productsRoutes       = require("./routes/products.routes");
const variantsBundlesRoutes = require("./routes/variants_bundles.routes");
const categoriesRoutes     = require("./routes/categories.routes");
const discountsRoutes      = require("./routes/discounts.routes");
const salesRoutes          = require("./routes/sales.routes");
const bannersRoutes        = require("./routes/banners.routes");
const notificationsRoutes  = require("./routes/notifications.routes");

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(morgan("dev"));

// ── El orden importa: variantsBundles ANTES que products ──────────────────────
// variants_bundles.routes maneja:
//   POST   /api/bundles
//   GET    /api/products/:productId/variants
//   POST   /api/products/:productId/variants
//   PUT    /api/products/:productId/variants/:variantId
//   DELETE /api/products/:productId/variants/:variantId
//   GET    /api/products/:bundleId/bundle-items
//   PUT    /api/products/:bundleId/bundle-items
//   GET    /api/attributes
//   POST   /api/attributes/:typeId/values
app.use("/api", variantsBundlesRoutes); // ← montado en /api, NO en /api/variants-bundles

// products.routes maneja el CRUD base: GET /, GET /:id, POST /, PUT /:id, DELETE /:id
app.use("/api/products", productsRoutes);

app.use("/api/auth",          authRoutes);
app.use("/api/users",         usersRoutes);
app.use("/api/roles",         rolesRoutes);
app.use("/api/providers",     providersRoutes);
app.use("/api/categories",    categoriesRoutes);
app.use("/api/sales",         salesRoutes);
app.use("/api/discounts",     discountsRoutes);
app.use("/api/banners",       bannersRoutes);
app.use("/api/finance",       financeRoutes);
app.use("/api/notifications", notificationsRoutes);

app.get("/", (req, res) => res.json({ message: "API Alesteb OK" }));

module.exports = app;
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
require("dotenv").config();

const logger = require("./utils/logger");
const errorHandler = require("./middleware/errorHandler");

// Importaciones de rutas
const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const rolesRoutes = require("./routes/roles.routes");
const productRoutes = require("./routes/products.routes");
const categoryRoutes = require("./routes/categories.routes");
const salesRoutes = require("./routes/sales.routes");
const expensesRoutes = require("./routes/expenses.routes");
const providersRoutes = require("./routes/providers.routes");
const discountRoutes = require("./routes/discounts.routes");
const bannerRoutes = require("./routes/banners.routes");
const contactRoutes = require("./routes/contact.routes");

const app = express();

// ===============================
// TRUST PROXY (CRÍTICO - antes de todo)
// ===============================
app.set("trust proxy", 1);

// ===============================
// CORS
// ===============================
// En producción (Render): lees ALLOWED_ORIGINS o FRONTEND_URL desde env vars
// En desarrollo local: siempre permites localhost:5173
const getAllowedOrigins = () => {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim());
  }

  const origins = ["http://localhost:5173", "http://localhost:3000"];

  // Si hay FRONTEND_URL definida (producción), la agregas
  if (process.env.FRONTEND_URL) {
    origins.push(process.env.FRONTEND_URL.trim());
  }

  return origins;
};

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = getAllowedOrigins();

      // Permitir peticiones sin origin (mismo dominio, tools, etc.)
      if (!origin) return callback(null, true);

      if (allowed.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn(`CORS bloqueado para origin: ${origin}`);
        callback(null, false);
      }
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  })
);

// ===============================
// SEGURIDAD
// ===============================
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

// ===============================
// MIDDLEWARES
// ===============================
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Logging de requests
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
  next();
});

// ===============================
// HEALTH CHECK (antes de las rutas)
// ===============================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_, res) => {
  res.json({
    message: "API Alesteb OK",
    version: "2.0.0",
  });
});

// ===============================
// RUTAS
// ===============================
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/providers", providersRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api/contact", contactRoutes);

// ===============================
// MANEJO DE ERRORES (ÚLTIMO)
// ===============================
app.use((req, res) => {
  res.status(404).json({
    status: "error",
    code: "NOT_FOUND",
    message: `Ruta ${req.path} no encontrada`,
  });
});

app.use(errorHandler);

// ===============================
// SERVER
// ===============================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📦 Entorno: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔒 Trust Proxy: ${app.get("trust proxy")}`);
  console.log(`🌐 Origins permitidos: ${JSON.stringify(getAllowedOrigins())}`);
});

module.exports = app;
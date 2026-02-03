const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const logger = require("./utils/logger"); // ← AGREGAR
const errorHandler = require("./middleware/errorHandler"); // ← AGREGAR

// Importaciones de rutas
const expensesRoutes = require("./routes/expenses.routes");
const authRoutes = require("./routes/auth.routes");
const productRoutes = require("./routes/products.routes");
const categoryRoutes = require("./routes/categories.routes");
const salesRoutes = require("./routes/sales.routes");
const usersRoutes = require("./routes/users.routes");
const rolesRoutes = require("./routes/roles.routes");
const bannerRoutes = require("./routes/banners.routes");
const discountRoutes = require("./routes/discounts.routes");
const providersRoutes = require("./routes/providers.routes"); 
const contactRoutes = require("./routes/contact.routes");

const app = express();

// ===============================
// SEGURIDAD Y MIDDLEWARE
// ===============================

// CORS más restrictivo (actualizar en producción)
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://localhost:5173'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"]
}));

// Helmet con configuración
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Trust proxy si estás detrás de nginx/cloudflare
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Logging de requests (opcional - comentar si no quieres logs de cada request)
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// ===============================
// RUTAS
// ===============================

app.use("/api/auth", authRoutes);
app.use("/api/providers", providersRoutes);
app.use("/api", expensesRoutes);
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api/contact", contactRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.get("/", (_, res) => {
  res.json({ 
    message: "API Alesteb OK",
    version: "2.0.0",
    docs: "/api/docs" // Si implementas swagger
  });
});

// ===============================
// MANEJO DE ERRORES (ÚLTIMO)
// ===============================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    code: 'NOT_FOUND',
    message: `Ruta ${req.path} no encontrada`
  });
});

// Error Handler
app.use(errorHandler);

module.exports = app;
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

// Importar todas las rutas
const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const rolesRoutes = require("./routes/roles.routes");
const permissionsRoutes = require("./routes/permissions.routes");
const providersRoutes = require("./routes/providers.routes");
const purchaseOrdersRoutes = require("./routes/purchase_orders.routes");
const productsRoutes = require("./routes/products.routes");
const categoriesRoutes = require("./routes/categories.routes");
const discountsRoutes = require("./routes/discounts.routes");
const salesRoutes = require("./routes/sales.routes");
const expensesRoutes = require("./routes/expenses.routes");
const bannersRoutes = require("./routes/banners.routes");

const app = express();

// ============================================
// MIDDLEWARE GLOBAL
// ============================================

// Seguridad
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "https:", "data:", "blob:"],
    },
  },
}));

// CORS configurado para producción
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  credentials: true
}));

// Parsers
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Logging en desarrollo
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// ============================================
// HEALTH CHECK
// ============================================
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "API Alesteb - Sistema de Inventario y Contabilidad",
    version: "2.0.0",
    documentation: "/api-docs",
    endpoints: {
      auth: "/api/auth",
      users: "/api/users",
      products: "/api/products",
      categories: "/api/categories",
      providers: "/api/providers",
      purchase_orders: "/api/purchase-orders",
      sales: "/api/sales",
      expenses: "/api/expenses",
      discounts: "/api/discounts",
      banners: "/api/banners"
    }
  });
});

// ============================================
// RUTAS DE LA API
// ============================================

// Autenticación y autorización
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/permissions", permissionsRoutes);

// Módulo de proveedores y compras
app.use("/api/providers", providersRoutes);
app.use("/api/purchase-orders", purchaseOrdersRoutes);

// Módulo de productos e inventario
app.use("/api/products", productsRoutes);
app.use("/api/categories", categoriesRoutes);

// Módulo de ventas
app.use("/api/sales", salesRoutes);

// Módulo de finanzas
app.use("/api/expenses", expensesRoutes);

// Módulo de marketing
app.use("/api/discounts", discountsRoutes);
app.use("/api/banners", bannersRoutes);

// ============================================
// MANEJO DE ERRORES
// ============================================

// Ruta no encontrada
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    message: `Cannot ${req.method} ${req.path}`,
    availableEndpoints: "/api-docs"
  });
});

// Manejador global de errores
app.use((err, req, res, next) => {
  console.error("UNHANDLED ERROR:", err);

  // Error de validación de Multer
  if (err.name === "MulterError") {
    return res.status(400).json({
      error: "File upload error",
      message: err.message
    });
  }

  // Error de JWT
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      error: "Invalid token",
      message: "Authentication failed"
    });
  }

  // Error de validación de base de datos
  if (err.code === "23505") { // Unique violation
    return res.status(409).json({
      error: "Duplicate entry",
      message: "This record already exists"
    });
  }

  if (err.code === "23503") { // Foreign key violation
    return res.status(400).json({
      error: "Reference error",
      message: "Cannot delete: record is being referenced"
    });
  }

  // Error genérico
  res.status(err.status || 500).json({
    error: err.name || "Internal Server Error",
    message: process.env.NODE_ENV === "production" 
      ? "An error occurred" 
      : err.message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack })
  });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing HTTP server");
  process.exit(0);
});

module.exports = app;
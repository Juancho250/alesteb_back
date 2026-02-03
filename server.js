const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
require("dotenv").config();

const app = express();

// ===============================
// CONFIGURACIÓN DE TRUST PROXY (CRÍTICO)
// ===============================
// DEBE estar ANTES de cualquier middleware que use req.ip
app.set('trust proxy', 1); // Confiar en el primer proxy (Render.com)

// ===============================
// SECURITY HEADERS
// ===============================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// ===============================
// MIDDLEWARES
// ===============================
app.use(compression()); // Comprimir respuestas
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===============================
// HEALTH CHECK
// ===============================
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ===============================
// ROUTES
// ===============================
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/users", require("./routes/users.routes"));
app.use("/api/products", require("./routes/products.routes"));
app.use("/api/categories", require("./routes/categories.routes"));
app.use("/api/sales", require("./routes/sales.routes"));
app.use("/api/expenses", require("./routes/expenses.routes"));
app.use("/api/providers", require("./routes/providers.routes"));
app.use("/api/purchase-orders", require("./routes/purchaseOrders.routes"));
app.use("/api/discounts", require("./routes/discounts.routes"));
app.use("/api/banners", require("./routes/banners.routes"));
app.use("/api/analytics", require("./routes/analytics.routes"));

// ===============================
// ERROR HANDLING
// ===============================
const { secureErrorHandler } = require("./middleware/auth.middleware");
app.use(secureErrorHandler);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ message: "Ruta no encontrada" });
});

// ===============================
// SERVER
// ===============================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📦 Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔒 Trust Proxy: ${app.get('trust proxy')}`);
});

module.exports = app;
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

// Importar todas las rutas (Ajustadas a tus nombres anteriores)
const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const rolesRoutes = require("./routes/roles.routes");
const providersRoutes = require("./routes/providers.routes");
// Si este archivo no existe físicamente en /routes, dará error. 
// Pruébalo comentando la siguiente línea si sigue fallando:
// const purchaseOrdersRoutes = require("./routes/purchase_orders.routes"); 
const productsRoutes = require("./routes/products.routes");
const categoriesRoutes = require("./routes/categories.routes");
const discountsRoutes = require("./routes/discounts.routes");
const salesRoutes = require("./routes/sales.routes");
const expensesRoutes = require("./routes/expenses.routes");
const bannersRoutes = require("./routes/banners.routes");

const app = express();

// MIDDLEWARE
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(morgan("dev"));

// RUTAS
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/providers", providersRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/discounts", discountsRoutes);
app.use("/api/banners", bannersRoutes);

// Solo si el archivo existe
// app.use("/api/purchase-orders", purchaseOrdersRoutes);

app.get("/", (req, res) => {
  res.json({ message: "API Alesteb OK" });
});

module.exports = app;
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const expensesRoutes = require("./routes/expenses.routes");
const authRoutes = require("./routes/auth.routes");
const productRoutes = require("./routes/products.routes");
const categoryRoutes = require("./routes/categories.routes");
const salesRoutes = require("./routes/sales.routes");
const usersRoutes = require("./routes/users.routes");
const rolesRoutes = require("./routes/roles.routes");
const bannerRoutes = require("./routes/banners.routes");
const discountRoutes = require("./routes/discounts.routes");
const permissions = require("./routes/permissions.routes");

const app = express();

app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "DELETE"]
}));

app.use(express.json());
app.use(helmet());

// RUTAS
app.use("/api/auth", authRoutes);
app.use("/api/expenses", expensesRoutes);
app.use("/api/products", productRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/roles", rolesRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api/permissions", permissions);

app.get("/", (_, res) => {
  res.send("API Alesteb OK");
});

module.exports = app;

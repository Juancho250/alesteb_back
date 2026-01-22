import express from "express";
import cors from "cors";
import helmet from "helmet";

import expensesRoutes from "./routes/expenses.routes.js";
import authRoutes from "./routes/auth.routes.js";
import productRoutes from "./routes/products.routes.js";
import categoryRoutes from "./routes/categories.routes.js";
import salesRoutes from "./routes/sales.routes.js";
import usersRoutes from "./routes/users.routes.js";
import rolesRoutes from "./routes/roles.routes.js";
import bannerRoutes from "./routes/banners.routes.js";
import discountRoutes from "./routes/discounts.routes.js";

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

app.get("/", (_, res) => {
  res.send("API Alesteb OK");
});

export default app;
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const authRoutes = require("./routes/auth.routes");
const productRoutes = require("./routes/products.routes");
const rolesRoutes = require('./routes/roles.routes');
const usersRoutes = require('./routes/users.routes'); 
const salesRoutes = require("./routes/sales.routes");
const bannerRoutes = require("./routes/banners.routes");
const app = express();


app.use(cors());
app.use(express.json());
app.use("/api/banners", bannerRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/stats", require("./routes/stats.routes"));
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use(
  cors({
    origin: "*", // luego lo restringimos
  })
);
module.exports = app;


app.use(helmet());
app.use(cors({
  origin: [
    "https://alestebadmin.vercel.app",
    "https://alesteb.vercel.app/"
  ],
  credentials: true
}));

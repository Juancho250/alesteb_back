const express = require("express");
const router = express.Router();
const {
  createSale,
  getSales,
  getSaleById,
  getUserSales,   // Asegúrate de que esta función esté definida en el controlador
  getUserStats,   // Asegúrate de que esta función esté definida en el controlador
} = require("../controllers/sales.controller");
const { verifyToken } = require("../middleware/auth.middleware");

// Rutas para el Usuario/Cliente (Dashboard)
router.get("/user/history", verifyToken, getUserSales); // Registros
router.get("/user/stats", verifyToken, getUserStats);   // Resúmenes y Gráficas

// Rutas Generales / Admin
router.post("/", verifyToken, createSale); // El carrito usará esta
router.get("/", verifyToken, getSales);
router.get("/:id", verifyToken, getSaleById);

module.exports = router;

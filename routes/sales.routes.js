const express = require("express");
const router = express.Router();
const salesController = require("../controllers/sales.controller");
const { verifyToken } = require("../middleware/auth.middleware"); // Asegúrate de tener este middleware

// Rutas para el Usuario/Cliente (Dashboard)
router.get("/user/history", verifyToken, salesController.getUserSales); // Registros
router.get("/user/stats", verifyToken, salesController.getUserStats);   // Resúmenes y Gráficas

// Rutas Generales / Admin
router.post("/", verifyToken, salesController.createSale); // El carrito usará esta
router.get("/", verifyToken, salesController.getSales);
router.get("/:id", verifyToken, salesController.getSaleById);

module.exports = router;
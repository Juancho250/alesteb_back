const express = require("express");
const router = express.Router();
const {
  createSale,
  getSales,
  getSaleById,
  getUserSales,
  getUserStats,
} = require("../controllers/sales.controller");

// Rutas para el Usuario/Cliente (Dashboard)
router.get("/user/history", getUserSales);
router.get("/user/stats", getUserStats);

// Rutas Generales / Admin
router.post("/", createSale);
router.get("/", getSales);
router.get("/:id", getSaleById);

module.exports = router;
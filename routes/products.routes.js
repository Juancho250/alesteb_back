// routes/products.js - AGREGAR ESTA RUTA

const express = require("express");
const router = express.Router();
const productsController = require("../controllers/products.controller");
const upload = require("../middleware/upload");

// Rutas existentes...
router.get("/", productsController.getAll);
router.get("/:id", productsController.getById);
router.post("/", upload.array("images", 10), productsController.create);
router.put("/:id", upload.array("images", 10), productsController.update);
router.delete("/:id", productsController.remove);

// 🆕 NUEVA RUTA: Historial de compras del producto
router.get("/:id/purchase-history", productsController.getPurchaseHistory);

module.exports = router;
const express = require("express");
const router = express.Router();
const categoriesController = require("../controllers/categories.controller");
const authMiddleware = require("../middleware/auth.middleware");

// Públicas (Para el menú de la tienda)
router.get("/", categoriesController.getTree); 

// Privadas/Admin (Para el selector de productos y gestión)
router.get("/flat", authMiddleware, categoriesController.getFlatList); 
router.post("/", authMiddleware, categoriesController.create);
router.delete("/:id", authMiddleware, categoriesController.remove);

module.exports = router;
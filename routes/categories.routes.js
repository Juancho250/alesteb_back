const express = require("express");
const router = express.Router();
const categoriesController = require("../controllers/categories.controller");
const { auth, requireRole } = require("../middleware/auth.middleware");

// Públicas (Para el menú de la tienda)
router.get("/", categoriesController.getTree); 

// Privadas/Admin (Para el selector de productos y gestión)
router.get("/flat", auth, requireRole(["admin"]), categoriesController.getFlatList); 
router.post("/", auth, requireRole(["admin"]), categoriesController.create);
router.delete("/:id", auth, requireRole(["admin"]), categoriesController.remove);

module.exports = router;
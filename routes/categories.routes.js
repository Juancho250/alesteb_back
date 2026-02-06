const express = require("express");
const router = express.Router();
const categoriesController = require("../controllers/categories.controller");
const { auth, requireRole } = require("../middleware/auth.middleware");

// Públicas (Para el menú de la tienda)
router.get("/", categoriesController.getTree); 
// routes/categories.routes.js
router.get("/", categoriesController.getTree);
router.get("/slug/:slug", categoriesController.getBySlug); // <--- AÑADE ESTA LÍNEA
// Privadas/Admin (Para el selector de productos y gestión)
router.get("/flat", auth, requireRole(["admin"]), categoriesController.getFlatList); 
router.post("/", auth, requireRole(["admin"]), categoriesController.create);
router.delete("/:id", auth, requireRole(["admin"]), categoriesController.remove);

module.exports = router;
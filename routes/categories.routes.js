const express = require("express");
const router = express.Router();
const categoriesController = require("../controllers/categories.controller");
// CAMBIO AQUÍ: Importar 'auth' específicamente
const { auth } = require("../middleware/auth.middleware"); 

// Públicas
router.get("/", categoriesController.getTree); 

// Privadas (Cambiamos authMiddleware por auth)
router.get("/flat", auth, categoriesController.getFlatList); 
router.post("/", auth, categoriesController.create);
router.delete("/:id", auth, categoriesController.remove);

module.exports = router;
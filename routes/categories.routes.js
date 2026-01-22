import express from "express";
import * as categoriesController from "../controllers/categories.controller.js";
import authMiddleware from "../middleware/auth.middleware.js";

const router = express.Router();

// Públicas (Para el menú de la tienda)
router.get("/", categoriesController.getTree); 

// Privadas/Admin (Para el selector de productos y gestión)
router.get("/flat", authMiddleware, categoriesController.getFlatList); 
router.post("/", authMiddleware, categoriesController.create);
router.delete("/:id", authMiddleware, categoriesController.remove);

export default router;
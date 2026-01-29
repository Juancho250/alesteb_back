const express = require("express");
const router = express.Router();
// Importamos el controlador
const ctrl = require("../controllers/products.controller");
// CORRECCIÓN: Nombre exacto del archivo en la carpeta middleware
const upload = require("../middleware/upload.middleware");

// --- RUTAS DE CATÁLOGO ---
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);

// --- RUTAS DE GESTIÓN (Con subida de imágenes) ---
router.post("/", upload.array("images", 10), ctrl.create);
router.put("/:id", upload.array("images", 10), ctrl.update);
router.delete("/:id", ctrl.remove);

// --- 🆕 NUEVA RUTA: HISTORIAL DE COMPRAS ---
// Asegúrate de que esta función 'getPurchaseHistory' esté en tu controller
router.get("/:id/purchase-history", ctrl.getPurchaseHistory);

module.exports = router;
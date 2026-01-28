const express = require("express");
const router = express.Router();
const bannerController = require("../controllers/banners.controller");
const upload = require("../middleware/upload.middleware");
// Importamos auth e isAdmin (que ya definiste en tu middleware)
const { auth, isAdmin } = require("../middleware/auth.middleware");

// --- RUTAS PÚBLICAS ---
router.get("/", bannerController.getAll);

// --- RUTAS PRIVADAS (Panel de Administración) ---
// Ahora usamos 'isAdmin' directamente, que es mucho más corto y limpio
router.post(
    "/", 
    auth, 
    isAdmin, 
    upload.single("image"), 
    bannerController.create
);

router.put(
    "/:id", 
    auth, 
    isAdmin, 
    upload.single("image"), 
    bannerController.update
);

router.delete(
    "/:id", 
    auth, 
    isAdmin, 
    bannerController.delete
);

module.exports = router;
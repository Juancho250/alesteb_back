const express = require("express");
const router = express.Router();
const bannerController = require("../controllers/banners.controller");
const upload = require("../middleware/upload.middleware");
const { auth, requirePermission } = require("../middleware/auth.middleware");

// --- RUTAS PÚBLICAS ---
// Quitamos 'auth' y 'requirePermission' para que el carrusel de la web principal funcione
router.get("/", bannerController.getAll);

// --- RUTAS PRIVADAS (Panel de Administración) ---
// Crear: Requiere estar logueado y tener permiso 'banner.create'
router.post(
    "/", 
    auth, 
    requirePermission("banner.create"), 
    upload.single("image"), 
    bannerController.create
);

// Editar: Requiere estar logueado y tener permiso 'banner.update'
router.put(
    "/:id", 
    auth, 
    requirePermission("banner.update"), 
    upload.single("image"), 
    bannerController.update
);

// Eliminar: Requiere estar logueado y tener permiso 'banner.delete'
router.delete(
    "/:id", 
    auth, 
    requirePermission("banner.delete"), 
    bannerController.delete
);

module.exports = router;
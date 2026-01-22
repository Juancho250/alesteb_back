const express = require("express");
const router = express.Router();
const bannerController = require("../controllers/banners.controller");
const upload = require("../middleware/upload.middleware");
const { auth, requirePermission } = require("../middleware/auth.middleware"); //

// Listar: Cualquiera con permiso de lectura
router.get("/", auth, requirePermission("banner.read"), bannerController.getAll);

// Crear: Solo permiso create
router.post("/", auth, requirePermission("banner.create"), upload.single("image"), bannerController.create);

// Editar: Solo permiso update
router.put("/:id", auth, requirePermission("banner.update"), upload.single("image"), bannerController.update);

// Eliminar: Solo permiso delete
router.delete("/:id", auth, requirePermission("banner.delete"), bannerController.delete);

module.exports = router;
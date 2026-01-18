const express = require("express");
const router = express.Router();
const bannerController = require("../controllers/banners.controller");
const upload = require("../middleware/upload.middleware"); // El que ya usas para productos

// Rutas públicas/admin
router.get("/", bannerController.getAll);

// Estas rutas deberían estar protegidas por tu auth.middleware si lo deseas
router.post("/", upload.single("image"), bannerController.create);
router.put("/:id", upload.single("image"), bannerController.update);
router.delete("/:id", bannerController.delete);

module.exports = router;
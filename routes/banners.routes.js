const express = require("express");
const router = express.Router();
const bannerController = require("../controllers/banners.controller");
const upload = require("../middleware/upload.middleware");

// Todas las rutas públicas
router.get("/", bannerController.getAll);
router.post("/", upload.single("image"), bannerController.create);
router.put("/:id", upload.single("image"), bannerController.update);
router.delete("/:id", bannerController.delete);

module.exports = router;
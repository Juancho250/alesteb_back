const express = require("express");
const router  = express.Router();
const bannerController = require("../controllers/banners.controller");
const { uploadBanner } = require("../middleware/upload.middleware");
const { auth, requireManager } = require("../middleware/auth.middleware");

// Pública — storefront, con caché
router.get("/", bannerController.getAll);

// ✅ NUEVO: panel admin — autenticada, sin caché
router.get("/admin", auth, requireManager, bannerController.getAllAdmin);

// Mutaciones — requieren auth
router.post(  "/",    auth, requireManager, uploadBanner.single("image"), bannerController.create);
router.put(   "/:id", auth, requireManager, uploadBanner.single("image"), bannerController.update);
router.delete("/:id", auth, requireManager, bannerController.delete);

module.exports = router;
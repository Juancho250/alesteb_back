const express = require("express");
const router  = express.Router();
const bannerController = require("../controllers/banners.controller");
const { uploadBanner } = require("../middleware/upload.middleware");
const { auth, requireManager } = require("../middleware/auth.middleware");
const { adminScope } = require("../middleware/adminScope");

// Pública — storefront, con caché
router.get("/", bannerController.getAll);

// Panel admin — autenticada, con scope de tenant
router.get("/admin", auth, adminScope, requireManager, bannerController.getAllAdmin);

// Mutaciones — requieren auth + scope
router.post(  "/",    auth, adminScope, requireManager, uploadBanner.single("image"), bannerController.create);
router.put(   "/:id", auth, adminScope, requireManager, uploadBanner.single("image"), bannerController.update);
router.delete("/:id", auth, adminScope, requireManager, bannerController.delete);

module.exports = router;
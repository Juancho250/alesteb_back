const express = require("express");
const router  = express.Router();
const bannerController = require("../controllers/banners.controller");
const { uploadBanner } = require("../middleware/upload.middleware");
const { auth, requireManager } = require("../middleware/auth.middleware");

router.get("/", bannerController.getAll);

router.post("/", auth, requireManager, uploadBanner.single("image"), bannerController.create);
router.put("/:id", auth, requireManager, uploadBanner.single("image"), bannerController.update);
router.delete("/:id", auth, requireManager, bannerController.delete);

module.exports = router;
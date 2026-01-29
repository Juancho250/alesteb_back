const express = require("express");
const upload = require("../middleware/upload.middleware");
const ctrl = require("../controllers/products.controller");

const router = express.Router();

// Todas las rutas públicas
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);

router.post(
  "/",
  upload.array("images", 6),
  ctrl.create
);

router.put(
  "/:id",
  upload.array("images", 6),
  ctrl.update
);

router.delete(
  "/:id",
  ctrl.remove
);

module.exports = router;
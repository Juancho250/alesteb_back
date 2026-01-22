const express = require("express");
const router = express.Router();
const { auth, requireRole } = require("../middleware/auth.middleware");
const upload = require("../middleware/upload.middleware");
const ctrl = require("../controllers/products.controller");

// 🌐 PÚBLICO
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);

// 🔐 SOLO ADMIN
router.post(
  "/",
  auth,
  requireRole(["admin"]),
  upload.array("images", 6),
  ctrl.create
);

router.put(
  "/:id",
  auth,
  requireRole(["admin"]),
  ctrl.update
);

router.delete(
  "/:id",
  auth,
  requireRole(["admin"]),
  ctrl.remove
);

module.exports = router;
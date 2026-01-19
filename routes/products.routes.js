const router = require("express").Router();
const { auth } = require("../middleware/auth.middleware");
const ctrl = require("../controllers/products.controller");
const upload = require("../middleware/upload.middleware");

// 🔐 CREAR PRODUCTO (ADMIN)
router.post(
  "/",
  auth,
  upload.array("images", 6),
  ctrl.create
);

// 🌐 RUTAS PÚBLICAS
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);

// 🔐 ACTUALIZAR / ELIMINAR (ADMIN)
router.put("/:id", auth, ctrl.update);
router.delete("/:id", auth, ctrl.remove);

module.exports = router;

const router = require("express").Router();
const auth = require("../middleware/auth.middleware");
const ctrl = require("../controllers/products.controller");
const upload = require("../middleware/upload.middleware");

// PRIVADAS (ADMIN)
router.post("/", auth, upload.single("image"), ctrl.create);
    
// 🌐 RUTAS PÚBLICAS (WEB)
router.get("/", ctrl.getAll);
router.get("/:id", ctrl.getById);

// 🔐 RUTAS PRIVADAS (ADMIN)
router.post("/", auth, ctrl.create);
router.put("/:id", auth, ctrl.update);
router.delete("/:id", auth, ctrl.remove);

module.exports = router;

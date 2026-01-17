const router = require("express").Router();
const auth = require("../middleware/auth.middleware");
const ctrl = require("../controllers/products.controller");

router.use(auth);

router.get("/", ctrl.getAll);
router.post("/", ctrl.create);
router.put("/:id", ctrl.update);
router.delete("/:id", ctrl.remove);

module.exports = router;

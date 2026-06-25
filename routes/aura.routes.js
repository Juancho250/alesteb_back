const express = require("express");
const { auth } = require("../middleware/auth.middleware");
const { adminScope } = require("../middleware/adminScope");
const { chat } = require("../controllers/aura.controller");

const router = express.Router();

router.use(auth);
router.use(adminScope);

router.post("/chat", chat);

module.exports = router;

const { Router } = require("express");
const { chat } = require("../controllers/agent.controller");
const authMiddleware = require("../middleware/auth.middleware");

const router = Router();
router.post("/chat", authMiddleware, chat);

module.exports = router;
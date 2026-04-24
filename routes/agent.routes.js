const express = require("express");
const { auth } = require("../middleware/auth.middleware");
const { chat } = require("../controllers/agent.controller");

const router = express.Router();

router.post("/chat", auth, chat);

module.exports = router;
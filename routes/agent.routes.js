const express = require("express");
const { auth, requireManager, checkRateLimit } = require("../src/modules/identity/auth");
const { adminScope } = require("../middleware/adminScope");
const { requireFeature, requireActiveSubscription } = require("../middleware/subscription.middleware");
const { resolveAuraTenant } = require("../middleware/aura.middleware");
const { auraQuota } = require("../middleware/auraQuota.middleware");
const ctrl = require("../controllers/agent.controller");

const router = express.Router();

router.use(auth);
router.use(adminScope);
router.use(requireManager);
router.use(requireActiveSubscription);
router.use(requireFeature("has_ai_agent"));
router.use(resolveAuraTenant);

router.post(
  "/chat",
  checkRateLimit((req) => `agent-compat:${req.user.id}:${req.ip}`, 20, 60_000),
  ctrl.validateChatRequest,
  auraQuota,
  ctrl.chat
);
router.post("/confirm", ctrl.confirmAction);
router.get("/conversations", ctrl.listConversations);
router.get("/conversations/:id", ctrl.getConversation);
router.delete("/conversations/:id", ctrl.deleteConversation);

module.exports = router;

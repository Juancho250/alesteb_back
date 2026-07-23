const express = require("express");
const { auth, requireAdmin, requireManager, checkRateLimit } = require("../identity/auth");
const { adminScope } = require("../../../middleware/adminScope");
const { requireFeature, requireActiveSubscription } = require("../subscriptions").middleware;
const { resolveAuraTenant } = require("./middleware/tenant.middleware");
const { auraQuota } = require("./middleware/quota.middleware");
const ctrl = require("./controllers/aura.controller");
const campaignCtrl = require("./controllers/campaigns.controller");
const imageCtrl = require("./controllers/images.controller");
const actionCtrl = require("./controllers/actions.controller");
const predictionCtrl = require("./controllers/predictions.controller");
const customerCtrl = require("./controllers/customers.controller");
const voiceModule = require("./voice");
const operationsCtrl = require("./controllers/operations.controller");
const voiceCtrl = voiceModule.controller;
const { auraVoiceUpload } = voiceModule.uploadMiddleware;

const router = express.Router();

router.use(auth);
router.use(adminScope);
router.use(requireManager);
router.use(requireActiveSubscription);
router.use(requireFeature("has_ai_agent"));
router.use(resolveAuraTenant);

router.post(
  "/campaigns/draft",
  checkRateLimit((req) => `aura:campaigns:${req.user.id}:${req.ip}`, 30, 60_000),
  campaignCtrl.createDraft
);
router.get("/campaigns", campaignCtrl.list);
router.get("/campaigns/send-time-recommendation", campaignCtrl.sendTimeRecommendation);
router.get("/campaigns/:id/preview", campaignCtrl.previewDelivery);
router.get("/campaigns/:id", campaignCtrl.getById);
router.put("/campaigns/:id", campaignCtrl.update);
router.delete("/campaigns/:id", campaignCtrl.remove);
router.post("/campaigns/:id/estimate-audience", campaignCtrl.estimateAudience);
router.get("/campaigns/:campaignId/assets", imageCtrl.listCampaignAssets);
router.delete("/campaign-assets/:id", imageCtrl.deleteAsset);

router.post(
  "/images/generate",
  checkRateLimit((req) => `aura:images:${req.user.id}:${req.ip}`, 20, 60_000),
  imageCtrl.generate
);
router.post(
  "/images/edit",
  checkRateLimit((req) => `aura:images:${req.user.id}:${req.ip}`, 20, 60_000),
  imageCtrl.edit
);
router.get("/images/jobs/:id", imageCtrl.getJob);

router.get("/conversations", ctrl.listConversations);
router.get("/conversations/:id", ctrl.getConversation);
router.delete("/conversations/:id", ctrl.deleteConversation);
router.get("/usage", ctrl.getUsage);
router.get("/operations/health", requireAdmin, operationsCtrl.health);

router.post(
  "/voice/sessions",
  checkRateLimit((req) => `aura:voice:sessions:${req.user.id}:${req.ip}`, 20, 60_000),
  voiceCtrl.requireVoiceEnabled,
  voiceCtrl.createSession
);
router.get(
  "/voice/sessions/:id",
  checkRateLimit((req) => `aura:voice:sessions:get:${req.user.id}:${req.ip}`, 60, 60_000),
  voiceCtrl.requireVoiceEnabled,
  voiceCtrl.getSession
);
router.delete(
  "/voice/sessions/:id",
  checkRateLimit((req) => `aura:voice:sessions:close:${req.user.id}:${req.ip}`, 30, 60_000),
  voiceCtrl.requireVoiceEnabled,
  voiceCtrl.closeSession
);
router.post(
  "/voice/sessions/:id/turn",
  checkRateLimit((req) => `aura:voice:turn:${req.user.id}:${req.ip}`, 12, 60_000),
  voiceCtrl.requireVoiceEnabled,
  auraVoiceUpload,
  voiceCtrl.validateVoiceTurnRequest,
  auraQuota,
  voiceCtrl.processTurn
);

router.get("/predictions/demand", predictionCtrl.getDemand);
router.get("/predictions/restock", predictionCtrl.getRestock);
router.post(
  "/predictions/recalculate",
  requireAdmin,
  checkRateLimit((req) => `aura:predictions:recalculate:${req.user.id}:${req.ip}`, 10, 60_000),
  predictionCtrl.recalculate
);

router.get("/customers/segments", customerCtrl.getSegments);
router.get("/customers/churn-summary", customerCtrl.getChurnSummary);
router.get("/customers/repurchase-opportunities", customerCtrl.getRepurchaseOpportunities);

router.get("/actions", actionCtrl.list);
router.get("/actions/:id", actionCtrl.getById);
router.post(
  "/actions/:id/approve",
  checkRateLimit((req) => `aura:actions:approve:${req.user.id}:${req.ip}`, 30, 60_000),
  actionCtrl.approve
);
router.post(
  "/actions/:id/reject",
  checkRateLimit((req) => `aura:actions:reject:${req.user.id}:${req.ip}`, 30, 60_000),
  actionCtrl.reject
);

router.post(
  "/chat",
  checkRateLimit((req) => `aura:${req.user.id}:${req.ip}`, 20, 60_000),
  ctrl.validateChatRequest,
  auraQuota,
  ctrl.chat
);

module.exports = router;

const campaigns = require("../../../../services/auraCampaigns.service");
const sendTime = require("../../../../services/auraSendTime.service");

function ctxFromReq(req) {
  return {
    ownerAdminId: req.auraAdminId,
    userId: req.user.id,
    roles: req.user.roles || [],
  };
}

function sendError(req, res, err) {
  if (res.headersSent) return res;
  const status = err.status || 500;
  const message = status >= 500
    ? "Error al procesar campanas AURA"
    : err.message;
  return res.status(status).json({
    success: false,
    message,
    code: err.code || "AURA_CAMPAIGN_ERROR",
    requestId: req.id,
  });
}

exports.createDraft = async (req, res) => {
  try {
    const data = await campaigns.createCampaignDraft({
      ...ctxFromReq(req),
      payload: req.body || {},
    });
    return res.status(201).json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.list = async (req, res) => {
  try {
    const data = await campaigns.listCampaigns({
      ...ctxFromReq(req),
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.getById = async (req, res) => {
  try {
    const data = await campaigns.getCampaign({
      ...ctxFromReq(req),
      campaignId: req.params.id,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.update = async (req, res) => {
  try {
    const data = await campaigns.updateCampaign({
      ...ctxFromReq(req),
      campaignId: req.params.id,
      payload: req.body || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.remove = async (req, res) => {
  try {
    await campaigns.deleteCampaign({
      ...ctxFromReq(req),
      campaignId: req.params.id,
    });
    return res.json({ success: true, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.estimateAudience = async (req, res) => {
  try {
    const data = await campaigns.estimateCampaignAudience({
      ...ctxFromReq(req),
      campaignId: req.params.id,
      definition: req.body?.definition,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.previewDelivery = async (req, res) => {
  try {
    const data = await campaigns.previewCampaignDelivery({
      ...ctxFromReq(req),
      campaignId: req.params.id,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.sendTimeRecommendation = async (req, res) => {
  try {
    const data = await sendTime.getSendTimeRecommendation({
      ...ctxFromReq(req),
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

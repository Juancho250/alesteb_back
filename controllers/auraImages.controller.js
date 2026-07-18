const imageJobs = require("../services/auraImageJobs.service");

function ctxFromReq(req) {
  return {
    ownerAdminId: req.auraAdminId,
    userId: req.user.id,
    roles: req.user.roles || [],
  };
}

function sendError(req, res, err) {
  const status = err.status || 500;
  return res.status(status).json({
    success: false,
    message: status >= 500 ? "Error al procesar imagenes AURA" : err.message,
    code: err.code || "AURA_IMAGE_ERROR",
    requestId: req.id,
  });
}

function imageJobAccepted(res, req, result) {
  return res.status(result.deduped ? 200 : 202).json({
    success: true,
    accepted: !result.deduped,
    deduped: Boolean(result.deduped),
    cached: Boolean(result.cached),
    created: Boolean(result.created),
    jobId: result.job?.id,
    assetId: result.asset?.id || result.job?.input?.assetId || null,
    status: result.job?.status,
    data: {
      job: result.job,
      asset: result.asset,
      usage: result.usage || null,
    },
    requestId: req.id,
  });
}

exports.generate = async (req, res) => {
  try {
    const result = await imageJobs.enqueueImageJob({
      ...ctxFromReq(req),
      mode: "generate",
      payload: req.body || {},
    });
    return imageJobAccepted(res, req, result);
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.edit = async (req, res) => {
  try {
    const result = await imageJobs.enqueueImageJob({
      ...ctxFromReq(req),
      mode: "edit",
      payload: req.body || {},
    });
    return imageJobAccepted(res, req, result);
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.getJob = async (req, res) => {
  try {
    const data = await imageJobs.getJob({
      ...ctxFromReq(req),
      jobId: req.params.id,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.listCampaignAssets = async (req, res) => {
  try {
    const data = await imageJobs.listCampaignAssets({
      ...ctxFromReq(req),
      campaignId: req.params.campaignId,
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.deleteAsset = async (req, res) => {
  try {
    const data = await imageJobs.deleteCampaignAsset({
      ...ctxFromReq(req),
      assetId: req.params.id,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

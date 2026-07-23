const actions = require("../../../../services/auraActions.service");

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
    ? "Error al procesar accion AURA"
    : err.message;
  return res.status(status).json({
    success: false,
    message,
    code: err.code || "AURA_ACTION_ERROR",
    action: err.action || undefined,
    requestId: req.id,
  });
}

exports.list = async (req, res) => {
  try {
    const data = await actions.listActions({
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
    const data = await actions.getAction({
      ...ctxFromReq(req),
      actionId: req.params.id,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.approve = async (req, res) => {
  try {
    const data = await actions.approveAction({
      ...ctxFromReq(req),
      actionId: req.params.id,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.reject = async (req, res) => {
  try {
    const data = await actions.rejectAction({
      ...ctxFromReq(req),
      actionId: req.params.id,
      reason: req.body?.reason,
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

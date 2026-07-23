const customerGrowth = require("../../../../services/auraCustomerGrowth.service");

function ctxFromReq(req) {
  return {
    ownerAdminId: req.auraAdminId,
    userId: req.user.id,
    roles: req.user.roles || [],
  };
}

function sendError(req, res, err) {
  const known = {
    AURA_CUSTOMER_GROWTH_INVALID_DATE: [400, err.message],
    AURA_CUSTOMER_GROWTH_INVALID_INPUT: [400, err.message],
    AURA_CUSTOMER_DETAIL_FORBIDDEN: [403, "El detalle individual requiere rol admin"],
    AURA_CUSTOMER_GROWTH_CONTEXT_REQUIRED: [500, "Contexto AURA incompleto"],
  };
  const publicError = known[err.code];
  const [status, message] = publicError || [500, "Error procesando analitica de clientes AURA"];
  return res.status(status).json({
    success: false,
    message,
    code: publicError ? err.code : "AURA_CUSTOMER_GROWTH_ERROR",
    requestId: req.id,
  });
}

exports.getSegments = async (req, res) => {
  try {
    const data = await customerGrowth.getCustomerSegments({
      ...ctxFromReq(req),
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.getChurnSummary = async (req, res) => {
  try {
    const data = await customerGrowth.getChurnSummary({
      ...ctxFromReq(req),
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

exports.getRepurchaseOpportunities = async (req, res) => {
  try {
    const data = await customerGrowth.getRepurchaseOpportunities({
      ...ctxFromReq(req),
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendError(req, res, err);
  }
};

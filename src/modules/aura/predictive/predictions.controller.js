const forecasting = require("./forecasting.service");

function sendPredictionError(req, res, err) {
  const known = {
    AURA_FORECAST_INVALID_HORIZON: [400, "horizon debe ser 7, 14 o 30"],
    AURA_FORECAST_INVALID_INPUT: [400, err.message],
    AURA_FORECAST_TENANT_REQUIRED: [500, "Tenant AURA no resuelto"],
  };
  const [status, message] = known[err.code] || [500, "Error procesando predicciones AURA"];
  return res.status(status).json({
    success: false,
    message,
    code: err.code || "AURA_PREDICTION_ERROR",
    requestId: req.id,
  });
}

exports.getDemand = async (req, res) => {
  try {
    const data = await forecasting.getDemandForecasts({
      ownerAdminId: req.auraAdminId,
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendPredictionError(req, res, err);
  }
};

exports.getRestock = async (req, res) => {
  try {
    const data = await forecasting.getRestockRecommendations({
      ownerAdminId: req.auraAdminId,
      query: req.query || {},
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    return sendPredictionError(req, res, err);
  }
};

exports.recalculate = async (req, res) => {
  try {
    const job = await forecasting.enqueueForecastRecalculation({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
      payload: req.body || {},
    });
    return res.status(job.created ? 202 : 200).json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        dedupeKey: job.dedupe_key,
        baseDedupeKey: job.baseDedupeKey || null,
        deduped: Boolean(job.deduped),
        created: Boolean(job.created),
        cached: Boolean(job.cached),
        forced: Boolean(job.forced),
        reusedActive: Boolean(job.reusedActive),
        createdAt: job.created_at,
      },
      requestId: req.id,
    });
  } catch (err) {
    return sendPredictionError(req, res, err);
  }
};

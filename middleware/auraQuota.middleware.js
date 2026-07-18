const {
  getAuraQuotaLimit,
  reserveAuraRequest,
} = require("../services/auraUsage.service");

function sendQuotaError(req, res, status, message, code, usage = null) {
  return res.status(status).json({
    success: false,
    message,
    code,
    usage: usage ? {
      requestsRemaining: usage.requestsRemaining,
      limit: usage.limit,
      requests: usage.requests,
    } : undefined,
    requestId: req.id,
  });
}

async function auraQuota(req, res, next) {
  try {
    const ownerAdminId = req.auraAdminId || req.adminId;
    if (!ownerAdminId) {
      return sendQuotaError(
        req,
        res,
        401,
        "No autenticado",
        "NOT_AUTHENTICATED"
      );
    }

    const { limit } = await getAuraQuotaLimit(ownerAdminId);
    const usage = await reserveAuraRequest(ownerAdminId, limit);
    req.auraUsage = usage;
    req.auraQuotaLimit = limit;

    if (!usage.allowed) {
      return sendQuotaError(
        req,
        res,
        429,
        "Limite diario de consultas AURA alcanzado.",
        "AURA_DAILY_QUOTA_EXCEEDED",
        usage
      );
    }

    return next();
  } catch (err) {
    const status = err.status || 503;
    return sendQuotaError(
      req,
      res,
      status,
      status === 503 ? "No fue posible verificar la cuota de AURA." : err.message,
      err.code || "AURA_QUOTA_UNAVAILABLE"
    );
  }
}

module.exports = {
  auraQuota,
};

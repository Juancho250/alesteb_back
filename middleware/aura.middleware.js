const db = require("../config/db");

function logSecurityEvent(level, event, req, extra = {}) {
  const payload = {
    level,
    event,
    requestId: req.id || null,
    userId: req.user?.id || null,
    ownerAdminId: req.auraAdminId || req.adminId || null,
    ...extra,
  };
  const writer = level === "error" ? console.error : console.warn;
  writer(JSON.stringify(payload));
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveAuraTenant(req, res, next) {
  try {
    if (!req.user || !req.adminId) {
      return res.status(401).json({
        success: false,
        message: "No autenticado",
        code: "NOT_AUTHENTICATED",
        requestId: req.id,
      });
    }

    if (!req.isSuperAdmin) {
      req.auraAdminId = req.adminId;
      return next();
    }

    const rawTenantId = req.headers["x-tenant-admin-id"];
    const tenantAdminId = parsePositiveInteger(rawTenantId);

    if (!tenantAdminId) {
      return res.status(400).json({
        success: false,
        message: "X-Tenant-Admin-Id es requerido para consultas AURA de superadmin",
        code: "AURA_TENANT_REQUIRED",
        requestId: req.id,
      });
    }

    const { rows } = await db.query(
      `SELECT u.id
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       WHERE u.id = $1
         AND u.is_active = true
         AND u.owner_admin_id IS NULL
         AND r.name = 'admin'
       LIMIT 1`,
      [tenantAdminId]
    );

    if (!rows.length) {
      logSecurityEvent("warn", "aura_tenant_rejected", req, { requestedTenantId: tenantAdminId });
      return res.status(404).json({
        success: false,
        message: "Tenant no encontrado o no disponible para AURA",
        code: "AURA_TENANT_NOT_FOUND",
        requestId: req.id,
      });
    }

    req.auraAdminId = tenantAdminId;
    return next();
  } catch (err) {
    logSecurityEvent("error", "aura_tenant_resolution_failed", req, { errorCode: err.code || "DB_ERROR" });
    return res.status(500).json({
      success: false,
      message: "Error al validar el tenant de AURA",
      code: "AURA_TENANT_VALIDATION_ERROR",
      requestId: req.id,
    });
  }
}

module.exports = {
  resolveAuraTenant,
  parsePositiveInteger,
};

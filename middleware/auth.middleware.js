// middleware/auth.middleware.js
const jwt    = require("jsonwebtoken");
const crypto = require("crypto");
const db     = require("../config/db");

// ============================================
// 🛡️ AUTENTICACIÓN JWT (panel web)
// ============================================
const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: "Token de autenticación requerido",
        code: "NO_TOKEN",
      });
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({
        success: false,
        message: "Formato inválido. Use: Bearer <token>",
        code: "INVALID_FORMAT",
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(parts[1], process.env.JWT_SECRET, {
        issuer:   "alesteb-api",
        audience: "alesteb-client",
      });
    } catch (err) {
      const code = err.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "INVALID_TOKEN";
      const msg  = err.name === "TokenExpiredError"
        ? "Token expirado. Solicita un nuevo token"
        : "Token inválido";
      return res.status(401).json({ success: false, message: msg, code });
    }

    const userCheck = await db.query(
      "SELECT is_active FROM users WHERE id = $1",
      [decoded.id]
    );

    if (userCheck.rowCount === 0) {
      return res.status(401).json({ success: false, message: "Usuario no encontrado", code: "USER_NOT_FOUND" });
    }
    if (!userCheck.rows[0].is_active) {
      return res.status(403).json({ success: false, message: "Usuario desactivado", code: "USER_INACTIVE" });
    }

    req.user = {
      id:    decoded.id,
      email: decoded.email,
      name:  decoded.name,
      roles: decoded.roles || [],
    };

    next();
  } catch (error) {
    console.error("[AUTH MIDDLEWARE ERROR]", error);
    return res.status(500).json({ success: false, message: "Error en autenticación", code: "AUTH_ERROR" });
  }
};

// ============================================
// 🔑 AUTENTICACIÓN VÍA API KEY (acceso externo)
// Header: X-API-Key: ak_<prefix>_<secret>
// ============================================
const apiKeyAuth = async (req, res, next) => {
  try {
    const rawKey = req.headers["x-api-key"];

    if (!rawKey) {
      return res.status(401).json({
        success: false,
        message: "API Key requerida. Usa el header X-API-Key",
        code: "NO_API_KEY",
      });
    }

    // Validar formato: ak_<prefix>_<secret>
    if (!rawKey.startsWith("ak_")) {
      return res.status(401).json({
        success: false,
        message: "Formato de API Key inválido",
        code: "INVALID_API_KEY_FORMAT",
      });
    }

    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    const keyRes = await db.query(
      `SELECT
         ak.id, ak.admin_id, ak.name, ak.permissions, ak.allowed_origins,
         ak.is_active, ak.expires_at,
         u.id AS user_id, u.email, u.name AS admin_name, u.is_active AS admin_active
       FROM api_keys ak
       JOIN users u ON u.id = ak.admin_id
       WHERE ak.key_hash = $1`,
      [keyHash]
    );

    if (keyRes.rowCount === 0) {
      return res.status(401).json({ success: false, message: "API Key inválida", code: "INVALID_API_KEY" });
    }

    const key = keyRes.rows[0];

    if (!key.is_active) {
      return res.status(403).json({ success: false, message: "API Key desactivada", code: "API_KEY_INACTIVE" });
    }

    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: "API Key expirada", code: "API_KEY_EXPIRED" });
    }

    if (!key.admin_active) {
      return res.status(403).json({ success: false, message: "Cuenta admin desactivada", code: "ADMIN_INACTIVE" });
    }

    // Validar origen si hay lista blanca configurada
    const origin  = req.headers.origin || req.headers.referer || "";
    const origins = key.allowed_origins || [];

    if (origins.length > 0) {
      const allowed = origins.some((o) => origin.startsWith(o));
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: "Origen no autorizado para esta API Key",
          code: "ORIGIN_NOT_ALLOWED",
        });
      }
    }

    // Actualizar contador y last_used_at (sin await para no bloquear)
    db.query(
      `UPDATE api_keys SET last_used_at = NOW(), request_count = request_count + 1 WHERE id = $1`,
      [key.id]
    ).catch((e) => console.error("[API KEY UPDATE ERROR]", e));

    // Log de uso (sin await)
    db.query(
      `INSERT INTO api_key_logs (api_key_id, endpoint, method, ip_address, origin)
       VALUES ($1, $2, $3, $4, $5)`,
      [key.id, req.path, req.method, req.ip, origin || null]
    ).catch((e) => console.error("[API KEY LOG ERROR]", e));

    // Adjuntar contexto al request
    req.apiKey = {
      id:          key.id,
      name:        key.name,
      adminId:     key.admin_id,
      permissions: key.permissions || [],
    };

    next();
  } catch (error) {
    console.error("[API KEY AUTH ERROR]", error);
    return res.status(500).json({ success: false, message: "Error validando API Key", code: "AUTH_ERROR" });
  }
};

// ============================================
// 🔐 VERIFICACIÓN DE ROLES
// ============================================
const requireRole = (allowedRoles = []) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "No autenticado", code: "NOT_AUTHENTICATED" });
  }

  // Superadmin tiene acceso total
  if (req.user.roles.includes("superadmin")) return next();

  const hasRole = req.user.roles.some((r) => allowedRoles.includes(r));
  if (!hasRole) {
    return res.status(403).json({
      success: false,
      message: "No tienes permisos para esta acción",
      code: "INSUFFICIENT_ROLE",
      required: allowedRoles,
      current:  req.user.roles,
    });
  }

  next();
};

// ============================================
// 🔑 VERIFICACIÓN DE PERMISOS EN API KEY
// Uso: requireApiPermission("products:read")
// ============================================
const requireApiPermission = (permission) => (req, res, next) => {
  if (!req.apiKey) {
    return res.status(401).json({ success: false, message: "API Key requerida", code: "NO_API_KEY" });
  }

  const perms = req.apiKey.permissions || [];

  // Permiso exacto o wildcard "all"
  if (perms.includes("all") || perms.includes(permission)) {
    return next();
  }

  // Permiso de categoría: "products:read" satisface "products:read" en perms
  const [resource] = permission.split(":");
  if (perms.includes(`${resource}:read`) && permission.endsWith(":read")) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: `Permiso insuficiente. Se requiere: ${permission}`,
    code:    "INSUFFICIENT_PERMISSION",
  });
};

// ============================================
// ⏱️ RATE LIMITING
// ============================================
const _rateLimitStore = {};

const checkRateLimit = (identifier, maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  return (req, res, next) => {
    const key = identifier === "ip" ? req.ip : (req.body?.email || req.ip);

    if (!key) return next();

    const now    = Date.now();
    const record = _rateLimitStore[key];

    if (!record || now > record.resetAt) {
      _rateLimitStore[key] = { count: 1, resetAt: now + windowMs };
      return next();
    }

    if (record.count >= maxAttempts) {
      const minutesLeft = Math.ceil((record.resetAt - now) / 60000);
      return res.status(429).json({
        success: false,
        message: `Demasiados intentos. Intenta en ${minutesLeft} minuto${minutesLeft !== 1 ? "s" : ""}`,
        code:    "RATE_LIMIT_EXCEEDED",
        retryAfter: minutesLeft,
      });
    }

    record.count++;
    next();
  };
};

setInterval(() => {
  const now = Date.now();
  Object.keys(_rateLimitStore).forEach((k) => {
    if (now > _rateLimitStore[k].resetAt) delete _rateLimitStore[k];
  });
}, 60 * 60 * 1000);

// ============================================
// 🎯 ATAJOS
// ============================================
const requireAdmin      = requireRole(["admin"]);
const requireManager    = requireRole(["admin", "gerente"]);
const requireSuperAdmin = requireRole(["superadmin"]);

module.exports = {
  auth,
  apiKeyAuth,
  requireRole,
  requireAdmin,
  requireManager,
  requireSuperAdmin,
  requireApiPermission,
  checkRateLimit,
};
const jwt = require("jsonwebtoken");
const db = require("../config/db");

// ============================================
// 🛡️ MIDDLEWARE DE AUTENTICACIÓN PRINCIPAL
// ============================================

const auth = async (req, res, next) => {
  try {
    // 1️⃣ Extraer token del header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ 
        success: false,
        message: "Token de autenticación requerido",
        code: "NO_TOKEN"
      });
    }

    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ 
        success: false,
        message: "Formato de token inválido. Use: Bearer <token>",
        code: "INVALID_FORMAT"
      });
    }

    const token = parts[1];

    // 2️⃣ Verificar y decodificar el token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'alesteb-api',
        audience: 'alesteb-client'
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          success: false,
          message: "Token expirado. Solicita un nuevo token",
          code: "TOKEN_EXPIRED"
        });
      }
      
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          success: false,
          message: "Token inválido",
          code: "INVALID_TOKEN"
        });
      }

      throw error;
    }

    // 3️⃣ Verificar que el usuario siga activo (validación adicional)
    const userCheck = await db.query(
      "SELECT is_active FROM users WHERE id = $1",
      [decoded.id]
    );

    if (userCheck.rowCount === 0) {
      return res.status(401).json({ 
        success: false,
        message: "Usuario no encontrado",
        code: "USER_NOT_FOUND"
      });
    }

    if (!userCheck.rows[0].is_active) {
      return res.status(403).json({ 
        success: false,
        message: "Usuario desactivado",
        code: "USER_INACTIVE"
      });
    }

    // 4️⃣ Adjuntar información del usuario al request
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      roles: decoded.roles || [],
      permissions: decoded.permissions || []
    };

    next();

  } catch (error) {
    console.error("[AUTH MIDDLEWARE ERROR]", error);
    return res.status(500).json({ 
      success: false,
      message: "Error en la autenticación",
      code: "AUTH_ERROR"
    });
  }
};

// ============================================
// 🔐 MIDDLEWARE DE VERIFICACIÓN DE ROLES
// ============================================

const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    // Verificar que el usuario esté autenticado
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: "No autenticado",
        code: "NOT_AUTHENTICATED"
      });
    }

    if (!Array.isArray(req.user.roles)) {
      return res.status(403).json({ 
        success: false,
        message: "Datos de roles inválidos",
        code: "INVALID_ROLES"
      });
    }

    // Super admin tiene acceso a todo
    if (req.user.roles.includes('super_admin')) {
      return next();
    }

    // Verificar si tiene alguno de los roles permitidos
    const hasRole = req.user.roles.some(role =>
      allowedRoles.includes(role)
    );

    if (!hasRole) {
      return res.status(403).json({ 
        success: false,
        message: `Acceso denegado. Roles requeridos: ${allowedRoles.join(', ')}`,
        code: "INSUFFICIENT_ROLE",
        required: allowedRoles,
        current: req.user.roles
      });
    }

    next();
  };
};

// ============================================
// 🔑 MIDDLEWARE DE VERIFICACIÓN DE PERMISOS
// ============================================

const requirePermission = (requiredPermission) => {
  return (req, res, next) => {
    // Verificar que el usuario esté autenticado
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: "No autenticado",
        code: "NOT_AUTHENTICATED"
      });
    }

    const userPermissions = req.user.permissions || [];
    const userRoles = req.user.roles || [];

    // Super admin tiene acceso a todo
    if (userRoles.includes('super_admin')) {
      return next();
    }

    // Verificar si tiene el permiso específico
    if (!userPermissions.includes(requiredPermission)) {
      return res.status(403).json({ 
        success: false,
        message: "No tienes permisos para realizar esta acción",
        code: "INSUFFICIENT_PERMISSION",
        required: requiredPermission,
        current: userPermissions
      });
    }

    next();
  };
};

// ============================================
// 🔓 MIDDLEWARE DE AUTENTICACIÓN OPCIONAL
// ============================================
// Para rutas que pueden funcionar con o sin autenticación

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      req.user = null;
      return next();
    }

    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      req.user = null;
      return next();
    }

    const token = parts[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'alesteb-api',
        audience: 'alesteb-client'
      });

      req.user = {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name,
        roles: decoded.roles || [],
        permissions: decoded.permissions || []
      };
    } catch (error) {
      req.user = null;
    }

    next();

  } catch (error) {
    console.error("[OPTIONAL AUTH ERROR]", error);
    req.user = null;
    next();
  }
};

// ============================================
// ⏱️ RATE LIMITING (Prevención de fuerza bruta)
// ============================================

const loginRateLimiter = {};

const checkRateLimit = (identifier, maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  return (req, res, next) => {
    const key = identifier === 'ip' ? req.ip : req.body.email;

    if (!key) return next();

    const now = Date.now();
    
    if (!loginRateLimiter[key]) {
      loginRateLimiter[key] = { count: 1, resetAt: now + windowMs };
      return next();
    }

    const record = loginRateLimiter[key];

    if (now > record.resetAt) {
      record.count = 1;
      record.resetAt = now + windowMs;
      return next();
    }

    if (record.count >= maxAttempts) {
      const minutesLeft = Math.ceil((record.resetAt - now) / 60000);
      return res.status(429).json({
        success: false,
        message: `Demasiados intentos. Intenta en ${minutesLeft} minutos`,
        code: "RATE_LIMIT_EXCEEDED",
        retryAfter: minutesLeft
      });
    }

    record.count++;
    next();
  };
};

// Limpieza periódica del rate limiter (cada hora)
setInterval(() => {
  const now = Date.now();
  Object.keys(loginRateLimiter).forEach(key => {
    if (now > loginRateLimiter[key].resetAt) {
      delete loginRateLimiter[key];
    }
  });
}, 60 * 60 * 1000);

module.exports = { 
  auth, 
  requirePermission, 
  requireRole,
  optionalAuth,
  checkRateLimit
};
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const db = require("../config/db");

// ===============================
// LOGGING DE EVENTOS DE SEGURIDAD
// ===============================

const logSecurityEvent = async (eventData) => {
  try {
    await db.query(
      `INSERT INTO security_logs (event_type, user_id, ip_address, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        eventData.type,
        eventData.userId || null,
        eventData.ip || null,
        JSON.stringify(eventData),
      ]
    );
  } catch (err) {
    // Nunca romper el request por un fallo de log
    console.error("Security logging error:", err.message);
  }
};

// ===============================
// AUTENTICACIÓN MEJORADA
// ===============================

const auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ 
        success: false,
        message: "Token no enviado o formato inválido" 
      });
    }

    const token = authHeader.split(" ")[1];
    
    if (!token) {
      return res.status(401).json({ 
        success: false,
        message: "Token no proporcionado" 
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      issuer: 'alesteb-system',
      audience: 'alesteb-client'
    });

    // Validar estructura del token
    if (!decoded.id || !decoded.role) {
      return res.status(401).json({ 
        success: false,
        message: "Token inválido: estructura incorrecta" 
      });
    }

    // Adjuntar usuario al request
    req.user = {
      id: decoded.id,
      role: decoded.role,
      role_id: decoded.role_id,
      email: decoded.email
    };

    // Adjuntar token al request para posible blacklisting
    req.token = token;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ 
        success: false,
        message: "Token expirado. Por favor, inicia sesión nuevamente.",
        code: "TOKEN_EXPIRED"
      });
    }
    
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ 
        success: false,
        message: "Token inválido",
        code: "TOKEN_INVALID"
      });
    }

    return res.status(401).json({ 
      success: false,
      message: "Error de autenticación",
      code: "AUTH_ERROR"
    });
  }
};

// ===============================
// VERIFICACIÓN DE ROLES
// ===============================

const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ 
        success: false,
        message: "No autorizado" 
      });
    }

    const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

    if (!rolesArray.includes(req.user.role)) {
      logSecurityEvent({
        type: "unauthorized_role_access",
        userId: req.user.id,
        role: req.user.role,
        requiredRoles: rolesArray,
        path: req.path,
        ip: req.ip,
      });
      
      return res.status(403).json({ 
        success: false,
        message: "No tienes permisos para esta sección",
        code: "INSUFFICIENT_PERMISSIONS"
      });
    }

    next();
  };
};

const isAdmin = requireRole(["admin", "super_admin"]);

// ===============================
// VERIFICACIÓN DE OWNERSHIP
// ===============================

const checkOwnership = (resourceType) => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params.id;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Admin siempre pasa
      if (userRole === "admin" || userRole === "super_admin") {
        return next();
      }

      let ownerField;
      let query;

      switch (resourceType) {
        case "sale":
          query = "SELECT customer_id AS owner_id FROM sales WHERE id = $1";
          ownerField = "owner_id";
          break;
          
        case "user":
          // Solo puede ver/editar su propio perfil
          if (parseInt(resourceId, 10) !== userId) {
            logSecurityEvent({
              type: "ownership_violation",
              userId,
              resourceType,
              resourceId,
              ip: req.ip,
            });
            return res.status(403).json({ 
              success: false,
              message: "No autorizado para acceder a este recurso" 
            });
          }
          return next();
          
        default:
          return res.status(400).json({ 
            success: false,
            message: "Tipo de recurso inválido" 
          });
      }

      const result = await db.query(query, [resourceId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ 
          success: false,
          message: "Recurso no encontrado" 
        });
      }

      if (result.rows[0][ownerField] !== userId) {
        logSecurityEvent({
          type: "ownership_violation",
          userId,
          resourceType,
          resourceId,
          ip: req.ip,
        });
        
        return res.status(403).json({ 
          success: false,
          message: "No autorizado para acceder a este recurso" 
        });
      }

      next();
    } catch (error) {
      console.error("Ownership check error:", error);
      res.status(500).json({ 
        success: false,
        message: "Error verificando permisos" 
      });
    }
  };
};

// ===============================
// RATE LIMITING
// ===============================

const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    handler: (req, res) => {
      logSecurityEvent({
        type: "rate_limit_exceeded",
        userId: req.user?.id,
        ip: req.ip,
        path: req.path,
      });
      
      res.status(429).json({ 
        success: false,
        message,
        retryAfter: Math.ceil(windowMs / 1000),
        code: "RATE_LIMIT_EXCEEDED"
      });
    },
  });
};

const loginLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutos
  5, // 5 intentos
  "Demasiados intentos de login. Intenta en 15 minutos"
);

const registerLimiter = createRateLimiter(
  60 * 60 * 1000, // 1 hora
  3, // 3 registros
  "Demasiados registros. Intenta en 1 hora"
);

const apiLimiter = createRateLimiter(
  15 * 60 * 1000, // 15 minutos
  100, // 100 requests
  "Demasiadas peticiones. Intenta en 15 minutos"
);

const strictApiLimiter = createRateLimiter(
  60 * 1000, // 1 minuto
  10, // 10 requests
  "Límite de peticiones excedido. Intenta en 1 minuto"
);

// ===============================
// AUDITORÍA DE ACCIONES
// ===============================

const auditLog = (req, res, next) => {
  const startTime = Date.now();

  res.on("finish", async () => {
    const auditablePaths = ["/api/sales", "/api/users", "/api/products", "/api/expenses"];
    const shouldAudit = auditablePaths.some((p) => req.path.startsWith(p));
    
    if (!shouldAudit) return;

    try {
      await db.query(
        `INSERT INTO audit_logs
         (user_id, action, resource, resource_id, ip_address, user_agent, response_time, status_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          req.user?.id || null,
          req.method,
          req.path,
          req.params.id || null,
          req.ip,
          req.get("user-agent"),
          Date.now() - startTime,
          res.statusCode,
        ]
      );
    } catch (err) {
      console.error("Audit logging error:", err.message);
    }
  });

  next();
};

// ===============================
// SANITIZACIÓN DE PARÁMETROS
// ===============================

const sanitizeParams = (req, res, next) => {
  const sanitize = (obj) => {
    if (!obj) return;
    Object.keys(obj).forEach((key) => {
      if (typeof obj[key] === "string") {
        // Remover caracteres peligrosos manteniendo caracteres especiales válidos
        obj[key] = obj[key]
          .replace(/[<>"']/g, "")
          .trim();
      }
    });
  };
  
  sanitize(req.query);
  sanitize(req.params);
  next();
};

// ===============================
// PREVENCIÓN DE MASS ASSIGNMENT
// ===============================

const allowFields = (allowedFields) => {
  return (req, res, next) => {
    if (!req.body) return next();
    
    const sanitized = {};
    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        sanitized[field] = req.body[field];
      }
    });
    
    req.body = sanitized;
    next();
  };
};

// ===============================
// VERIFICACIÓN DE SESIÓN ACTIVA
// ===============================

const checkActiveSession = async (req, res, next) => {
  try {
    if (!req.user?.id) return next();

    const result = await db.query(
      "SELECT is_verified, id FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ 
        success: false,
        message: "Usuario no encontrado",
        code: "USER_NOT_FOUND"
      });
    }
    
    if (!result.rows[0].is_verified) {
      return res.status(403).json({ 
        success: false,
        message: "Usuario no verificado",
        code: "USER_NOT_VERIFIED"
      });
    }

    next();
  } catch (error) {
    console.error("Session check error:", error);
    next(error);
  }
};

// ===============================
// MANEJO DE ERRORES SEGURO
// ===============================

const secureErrorHandler = (err, req, res, _next) => {
  // Log del error completo
  console.error("Error:", {
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    userId: req.user?.id,
    path: req.path,
    method: req.method
  });

  // Determinar código de estado
  const statusCode = err.statusCode || err.status || 500;
  
  // Mensajes seguros para producción
  let message = err.message;
  if (process.env.NODE_ENV === "production" && statusCode === 500) {
    message = "Error procesando la solicitud";
  }

  // Respuesta estructurada
  const response = {
    success: false,
    message,
    code: err.code || 'INTERNAL_ERROR'
  };

  // Stack trace solo en desarrollo
  if (process.env.NODE_ENV === "development") {
    response.stack = err.stack;
    response.details = err.details;
  }

  res.status(statusCode).json(response);
};

// ===============================
// EXPORTS
// ===============================

module.exports = {
  auth,
  requireRole,
  isAdmin,
  checkOwnership,
  loginLimiter,
  registerLimiter,
  apiLimiter,
  strictApiLimiter,
  auditLog,
  sanitizeParams,
  allowFields,
  checkActiveSession,
  secureErrorHandler,
  logSecurityEvent,
};
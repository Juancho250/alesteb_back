const jwt = require("jsonwebtoken");
const rateLimit = require('express-rate-limit');
const db = require("../config/db");

// ===============================
// AUTENTICACIÓN MEJORADA
// ===============================

const auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: "Token no enviado" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Formato de token inválido" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Validar que el token no esté en lista negra (opcional)
    // await checkTokenBlacklist(token);

    req.user = decoded; // { id, role }
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({ message: "Token expirado" });
    }
    return res.status(403).json({ message: "Token inválido" });
  }
};

// ===============================
// VERIFICACIÓN DE ROLES
// ===============================

const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ message: "No autorizado" });
    }

    const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    
    if (!rolesArray.includes(req.user.role)) {
      // Log intento de acceso no autorizado
      logSecurityEvent({
        type: 'unauthorized_access',
        userId: req.user.id,
        role: req.user.role,
        requiredRoles: rolesArray,
        path: req.path,
        ip: req.ip
      });
      
      return res.status(403).json({ message: "No tienes permisos para esta sección" });
    }
    
    next();
  };
};

const isAdmin = requireRole(['admin', 'super_admin']);

// ===============================
// VERIFICACIÓN DE OWNERSHIP
// ===============================

const checkOwnership = (resourceType) => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params.id;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Admin puede acceder a todo
      if (userRole === 'admin' || userRole === 'super_admin') {
        return next();
      }

      let query;
      let params;

      switch (resourceType) {
        case 'sale':
          query = 'SELECT customer_id FROM sales WHERE id = $1';
          params = [resourceId];
          break;
        case 'user':
          // Solo puede modificar su propio perfil
          if (parseInt(resourceId) !== userId) {
            return res.status(403).json({ message: "No autorizado" });
          }
          return next();
        default:
          return res.status(400).json({ message: "Tipo de recurso inválido" });
      }

      const result = await db.query(query, params);

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Recurso no encontrado" });
      }

      if (result.rows[0].customer_id !== userId) {
        logSecurityEvent({
          type: 'ownership_violation',
          userId,
          resourceType,
          resourceId,
          ip: req.ip
        });
        return res.status(403).json({ message: "No autorizado" });
      }

      next();
    } catch (error) {
      console.error('Ownership check error:', error);
      res.status(500).json({ message: "Error verificando permisos" });
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
    message: { message },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logSecurityEvent({
        type: 'rate_limit_exceeded',
        userId: req.user?.id,
        ip: req.ip,
        path: req.path
      });
      res.status(429).json({ message });
    }
  });
};

// Rate limiters específicos
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
// LOGGING DE EVENTOS DE SEGURIDAD
// ===============================

const logSecurityEvent = async (eventData) => {
  try {
    await db.query(`
      INSERT INTO security_logs (
        event_type, 
        user_id, 
        ip_address, 
        details, 
        created_at
      ) VALUES ($1, $2, $3, $4, NOW())
    `, [
      eventData.type,
      eventData.userId || null,
      eventData.ip,
      JSON.stringify(eventData)
    ]);
  } catch (error) {
    console.error('Security logging error:', error);
    // No fallar la request si el logging falla
  }
};

// ===============================
// AUDITORÍA DE ACCIONES
// ===============================

const auditLog = async (req, res, next) => {
  const startTime = Date.now();

  // Capturar la respuesta original
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    res.locals.responseData = data;
    return originalJson(data);
  };

  res.on('finish', async () => {
    // Solo auditar rutas importantes
    const auditablePaths = ['/api/sales', '/api/users', '/api/products', '/api/expenses'];
    const shouldAudit = auditablePaths.some(path => req.path.startsWith(path));

    if (!shouldAudit) return;

    try {
      await db.query(`
        INSERT INTO audit_logs (
          user_id, 
          action, 
          resource, 
          resource_id,
          ip_address, 
          user_agent, 
          response_time, 
          status_code,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      `, [
        req.user?.id || null,
        req.method,
        req.path,
        req.params.id || null,
        req.ip,
        req.get('user-agent'),
        Date.now() - startTime,
        res.statusCode
      ]);
    } catch (error) {
      console.error('Audit logging error:', error);
    }
  });

  next();
};

// ===============================
// SANITIZACIÓN DE PARÁMETROS
// ===============================

const sanitizeParams = (req, res, next) => {
  // Sanitizar query params
  if (req.query) {
    Object.keys(req.query).forEach(key => {
      if (typeof req.query[key] === 'string') {
        // Remover caracteres peligrosos
        req.query[key] = req.query[key]
          .replace(/[<>]/g, '')
          .trim();
      }
    });
  }

  // Sanitizar params de ruta
  if (req.params) {
    Object.keys(req.params).forEach(key => {
      if (typeof req.params[key] === 'string') {
        req.params[key] = req.params[key]
          .replace(/[<>]/g, '')
          .trim();
      }
    });
  }

  next();
};

// ===============================
// PREVENCIÓN DE MASS ASSIGNMENT
// ===============================

const allowFields = (allowedFields) => {
  return (req, res, next) => {
    if (!req.body) return next();

    const sanitized = {};
    allowedFields.forEach(field => {
      if (req.body.hasOwnProperty(field)) {
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

    // Verificar que el usuario sigue activo
    const result = await db.query(
      'SELECT is_verified, id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Usuario no encontrado" });
    }

    if (!result.rows[0].is_verified) {
      return res.status(403).json({ message: "Usuario no verificado" });
    }

    next();
  } catch (error) {
    console.error('Session check error:', error);
    next(error);
  }
};

// ===============================
// MANEJO DE ERRORES SEGURO
// ===============================

const secureErrorHandler = (err, req, res, next) => {
  // Log del error completo para debugging
  console.error('Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    user: req.user?.id,
    path: req.path
  });

  // Respuesta genérica para el cliente
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'Error procesando la solicitud'
    : err.message;

  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

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
  logSecurityEvent
};
const winston = require('winston');
const path = require('path');

/**
 * Configuración de Winston Logger con rotación de archivos
 * y diferentes niveles de logging
 */

// Formato personalizado para desarrollo
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    
    // Agregar stack trace si existe
    if (stack) {
      msg += `\n${stack}`;
    }
    
    // Agregar metadata si existe
    if (Object.keys(metadata).length > 0) {
      msg += `\n${JSON.stringify(metadata, null, 2)}`;
    }
    
    return msg;
  })
);

// Formato para producción (JSON)
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Determinar el nivel de logging según el entorno
const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Crear el logger
const logger = winston.createLogger({
  level,
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
  defaultMeta: { 
    service: process.env.SERVICE_NAME || 'alesteb-api',
    environment: process.env.NODE_ENV || 'development'
  },
  transports: [
    // Logs de error a archivo separado
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 10,
      tailable: true
    }),
    
    // Logs de warning a archivo separado
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'warn.log'),
      level: 'warn',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    
    // Todos los logs a combined.log
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 10,
      tailable: true
    })
  ],
  
  // Prevenir que el proceso se detenga por errores de logging
  exitOnError: false
});

// En desarrollo, también log a consola
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: devFormat
  }));
}

// Helpers para logs estructurados
logger.logRequest = (req, additionalData = {}) => {
  logger.info('HTTP Request', {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userId: req.user?.id,
    ...additionalData
  });
};

logger.logResponse = (req, res, responseTime, additionalData = {}) => {
  const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
  
  logger.log(level, 'HTTP Response', {
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    responseTime: `${responseTime}ms`,
    userId: req.user?.id,
    ...additionalData
  });
};

logger.logSecurity = (event, data = {}) => {
  logger.warn('Security Event', {
    event,
    ...data
  });
};

logger.logDatabase = (query, duration, error = null) => {
  if (error) {
    logger.error('Database Error', {
      query: query.substring(0, 100) + '...', // Truncar query larga
      duration: `${duration}ms`,
      error: error.message
    });
  } else if (duration > 1000) { // Log queries lentas
    logger.warn('Slow Database Query', {
      query: query.substring(0, 100) + '...',
      duration: `${duration}ms`
    });
  } else if (process.env.LOG_DB_QUERIES === 'true') {
    logger.debug('Database Query', {
      query: query.substring(0, 100) + '...',
      duration: `${duration}ms`
    });
  }
};

logger.logExternal = (service, action, success, data = {}) => {
  const level = success ? 'info' : 'error';
  logger.log(level, 'External Service Call', {
    service,
    action,
    success,
    ...data
  });
};

// Stream para Morgan (logging de HTTP)
logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

module.exports = logger;
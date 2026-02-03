const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  // Log del error
  logger.error({
    message: err.message,
    stack: err.stack,
    userId: req.user?.id,
    path: req.path,
    method: req.method
  });

  // Determinar status code
  const statusCode = err.statusCode || 500;
  
  // Mensaje según entorno
  const message = process.env.NODE_ENV === 'production' 
    ? 'Error interno del servidor'
    : err.message;

  res.status(statusCode).json({
    status: 'error',
    code: err.code || 'INTERNAL_ERROR',
    message,
    ...(process.env.NODE_ENV === 'development' && { 
      stack: err.stack 
    })
  });
};

module.exports = errorHandler;
/**
 * Clases de error personalizadas para manejo consistente
 * de errores en toda la aplicación
 */

class AppError extends Error {
  constructor(message, statusCode, code = null, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      status: 'error',
      code: this.code,
      message: this.message,
      ...(this.details && { details: this.details })
    };
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Recurso') {
    super(`${resource} no encontrado`, 404, 'NOT_FOUND');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'No autorizado') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Acceso denegado') {
    super(message, 403, 'FORBIDDEN');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflicto con el estado actual') {
    super(message, 409, 'CONFLICT');
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Demasiadas peticiones', retryAfter = null) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
    this.retryAfter = retryAfter;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.retryAfter && { retryAfter: this.retryAfter })
    };
  }
}

class DatabaseError extends AppError {
  constructor(message = 'Error de base de datos', originalError = null) {
    super(message, 500, 'DATABASE_ERROR');
    this.originalError = originalError;
  }
}

class ExternalServiceError extends AppError {
  constructor(service, message = 'Error en servicio externo') {
    super(`${service}: ${message}`, 503, 'EXTERNAL_SERVICE_ERROR');
    this.service = service;
  }
}

/**
 * Maneja errores específicos de PostgreSQL
 */
class PostgresError extends AppError {
  constructor(error) {
    let message = 'Error de base de datos';
    let code = 'DATABASE_ERROR';
    let statusCode = 500;

    switch (error.code) {
      case '23505': // unique_violation
        message = 'El registro ya existe';
        code = 'DUPLICATE_ENTRY';
        statusCode = 409;
        break;
      case '23503': // foreign_key_violation
        message = 'Referencia inválida';
        code = 'INVALID_REFERENCE';
        statusCode = 400;
        break;
      case '23502': // not_null_violation
        message = 'Campo requerido faltante';
        code = 'MISSING_REQUIRED_FIELD';
        statusCode = 400;
        break;
      case '22P02': // invalid_text_representation
        message = 'Formato de dato inválido';
        code = 'INVALID_FORMAT';
        statusCode = 400;
        break;
      case '42P01': // undefined_table
        message = 'Tabla no encontrada';
        code = 'TABLE_NOT_FOUND';
        statusCode = 500;
        break;
      default:
        message = process.env.NODE_ENV === 'production' 
          ? 'Error procesando la solicitud' 
          : error.message;
    }

    super(message, statusCode, code);
    this.pgCode = error.code;
    this.constraint = error.constraint;
    this.table = error.table;
    this.column = error.column;
  }
}

/**
 * Helper para validar y lanzar errores comunes
 */
const assert = {
  exists: (value, resource = 'Recurso') => {
    if (!value) {
      throw new NotFoundError(resource);
    }
    return value;
  },

  isTrue: (condition, message = 'Validación fallida') => {
    if (!condition) {
      throw new ValidationError(message);
    }
  },

  isAuthorized: (condition, message = 'No autorizado') => {
    if (!condition) {
      throw new ForbiddenError(message);
    }
  },

  validId: (id, resource = 'ID') => {
    const parsed = parseInt(id);
    if (isNaN(parsed) || parsed <= 0) {
      throw new ValidationError(`${resource} inválido`);
    }
    return parsed;
  }
};

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  DatabaseError,
  ExternalServiceError,
  PostgresError,
  assert
};
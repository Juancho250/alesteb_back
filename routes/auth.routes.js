const express = require("express");
const router = express.Router();
const { login, register, verifyCode } = require("../controllers/auth.controller");
const { loginLimiter, registerLimiter, sanitizeParams } = require("../middleware/auth.middleware");
const { z } = require("zod");

// ===============================
// MIDDLEWARE DE VALIDACIÓN
// ===============================

const validateLogin = (req, res, next) => {
  const loginSchema = z.object({
    email: z.string()
      .email("Email inválido")
      .max(255, "Email demasiado largo")
      .trim()
      .toLowerCase(),
    password: z.string()
      .min(1, "La contraseña es requerida")
      .max(255, "Contraseña demasiado larga")
  });

  try {
    req.body = loginSchema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }
    next(error);
  }
};

const validateRegister = (req, res, next) => {
  const registerSchema = z.object({
    name: z.string()
      .min(2, "El nombre debe tener al menos 2 caracteres")
      .max(100, "El nombre no puede exceder 100 caracteres")
      .regex(/^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/, "El nombre solo puede contener letras")
      .trim(),
    email: z.string()
      .email("Email inválido")
      .max(255, "Email demasiado largo")
      .trim()
      .toLowerCase(),
    password: z.string()
      .min(8, "La contraseña debe tener al menos 8 caracteres")
      .max(255, "Contraseña demasiado larga")
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
        "La contraseña debe contener al menos una mayúscula, una minúscula y un número"
      ),
    phone: z.string()
      .regex(/^\+?[\d\s\-()]+$/, "Número de teléfono inválido")
      .min(7, "Número de teléfono demasiado corto")
      .max(20, "Número de teléfono demasiado largo")
      .optional()
      .or(z.literal(""))
  });

  try {
    req.body = registerSchema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }
    next(error);
  }
};

const validateVerifyCode = (req, res, next) => {
  const verifySchema = z.object({
    email: z.string()
      .email("Email inválido")
      .max(255, "Email demasiado largo")
      .trim()
      .toLowerCase(),
    code: z.string()
      .regex(/^\d{6}$/, "El código debe ser de 6 dígitos")
  });

  try {
    req.body = verifySchema.parse(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }
    next(error);
  }
};

// ===============================
// RUTAS
// ===============================

// Login con rate limiting y validación
router.post("/login", 
  sanitizeParams,
  loginLimiter, 
  validateLogin, 
  login
);

// Register con rate limiting y validación
router.post("/register", 
  sanitizeParams,
  registerLimiter, 
  validateRegister, 
  register
);

// Verify con rate limiting y validación
router.post("/verify", 
  sanitizeParams,
  loginLimiter, // Reutilizamos el limiter de login
  validateVerifyCode, 
  verifyCode
);

module.exports = router;
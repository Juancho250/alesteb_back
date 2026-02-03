const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Resend } = require('resend');
const { logSecurityEvent } = require('../middleware/auth.middleware');
const { 
  ValidationError, 
  UnauthorizedError, 
  ForbiddenError 
} = require('../utils/errors');
const logger = require('../utils/logger');
const crypto = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY);

if (!process.env.RESEND_API_KEY) {
  logger.error("CRÍTICO: Falta RESEND_API_KEY en el .env");
}

// ===============================
// CONSTANTES DE SEGURIDAD
// ===============================

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 30;
const VERIFICATION_CODE_EXPIRY_MINUTES = 15;
const VERIFICATION_CODE_MAX_ATTEMPTS = 10;

// ===============================
// UTILIDADES MEJORADAS
// ===============================

/**
 * Genera un código de verificación de 6 dígitos usando crypto seguro
 */
const generateVerificationCode = () => {
  const randomBytes = crypto.randomBytes(4);
  const number = randomBytes.readUInt32BE(0);
  const code = String(number % 1000000).padStart(6, '0');
  return code;
};

/**
 * Hashea una IP para logs (GDPR compliant)
 */
const hashIP = (ip) => {
  if (!ip) return null;
  const salt = process.env.IP_SALT || 'default-salt-change-me';
  return crypto.createHash('sha256')
    .update(ip + salt)
    .digest('hex')
    .substring(0, 16);
};

/**
 * Genera un timestamp de expiración
 */
const getExpiryTimestamp = (minutes) => {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + minutes);
  return expiry;
};

/**
 * Sanitiza respuesta de usuario (sin info sensible)
 */
const sanitizeUserResponse = (user) => {
  const { 
    password, 
    verification_code, 
    verification_code_expires_at,
    failed_login_attempts,
    locked_until,
    ...safeUser 
  } = user;
  return safeUser;
};

/**
 * Timing-safe string comparison
 */
const timingSafeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(a, 'utf8'),
    Buffer.from(b, 'utf8')
  );
};

// ===============================
// LOGIN MEJORADO
// ===============================

exports.login = async (req, res, next) => {
  const { email, password } = req.body;
  const client = await db.connect();
  
  try {
    // Validación básica
    if (!email || !password) {
      throw new ValidationError('Email y contraseña son requeridos');
    }

    await client.query('BEGIN');

    const userRes = await client.query(
      `SELECT u.id, u.name, u.email, u.password, u.is_verified, 
              u.failed_login_attempts, u.locked_until, r.name as role 
       FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE u.email = $1`,
      [email.toLowerCase().trim()]
    );

    // Usar mensaje genérico para evitar user enumeration
    const genericError = 'Credenciales inválidas';

    if (userRes.rowCount === 0) {
      await logSecurityEvent({
        type: 'failed_login_attempt',
        email,
        ip: hashIP(req.ip),
        reason: 'user_not_found'
      });
      
      // Delay artificial para prevenir timing attacks
      await bcrypt.compare(password, '$2b$10$dummyhashtopreventtimingattacks123456789');
      
      throw new UnauthorizedError(genericError);
    }

    const user = userRes.rows[0];

    // Verificar si la cuenta está bloqueada
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      
      await logSecurityEvent({
        type: 'login_attempt_while_locked',
        userId: user.id,
        email: user.email,
        ip: hashIP(req.ip),
        lockExpiresIn: minutesLeft
      });
      
      throw new ForbiddenError(
        `Cuenta bloqueada temporalmente. Intenta en ${minutesLeft} minutos.`
      );
    }

    // Verificar contraseña
    const passwordMatch = await bcrypt.compare(password, user.password);
    
    if (!passwordMatch) {
      // Incrementar contador de intentos fallidos
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const shouldLock = newAttempts >= MAX_LOGIN_ATTEMPTS;
      
      await client.query(
        `UPDATE users 
         SET failed_login_attempts = $1,
             locked_until = CASE 
               WHEN $2 THEN NOW() + INTERVAL '${LOCKOUT_DURATION_MINUTES} minutes'
               ELSE locked_until
             END
         WHERE id = $3`,
        [newAttempts, shouldLock, user.id]
      );

      await logSecurityEvent({
        type: 'failed_login_attempt',
        userId: user.id,
        email: user.email,
        ip: hashIP(req.ip),
        reason: 'invalid_password',
        attempts: newAttempts,
        locked: shouldLock
      });

      await client.query('COMMIT');

      if (shouldLock) {
        throw new ForbiddenError(
          `Cuenta bloqueada por ${LOCKOUT_DURATION_MINUTES} minutos debido a múltiples intentos fallidos.`
        );
      }

      const attemptsLeft = MAX_LOGIN_ATTEMPTS - newAttempts;
      throw new UnauthorizedError(
        `${genericError}. Intentos restantes: ${attemptsLeft}`
      );
    }

    // Verificar que el usuario esté verificado
    if (!user.is_verified) {
      await logSecurityEvent({
        type: 'login_unverified_user',
        userId: user.id,
        email: user.email,
        ip: hashIP(req.ip)
      });
      
      await client.query('COMMIT');
      
      throw new ForbiddenError(
        'Por favor, verifica tu correo antes de iniciar sesión.'
      );
    }

    // Login exitoso - resetear intentos fallidos
    await client.query(
      `UPDATE users 
       SET failed_login_attempts = 0, 
           locked_until = NULL,
           last_login_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // Generar token
    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
    );

    // Log login exitoso
    await logSecurityEvent({
      type: 'successful_login',
      userId: user.id,
      email: user.email,
      ip: hashIP(req.ip),
      userAgent: req.get('user-agent')
    });

    await client.query('COMMIT');

    res.json({
      token,
      user: sanitizeUserResponse({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      })
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

// ===============================
// REGISTER MEJORADO
// ===============================

exports.register = async (req, res, next) => {
  const { name, email, password, phone } = req.body;
  const client = await db.connect();
  
  try {
    // Validación de entrada
    if (!name || !email || !password) {
      throw new ValidationError('Nombre, email y contraseña son requeridos');
    }

    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new ValidationError('Formato de email inválido');
    }

    // Validar fortaleza de contraseña
    if (password.length < 8) {
      throw new ValidationError('La contraseña debe tener al menos 8 caracteres');
    }

    const normalizedEmail = email.toLowerCase().trim();

    await client.query('BEGIN');

    // Verificar si el usuario ya existe
    const existing = await client.query(
      "SELECT id, email FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      
      await logSecurityEvent({
        type: 'duplicate_registration_attempt',
        email: normalizedEmail,
        ip: hashIP(req.ip)
      });
      
      // No revelar que el email existe - mensaje genérico
      throw new ValidationError('No se pudo completar el registro. Por favor verifica tus datos.');
    }

    // Generar código de verificación seguro
    const verificationCode = generateVerificationCode();
    const codeExpiry = getExpiryTimestamp(VERIFICATION_CODE_EXPIRY_MINUTES);
    
    // Hashear contraseña
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insertar usuario
    const userRes = await client.query(
      `INSERT INTO users (
        name, email, password, phone, 
        verification_code, verification_code_expires_at,
        verification_attempts, is_verified
      ) 
       VALUES ($1, $2, $3, $4, $5, $6, 0, false) 
       RETURNING id, name, email`,
      [
        name.trim(), 
        normalizedEmail, 
        hashedPassword, 
        phone?.trim() || null, 
        verificationCode,
        codeExpiry
      ]
    );

    const newUser = userRes.rows[0];

    // Asignar rol de Customer (3)
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)",
      [newUser.id]
    );

    // Enviar correo de verificación
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'Alesteb System <onboarding@resend.dev>',
        to: [normalizedEmail],
        subject: 'Tu Código de Verificación - Alesteb',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">Bienvenido a Alesteb</h1>
            </div>
            
            <div style="padding: 40px 30px;">
              <h2 style="color: #333; margin: 0 0 20px 0; font-size: 24px;">¡Hola ${name}! 👋</h2>
              
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">
                Gracias por registrarte. Para activar tu cuenta, usa el siguiente código de verificación:
              </p>
              
              <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin: 30px 0; border-radius: 4px;">
                <div style="text-align: center; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #667eea; font-family: 'Courier New', monospace;">
                  ${verificationCode}
                </div>
              </div>
              
              <p style="color: #666; font-size: 14px; line-height: 1.6; margin: 20px 0 0 0;">
                <strong>Este código expira en ${VERIFICATION_CODE_EXPIRY_MINUTES} minutos.</strong><br>
                Si no solicitaste este registro, puedes ignorar este correo de forma segura.
              </p>
            </div>
            
            <div style="background: #f8f9fa; padding: 20px 30px; border-top: 1px solid #e0e0e0;">
              <p style="color: #999; font-size: 12px; margin: 0; text-align: center;">
                © ${new Date().getFullYear()} Alesteb. Todos los derechos reservados.<br>
                Este es un email automático, por favor no respondas.
              </p>
            </div>
          </div>`
      });
    } catch (mailError) {
      logger.error("RESEND ERROR:", {
        message: mailError.message,
        userId: newUser.id,
        email: normalizedEmail
      });
      
      // Rollback si el email falla
      await client.query('ROLLBACK');
      throw new Error('Error al enviar el correo de verificación. Intenta nuevamente más tarde.');
    }

    await client.query('COMMIT');

    // Log registro exitoso
    await logSecurityEvent({
      type: 'successful_registration',
      userId: newUser.id,
      email: normalizedEmail,
      ip: hashIP(req.ip)
    });

    res.status(201).json({
      message: `Código de verificación enviado a ${normalizedEmail}. Expira en ${VERIFICATION_CODE_EXPIRY_MINUTES} minutos.`,
      email: normalizedEmail
    });

  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

// ===============================
// VERIFY CODE MEJORADO
// ===============================

exports.verifyCode = async (req, res, next) => {
  const { email, code } = req.body;
  const client = await db.connect();
  
  try {
    // Validación básica
    if (!email || !code) {
      throw new ValidationError('Email y código son requeridos');
    }

    if (!/^\d{6}$/.test(code)) {
      throw new ValidationError('Código inválido');
    }

    const normalizedEmail = email.toLowerCase().trim();

    await client.query('BEGIN');

    // Obtener usuario con código
    const userRes = await client.query(
      `SELECT id, name, email, verification_code, verification_code_expires_at, 
              verification_attempts, is_verified
       FROM users
       WHERE email = $1`,
      [normalizedEmail]
    );

    if (userRes.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ValidationError('Usuario no encontrado');
    }

    const user = userRes.rows[0];

    // Verificar si ya está verificado
    if (user.is_verified) {
      await client.query('ROLLBACK');
      throw new ValidationError('Esta cuenta ya está verificada');
    }

    // Verificar límite de intentos
    if ((user.verification_attempts || 0) >= VERIFICATION_CODE_MAX_ATTEMPTS) {
      await logSecurityEvent({
        type: 'verification_max_attempts_exceeded',
        userId: user.id,
        email: normalizedEmail,
        ip: hashIP(req.ip)
      });

      await client.query('ROLLBACK');
      
      throw new ForbiddenError(
        'Máximo de intentos excedido. Solicita un nuevo código.'
      );
    }

    // Verificar expiración
    if (!user.verification_code_expires_at || new Date(user.verification_code_expires_at) < new Date()) {
      await client.query('ROLLBACK');
      
      await logSecurityEvent({
        type: 'expired_verification_attempt',
        userId: user.id,
        email: normalizedEmail,
        ip: hashIP(req.ip)
      });

      throw new ValidationError('El código ha expirado. Solicita uno nuevo.');
    }

    // Verificar código usando comparación timing-safe
    if (!timingSafeCompare(code, user.verification_code)) {
      // Incrementar intentos fallidos
      await client.query(
        `UPDATE users 
         SET verification_attempts = verification_attempts + 1
         WHERE id = $1`,
        [user.id]
      );

      await logSecurityEvent({
        type: 'failed_verification_attempt',
        userId: user.id,
        email: normalizedEmail,
        ip: hashIP(req.ip),
        attempts: (user.verification_attempts || 0) + 1
      });

      await client.query('COMMIT');

      const attemptsLeft = VERIFICATION_CODE_MAX_ATTEMPTS - (user.verification_attempts || 0) - 1;
      throw new ValidationError(
        `Código incorrecto. Intentos restantes: ${attemptsLeft}`
      );
    }

    // Código válido - verificar cuenta
    await client.query(
      `UPDATE users 
       SET is_verified = true, 
           verification_code = NULL,
           verification_code_expires_at = NULL,
           verification_attempts = 0,
           email_verified_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    await logSecurityEvent({
      type: 'successful_verification',
      userId: user.id,
      email: normalizedEmail,
      ip: hashIP(req.ip)
    });

    await client.query('COMMIT');

    res.json({ 
      message: "Cuenta verificada con éxito. Ya puedes iniciar sesión.",
      user: sanitizeUserResponse({
        id: user.id,
        name: user.name,
        email: user.email
      })
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

// ===============================
// RESEND CODE MEJORADO
// ===============================

exports.resendCode = async (req, res, next) => {
  const { email } = req.body;
  const client = await db.connect();
  
  try {
    if (!email) {
      throw new ValidationError('Email es requerido');
    }

    const normalizedEmail = email.toLowerCase().trim();

    await client.query('BEGIN');

    const userRes = await client.query(
      "SELECT id, name, email, is_verified FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (userRes.rowCount === 0) {
      await client.query('ROLLBACK');
      // No revelar si el usuario existe
      throw new ValidationError('Si el email existe, recibirás un nuevo código.');
    }

    const user = userRes.rows[0];

    if (user.is_verified) {
      await client.query('ROLLBACK');
      throw new ValidationError('La cuenta ya está verificada');
    }

    // Generar nuevo código
    const newCode = generateVerificationCode();
    const codeExpiry = getExpiryTimestamp(VERIFICATION_CODE_EXPIRY_MINUTES);

    // Actualizar código y resetear intentos
    await client.query(
      `UPDATE users 
       SET verification_code = $1, 
           verification_code_expires_at = $2,
           verification_attempts = 0
       WHERE id = $3`,
      [newCode, codeExpiry, user.id]
    );

    // Enviar correo
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'Alesteb System <onboarding@resend.dev>',
        to: [normalizedEmail],
        subject: 'Nuevo Código de Verificación - Alesteb',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <h2 style="color: #333;">Hola ${user.name},</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.6;">
              Solicitaste un nuevo código de verificación. Aquí está:
            </p>
            <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #667eea; border-radius: 8px; margin: 30px 0; font-family: 'Courier New', monospace;">
              ${newCode}
            </div>
            <p style="color: #999; font-size: 14px;">
              Este código expira en ${VERIFICATION_CODE_EXPIRY_MINUTES} minutos.
            </p>
          </div>`
      });
    } catch (mailError) {
      logger.error("RESEND CODE EMAIL ERROR:", mailError);
      await client.query('ROLLBACK');
      throw new Error('Error al enviar el correo');
    }

    await logSecurityEvent({
      type: 'verification_code_resent',
      userId: user.id,
      email: normalizedEmail,
      ip: hashIP(req.ip)
    });

    await client.query('COMMIT');

    res.json({ 
      message: `Código reenviado a ${normalizedEmail}. Expira en ${VERIFICATION_CODE_EXPIRY_MINUTES} minutos.`
    });

  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
};

// ===============================
// LOGOUT (Nuevo - para invalidar token)
// ===============================

exports.logout = async (req, res, next) => {
  try {
    // Si implementas blacklist de tokens:
    // await addToBlacklist(req.token);

    await logSecurityEvent({
      type: 'user_logout',
      userId: req.user?.id,
      ip: hashIP(req.ip)
    });

    res.json({ message: 'Logout exitoso' });
  } catch (error) {
    next(error);
  }
};
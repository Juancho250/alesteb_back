const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

// ============================================
// 🔐 CONFIGURACIÓN DE SEGURIDAD
// ============================================

const SALT_ROUNDS = 12; // Más seguro que 10
const JWT_ACCESS_EXPIRY = "15m"; // Token de acceso corto
const JWT_REFRESH_EXPIRY = "7d"; // Token de refresco largo
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutos en ms

// Validador de email robusto
const isValidEmail = (email) => {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
};

// Validador de contraseña segura
const isStrongPassword = (password) => {
  // Mínimo 8 caracteres, al menos 1 mayúscula, 1 minúscula, 1 número
  return password.length >= 8 && 
         /[A-Z]/.test(password) && 
         /[a-z]/.test(password) && 
         /[0-9]/.test(password);
};

// ============================================
// 🎫 GENERACIÓN DE TOKENS
// ============================================

const generateAccessToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, { 
    expiresIn: JWT_ACCESS_EXPIRY,
    issuer: 'alesteb-api',
    audience: 'alesteb-client'
  });
};

const generateRefreshToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { 
    expiresIn: JWT_REFRESH_EXPIRY,
    issuer: 'alesteb-api',
    audience: 'alesteb-client'
  });
};

// ============================================
// 📊 OBTENCIÓN DE DATOS DE USUARIO
// ============================================

const getUserPermissionsAndRoles = async (userId) => {
  const client = await db.connect();
  try {
    // Obtener roles
    const rolesRes = await client.query(
      `SELECT r.name, r.id
       FROM roles r 
       JOIN user_roles ur ON ur.role_id = r.id 
       WHERE ur.user_id = $1`,
      [userId]
    );
    const roles = rolesRes.rows.map(r => r.name);
    const roleIds = rolesRes.rows.map(r => r.id);

    // Obtener permisos (de roles + individuales)
    const permissionsRes = await client.query(
      `SELECT DISTINCT p.slug, p.name
       FROM permissions p
       LEFT JOIN role_permissions rp ON rp.permission_id = p.id
       LEFT JOIN user_roles ur ON ur.role_id = rp.role_id
       LEFT JOIN user_permissions up ON up.permission_id = p.id
       WHERE ur.user_id = $1 OR up.user_id = $1`,
      [userId]
    );
    const permissions = permissionsRes.rows.map(p => p.slug);

    return { roles, roleIds, permissions };
  } finally {
    client.release();
  }
};

// ============================================
// 🔓 LOGIN
// ============================================

exports.login = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { email, password, deviceInfo } = req.body;

    // ✅ Validación de entrada
    if (!email || !password) {
      return res.status(400).json({ 
        success: false,
        message: "Email y contraseña son requeridos" 
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ 
        success: false,
        message: "Formato de email inválido" 
      });
    }

    await client.query('BEGIN');

    // 1️⃣ Buscar usuario (con información de bloqueo)
    const userRes = await client.query(
      `SELECT id, email, password, name, phone, cedula, city, address,
              failed_login_attempts, locked_until, is_active
       FROM users 
       WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (userRes.rowCount === 0) {
      await client.query('ROLLBACK');
      // ⚠️ Mensaje genérico para evitar enumeration attacks
      return res.status(401).json({ 
        success: false,
        message: "Credenciales inválidas" 
      });
    }

    const user = userRes.rows[0];

    // 2️⃣ Verificar si la cuenta está activa
    if (!user.is_active) {
      await client.query('ROLLBACK');
      return res.status(403).json({ 
        success: false,
        message: "Cuenta desactivada. Contacta al administrador" 
      });
    }

    // 3️⃣ Verificar si está bloqueado por intentos fallidos
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await client.query('ROLLBACK');
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({ 
        success: false,
        message: `Cuenta bloqueada temporalmente. Intenta en ${minutesLeft} minutos` 
      });
    }

    // 4️⃣ Validar contraseña (con protección contra timing attacks)
    const isValidPassword = await bcrypt.compare(password, user.password);
    
    if (!isValidPassword) {
      // Incrementar intentos fallidos
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      
      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_TIME);
        await client.query(
          `UPDATE users 
           SET failed_login_attempts = $1, locked_until = $2 
           WHERE id = $3`,
          [newAttempts, lockUntil, user.id]
        );
        await client.query('COMMIT');
        
        return res.status(429).json({ 
          success: false,
          message: "Demasiados intentos fallidos. Cuenta bloqueada por 15 minutos" 
        });
      }
      
      await client.query(
        "UPDATE users SET failed_login_attempts = $1 WHERE id = $2",
        [newAttempts, user.id]
      );
      await client.query('COMMIT');
      
      return res.status(401).json({ 
        success: false,
        message: "Credenciales inválidas",
        attemptsLeft: MAX_LOGIN_ATTEMPTS - newAttempts
      });
    }

    // 5️⃣ Login exitoso - Resetear intentos fallidos
    await client.query(
      `UPDATE users 
       SET failed_login_attempts = 0, 
           locked_until = NULL,
           last_login = NOW() 
       WHERE id = $1`,
      [user.id]
    );

    // 6️⃣ Obtener roles y permisos
    const { roles, roleIds, permissions } = await getUserPermissionsAndRoles(user.id);

    // 7️⃣ Generar tokens
    const tokenPayload = { 
      id: user.id, 
      email: user.email,
      name: user.name,
      roles, 
      permissions 
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken({ id: user.id, email: user.email });

    // 8️⃣ Guardar refresh token en DB (para poder revocarlo después)
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
      [user.id, tokenHash, deviceInfo || 'unknown']
    );

    await client.query('COMMIT');

    // 9️⃣ Log de auditoría
    console.log(`[LOGIN SUCCESS] User ${user.email} (ID: ${user.id}) logged in`);

    // 🔟 Respuesta exitosa
    res.json({
      success: true,
      message: "Login exitoso",
      data: {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name || "Usuario",
          phone: user.phone,
          cedula: user.cedula,
          city: user.city,
          address: user.address,
          roles,
          permissions
        }
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[LOGIN ERROR]", error);
    
    res.status(500).json({ 
      success: false,
      message: "Error en el servidor. Intenta nuevamente" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🔄 REFRESH TOKEN
// ============================================

exports.refreshToken = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ 
        success: false,
        message: "Refresh token requerido" 
      });
    }

    // Verificar el token
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
        issuer: 'alesteb-api',
        audience: 'alesteb-client'
      });
    } catch (error) {
      return res.status(401).json({ 
        success: false,
        message: "Refresh token inválido o expirado" 
      });
    }

    // Verificar que el token existe en la DB y no ha sido revocado
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const tokenRes = await client.query(
      `SELECT id FROM refresh_tokens 
       WHERE user_id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()`,
      [decoded.id, tokenHash]
    );

    if (tokenRes.rowCount === 0) {
      return res.status(401).json({ 
        success: false,
        message: "Refresh token inválido o revocado" 
      });
    }

    // Obtener datos actualizados del usuario
    const userRes = await client.query(
      "SELECT id, email, name, is_active FROM users WHERE id = $1",
      [decoded.id]
    );

    if (userRes.rowCount === 0 || !userRes.rows[0].is_active) {
      return res.status(401).json({ 
        success: false,
        message: "Usuario no encontrado o inactivo" 
      });
    }

    const user = userRes.rows[0];
    const { roles, permissions } = await getUserPermissionsAndRoles(user.id);

    // Generar nuevo access token
    const newAccessToken = generateAccessToken({ 
      id: user.id, 
      email: user.email,
      name: user.name,
      roles, 
      permissions 
    });

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken
      }
    });

  } catch (error) {
    console.error("[REFRESH TOKEN ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error en el servidor" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 🚪 LOGOUT
// ============================================

exports.logout = async (req, res) => {
  const client = await db.connect();
  
  try {
    const { refreshToken } = req.body;
    const userId = req.user?.id; // Del middleware de autenticación

    if (refreshToken) {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      
      await client.query(
        `UPDATE refresh_tokens 
         SET revoked = true, revoked_at = NOW() 
         WHERE token_hash = $1`,
        [tokenHash]
      );
    }

    // Opcionalmente, revocar todos los tokens del usuario
    if (userId) {
      await client.query(
        `UPDATE refresh_tokens 
         SET revoked = true, revoked_at = NOW() 
         WHERE user_id = $1 AND revoked = false`,
        [userId]
      );
    }

    res.json({
      success: true,
      message: "Logout exitoso"
    });

  } catch (error) {
    console.error("[LOGOUT ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error al cerrar sesión" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 📝 REGISTRO
// ============================================

exports.register = async (req, res) => {
  const client = await db.connect();

  try {
    const { email, password, name, cedula, phone } = req.body;

    // ✅ Validaciones
    if (!email || !password || !name || !cedula) {
      return res.status(400).json({ 
        success: false,
        message: "Campos requeridos: email, password, name, cedula" 
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ 
        success: false,
        message: "Formato de email inválido" 
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({ 
        success: false,
        message: "La contraseña debe tener mínimo 8 caracteres, incluyendo mayúsculas, minúsculas y números" 
      });
    }

    await client.query('BEGIN');

    // Verificar si el email ya existe
    const existingEmail = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    
    if (existingEmail.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false,
        message: "El email ya está registrado" 
      });
    }

    // Verificar si la cédula ya existe
    const existingCedula = await client.query(
      "SELECT id FROM users WHERE cedula = $1",
      [cedula.trim()]
    );
    
    if (existingCedula.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false,
        message: "La cédula ya está registrada" 
      });
    }

    // Hash de contraseña con salt fuerte
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Crear usuario
    const userRes = await client.query(
      `INSERT INTO users (email, password, name, cedula, phone, is_active)
       VALUES ($1, $2, $3, $4, $5, true) 
       RETURNING id, email, name`,
      [email.toLowerCase().trim(), hashedPassword, name.trim(), cedula.trim(), phone?.trim() || null]
    );
    
    const newUser = userRes.rows[0];

    // Asignar rol de cliente (ID 3) por defecto
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 3)",
      [newUser.id]
    );

    await client.query('COMMIT');

    console.log(`[REGISTER SUCCESS] New user: ${newUser.email} (ID: ${newUser.id})`);

    res.status(201).json({ 
      success: true,
      message: "Usuario registrado correctamente",
      data: {
        id: newUser.id,
        email: newUser.email,
        name: newUser.name
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[REGISTER ERROR]", error);
    
    res.status(500).json({ 
      success: false,
      message: "Error al registrar usuario" 
    });
  } finally {
    client.release();
  }
};

// ============================================
// 👤 OBTENER PERFIL ACTUAL
// ============================================

exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id; // Del middleware de autenticación

    const userRes = await db.query(
      `SELECT id, email, name, phone, cedula, city, address, created_at, last_login
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Usuario no encontrado" 
      });
    }

    const user = userRes.rows[0];
    const { roles, permissions } = await getUserPermissionsAndRoles(userId);

    res.json({
      success: true,
      data: {
        ...user,
        roles,
        permissions
      }
    });

  } catch (error) {
    console.error("[GET PROFILE ERROR]", error);
    res.status(500).json({ 
      success: false,
      message: "Error al obtener perfil" 
    });
  }
};
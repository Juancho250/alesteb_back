const jwt = require("jsonwebtoken");

const auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ message: "Token no enviado" });
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ message: "Formato de token inválido" });
    }

    const token = parts[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Guardamos el decodificado en req.user
    // El payload ahora será: { id, role }
    req.user = decoded;
    next();
  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res.status(403).json({ message: "Token inválido o expirado" });
  }
};

/**
 * 🛡️ Verifica roles (Simplificado)
 * Puede recibir un string "admin" o un array ["admin", "staff"]
 */
const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ message: "No autenticado o sin rol asignado" });
    }

    // Convertimos a array si nos pasan un solo string para poder usar .includes()
    const rolesToVerify = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    
    // Verificamos si el rol del usuario está en la lista permitida
    const hasRole = rolesToVerify.includes(req.user.role);

    if (!hasRole) {
      return res.status(403).json({ message: "No tienes nivel de acceso para esta sección" });
    }

    next();
  };
};

// 🛡️ Atajo rápido para administradores
const isAdmin = requireRole(['admin', 'super_admin']);

module.exports = { auth, requireRole, isAdmin };
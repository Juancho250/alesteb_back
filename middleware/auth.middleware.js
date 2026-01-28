const jwt = require("jsonwebtoken");

const auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: "Token no enviado" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded; // Contiene { id, role }
    next();
  } catch (error) {
    return res.status(403).json({ message: "Token inválido o expirado" });
  }
};

const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !req.user.role) return res.status(401).json({ message: "No autorizado" });

    const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (!rolesArray.includes(req.user.role)) {
      return res.status(403).json({ message: "No tienes permisos para esta sección" });
    }
    next();
  };
};

const isAdmin = requireRole(['admin', 'super_admin']);

module.exports = { auth, requireRole, isAdmin };
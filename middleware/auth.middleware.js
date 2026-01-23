// 🔐 Verifica token
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

    req.user = decoded;
    next();
  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res.status(403).json({ message: "Token inválido o expirado" });
  }
};

// 🛡️ Verifica roles
const requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user || !Array.isArray(req.user.roles)) {
      return res.status(401).json({ message: "No autenticado" });
    }

    const hasRole = req.user.roles.some(role =>
      allowedRoles.includes(role)
    );

    if (!hasRole) {
      return res.status(403).json({ message: "No autorizado" });
    }

    next();
  };
};

// 🛡️ Verifica permisos
const requirePermission = (requiredPermission) => {
  return (req, res, next) => {
    const userPermissions = req.user.permissions || [];
    const userRoles = req.user.roles || [];

    // Si es Super Admin, pasa siempre
    if (userRoles.includes('super_admin')) return next();

    if (!userPermissions.includes(requiredPermission)) {
      return res.status(403).json({ message: "No tienes permisos para realizar esta acción." });
    }

    next();
  };
};

module.exports = { auth, requirePermission, requireRole };

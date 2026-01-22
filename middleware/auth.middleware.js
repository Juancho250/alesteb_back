import jwt from "jsonwebtoken";
// Dentro de src/middleware/auth.middleware.js
module.exports = { auth, requireRole }; // 👈 Esto es clave

// 🔐 Verifica token
export const auth = (req, res, next) => {
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

    // Esperado: { id, roles: [] }
    req.user = decoded;
    next();
  } catch (error) {
    console.error("AUTH ERROR:", error.message);
    return res.status(403).json({ message: "Token inválido o expirado" });
  }
};

// 🛡️ Verifica roles
export const requireRole = (allowedRoles = []) => {
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

const operations = require("./operations.service");

exports.health = async (req, res) => {
  try {
    const data = await operations.getAuraOperationalHealth({
      ownerAdminId: req.auraAdminId,
      userId: req.user.id,
      roles: req.user.roles || [],
    });
    return res.json({ success: true, data, requestId: req.id });
  } catch (err) {
    if (res.headersSent) return res;
    const status = err.status || 500;
    return res.status(status).json({
      success: false,
      message: status >= 500 ? "No fue posible consultar la salud de AURA" : err.message,
      code: err.code || "AURA_OPERATIONS_ERROR",
      requestId: req.id,
    });
  }
};

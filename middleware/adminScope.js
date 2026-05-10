// middleware/adminScope.js
// Inyecta req.isSuperAdmin y req.adminId en cada request protegido.
// Se usa en ABSOLUTAMENTE TODAS las rutas del panel excepto /auth y /setup.
//
// REGLA ÚNICA:
//   superadmin  → ve y gestiona TODO de TODOS los admins
//   admin       → ve y gestiona SOLO lo que creó (created_by = su id)
//   No hay excepciones: productos, categorías, proveedores, banners,
//   gastos, ventas, órdenes, facturas, presupuestos, descuentos… todo.

const adminScope = (req, _res, next) => {
  req.isSuperAdmin = req.user.roles.includes("superadmin");
  req.adminId      = req.user.id;
  next();
};

// Helper reutilizable en controllers:
//
//   const { isSuperAdmin, adminId } = req;
//
//   // Para tablas con created_by:
//   const { where, params } = scopeByCreator(isSuperAdmin, adminId);
//   await db.query(`SELECT * FROM sales s ${where} ORDER BY s.sale_date DESC`, params);
//
//   // Para tablas con owner_admin_id:
//   const { where, params } = scopeByOwner(isSuperAdmin, adminId);
//   await db.query(`SELECT * FROM users u ${where} ORDER BY u.id DESC`, params);

/**
 * Devuelve cláusula WHERE + params para filtrar por created_by.
 * @param {boolean} isSuperAdmin
 * @param {number}  adminId
 * @param {string}  [alias=""] - alias de la tabla, p.ej. "s." para "s.created_by"
 * @param {number}  [paramOffset=0] - si ya hay params previos ($1, $2…)
 */
const scopeByCreator = (isSuperAdmin, adminId, alias = "", paramOffset = 0) => {
  if (isSuperAdmin) return { where: "", params: [] };
  return {
    where:  `AND ${alias}created_by = $${paramOffset + 1}`,
    params: [adminId],
  };
};

/**
 * Devuelve cláusula WHERE + params para filtrar por owner_admin_id.
 */
const scopeByOwner = (isSuperAdmin, adminId, alias = "", paramOffset = 0) => {
  if (isSuperAdmin) return { where: "", params: [] };
  return {
    where:  `AND ${alias}owner_admin_id = $${paramOffset + 1}`,
    params: [adminId],
  };
};

/**
 * Inyecta un filtro dinámico en una query que ya tiene WHERE.
 * Útil cuando ya tienes condiciones fijas y quieres agregar el scope.
 *
 * Ejemplo:
 *   const { clause, params } = scopeClause(isSuperAdmin, adminId, "s.", existingParams.length);
 *   await db.query(`SELECT * FROM sales s WHERE payment_status = $1 ${clause}`, [...existingParams, ...params]);
 */
/**
 * Filtra por `admin_id`.
 * Usado en: api_keys.
 */
const scopeByAdminId = (isSuperAdmin, adminId, alias = "", paramOffset = 0) => {
  if (isSuperAdmin) return { where: "", params: [] };
  return {
    where:  `AND ${alias}admin_id = $${paramOffset + 1}`,
    params: [adminId],
  };
};

/**
 * Verifica que un registro pertenezca al admin antes de UPDATE/DELETE.
 * @param {object} db - instancia de pg pool
 * @param {string} table - nombre de la tabla
 * @param {number} recordId - id del registro
 * @param {number} adminId - id del admin autenticado
 * @param {string} [col] - columna de ownership (default: "created_by")
 */
const assertOwnership = async (db, table, recordId, adminId, col = "created_by") => {
  const res = await db.query(
    `SELECT id FROM ${table} WHERE id = $1 AND ${col} = $2`,
    [recordId, adminId]
  );
  return res.rowCount > 0;
};

module.exports = {
  adminScope,
  scopeByCreator,
  scopeByOwner,
  scopeByAdminId,
  assertOwnership,
};
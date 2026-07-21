'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../../platform/database');

const AUDIENCE = 'credit-installment-pay';
const EXPIRES_IN = '72h';

function getSecret() {
  const secret = process.env.CREDIT_PAY_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error('No hay secreto configurado para links de pago');
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

function getBackendUrl() {
  return (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

async function generateInstallmentPayToken(installmentId, ownerAdminId) {
  const { rows: [installment] } = await db.query(
    `SELECT cps.id, cps.status
     FROM credit_payment_schedule cps
     JOIN sales s ON s.id = cps.sale_id
     WHERE cps.id = $1
       AND cps.owner_admin_id = $2
       AND s.owner_admin_id = $2
     LIMIT 1`,
    [installmentId, ownerAdminId]
  );

  if (!installment) {
    const err = new Error('Cuota no encontrada para este negocio');
    err.statusCode = 404;
    throw err;
  }

  if (installment.status !== 'pending') {
    const err = new Error('La cuota ya no esta pendiente');
    err.statusCode = 409;
    err.alreadyPaid = installment.status === 'paid';
    throw err;
  }

  const token = jwt.sign(
    {
      sub: String(installmentId),
      aud: AUDIENCE,
      oid: ownerAdminId,
    },
    getSecret(),
    { expiresIn: EXPIRES_IN }
  );

  return `${getBackendUrl()}/pay/${encodeURIComponent(token)}`;
}

async function verifyInstallmentPayToken(token) {
  let decoded;
  try {
    decoded = jwt.verify(token, getSecret(), { audience: AUDIENCE });
  } catch (err) {
    const publicErr = new Error(err.name === 'TokenExpiredError'
      ? 'El link de pago expiro'
      : 'Link de pago invalido');
    publicErr.statusCode = 401;
    throw publicErr;
  }

  const installmentId = Number(decoded.sub);
  const ownerAdminId  = decoded.oid;

  if (!installmentId || !ownerAdminId) {
    const err = new Error('Link de pago incompleto');
    err.statusCode = 400;
    throw err;
  }

  const { rows: [row] } = await db.query(
    `SELECT
       cps.id,
       cps.sale_id,
       cps.installment_num AS installment_number,
       cps.expected_amount,
       cps.due_date,
       cps.status,
       s.sale_number,
       s.owner_admin_id,
       COALESCE(u.name, s.customer_name, c.name, 'Cliente') AS customer_name,
       COALESCE(u.email, s.customer_email, c.email) AS customer_email,
       COUNT(*) OVER (PARTITION BY cps.sale_id) AS total_installments
     FROM credit_payment_schedule cps
     JOIN sales s ON s.id = cps.sale_id
     LEFT JOIN users u ON u.id = s.customer_id
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE cps.id = $1
       AND cps.owner_admin_id = $2
       AND s.owner_admin_id = $2
     LIMIT 1`,
    [installmentId, ownerAdminId]
  );

  if (!row) {
    const err = new Error('Cuota no encontrada');
    err.statusCode = 404;
    throw err;
  }

  if (row.status === 'paid') {
    const err = new Error('Esta cuota ya fue pagada');
    err.statusCode = 409;
    err.alreadyPaid = true;
    throw err;
  }

  if (row.status !== 'pending') {
    const err = new Error('Esta cuota no esta disponible para pago');
    err.statusCode = 409;
    throw err;
  }

  return row;
}

module.exports = {
  generateInstallmentPayToken,
  verifyInstallmentPayToken,
};

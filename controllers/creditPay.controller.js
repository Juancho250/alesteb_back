'use strict';

const crypto = require('crypto');
const db     = require('../config/db');
const { decrypt } = require('../utils/crypto');
const { verifyInstallmentPayToken } = require('../services/creditPayToken.service');
const { syncPaymentStatus } = require('./creditSchedule.controller');

function getBackendUrl() {
  return (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function money(value) {
  return Number(value || 0).toLocaleString('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });
}

function formatDate(value) {
  if (!value) return 'Sin fecha';
  return new Date(value).toLocaleDateString('es-CO', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Bogota',
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function wompiIntegritySignature(reference, amountInCents, currency, integritySecret) {
  return crypto
    .createHash('sha256')
    .update(`${reference}${Math.round(Number(amountInCents))}${currency}${integritySecret}`)
    .digest('hex');
}

function renderShell({ title, body, tone = 'default' }) {
  const accent = tone === 'success' ? '#16a34a' : tone === 'error' ? '#dc2626' : '#7c3aed';
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | ALESTEB</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #0f172a;
      background:
        radial-gradient(circle at top left, rgba(124, 58, 237, .38), transparent 34rem),
        radial-gradient(circle at bottom right, rgba(14, 165, 233, .28), transparent 30rem),
        linear-gradient(135deg, #020617 0%, #0f172a 48%, #111827 100%);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(100%, 520px);
      background: rgba(255, 255, 255, .96);
      border: 1px solid rgba(255, 255, 255, .6);
      border-radius: 18px;
      box-shadow: 0 24px 80px rgba(2, 6, 23, .36);
      overflow: hidden;
    }
    .top {
      padding: 24px 24px 18px;
      border-bottom: 1px solid #e5e7eb;
    }
    .brand {
      font-size: 12px;
      letter-spacing: .16em;
      font-weight: 800;
      color: ${accent};
    }
    h1 {
      margin: 10px 0 0;
      font-size: clamp(26px, 7vw, 36px);
      line-height: 1.05;
      letter-spacing: 0;
    }
    .content { padding: 24px; }
    .summary {
      display: grid;
      gap: 12px;
      margin: 0 0 22px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 0;
      border-bottom: 1px solid #eef2f7;
    }
    .label { color: #64748b; font-size: 14px; }
    .value { color: #0f172a; font-weight: 700; text-align: right; }
    .amount {
      margin: 22px 0;
      padding: 18px;
      border-radius: 14px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      text-align: center;
    }
    .amount span { display: block; color: #64748b; font-size: 13px; }
    .amount strong { display: block; margin-top: 6px; font-size: 34px; color: #111827; }
    .message { color: #475569; line-height: 1.55; margin: 0 0 20px; }
    .actions { display: grid; justify-items: center; gap: 12px; }
    a.button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      padding: 0 18px;
      border-radius: 12px;
      background: ${accent};
      color: white;
      text-decoration: none;
      font-weight: 800;
    }
    .muted { color: #64748b; font-size: 13px; text-align: center; margin: 8px 0 0; }
    @media (max-width: 420px) {
      body { padding: 14px; }
      .top, .content { padding: 20px; }
      .row { display: grid; gap: 4px; }
      .value { text-align: left; }
      .amount strong { font-size: 28px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="top">
      <div class="brand">ALESTEB PAY</div>
      <h1>${escapeHtml(title)}</h1>
    </section>
    <section class="content">${body}</section>
  </main>
</body>
</html>`;
}

function renderErrorPage(res, title, message, status = 400, tone = 'error') {
  return res.status(status).send(renderShell({
    title,
    tone,
    body: `<p class="message">${escapeHtml(message)}</p>
      <p class="muted">Si necesitas ayuda, contacta directamente al negocio.</p>`,
  }));
}

async function loadActiveWompiAccount(ownerAdminId) {
  const { rows: [acct] } = await db.query(
    `SELECT id, provider, environment, status, public_key, integrity_secret_encrypted
     FROM store_payment_accounts
     WHERE admin_id = $1
       AND provider = 'wompi'
       AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    [ownerAdminId]
  );
  return acct ?? null;
}

async function renderPayPage(req, res) {
  try {
    const installment = await verifyInstallmentPayToken(req.params.token);
    const account = await loadActiveWompiAccount(installment.owner_admin_id);

    if (!account) {
      return renderErrorPage(
        res,
        'Pago no disponible',
        'Este negocio aun no tiene una cuenta de Wompi configurada para recibir pagos.',
        402
      );
    }

    if (account.status !== 'connected') {
      return renderErrorPage(
        res,
        'Pago no disponible',
        'La cuenta de Wompi del negocio esta pendiente de verificacion.',
        402
      );
    }

    const integritySecret = decrypt(account.integrity_secret_encrypted);
    const amountInCents  = Math.round(Number(installment.expected_amount) * 100);
    const currency       = 'COP';
    const reference      = `INST-${installment.id}-${Date.now()}`;
    const signature      = wompiIntegritySignature(reference, amountInCents, currency, integritySecret);
    const redirectUrl    = `${getBackendUrl()}/pay/result`;

    // Registrar intento para que el webhook pueda validar firma y procesar la cuota.
    await db.query(
      `INSERT INTO sale_payment_transactions
         (sale_id, owner_admin_id, store_payment_account_id, provider, reference, amount_in_cents, currency, status)
       VALUES ($1, $2, $3, 'wompi', $4, $5, $6, 'pending')
       ON CONFLICT (reference) DO NOTHING`,
      [
        installment.sale_id,
        installment.owner_admin_id,
        account.id,
        reference,
        amountInCents,
        currency,
      ]
    );

    return res.send(renderShell({
      title: 'Pagar cuota',
      body: `
        <div class="summary">
          <div class="row"><span class="label">Venta</span><span class="value">${escapeHtml(installment.sale_number)}</span></div>
          <div class="row"><span class="label">Cliente</span><span class="value">${escapeHtml(installment.customer_name)}</span></div>
          <div class="row"><span class="label">Cuota</span><span class="value">${escapeHtml(installment.installment_number)} de ${escapeHtml(installment.total_installments)}</span></div>
          <div class="row"><span class="label">Fecha limite</span><span class="value">${escapeHtml(formatDate(installment.due_date))}</span></div>
        </div>
        <div class="amount">
          <span>Total a pagar</span>
          <strong>${escapeHtml(money(installment.expected_amount))}</strong>
        </div>
        <div class="actions">
          <script src="https://checkout.wompi.co/widget.js"
            data-render="button"
            data-public-key="${escapeHtml(account.public_key)}"
            data-currency="${currency}"
            data-amount-in-cents="${amountInCents}"
            data-reference="${escapeHtml(reference)}"
            data-signature:integrity="${escapeHtml(signature)}"
            data-redirect-url="${escapeHtml(redirectUrl)}"
            data-customer-data:email="${escapeHtml(installment.customer_email || '')}"
            data-customer-data:full-name="${escapeHtml(installment.customer_name || '')}"></script>
          <p class="muted">Pago seguro procesado por Wompi.</p>
        </div>`,
    }));
  } catch (err) {
    if (err.alreadyPaid) {
      return renderErrorPage(res, 'Cuota pagada', 'Esta cuota ya fue pagada. Gracias por estar al dia.', 200, 'success');
    }
    console.error('[CreditPay] renderPayPage:', err.message);
    return renderErrorPage(res, 'Link no disponible', err.message || 'No pudimos preparar este pago.', err.statusCode || 500);
  }
}

async function renderResultPage(req, res) {
  const txId = String(req.query.id || '').trim();

  return res.send(renderShell({
    title: 'Resultado del pago',
    body: `
      <p id="message" class="message">${txId ? 'Consultando el estado de tu transaccion...' : 'No recibimos el identificador de la transaccion.'}</p>
      <div id="status" class="amount"><span>Estado</span><strong>${txId ? '...' : 'Sin datos'}</strong></div>
      <p class="muted">Puedes cerrar esta ventana cuando Wompi confirme el estado.</p>
      <script>
        (function () {
          var txId = ${JSON.stringify(txId)};
          var statusEl = document.querySelector('#status strong');
          var msgEl = document.querySelector('#message');
          if (!txId) return;

          fetch('https://production.wompi.co/v1/transactions/' + encodeURIComponent(txId))
            .then(function (r) { return r.json(); })
            .then(function (json) {
              var status = json && json.data && json.data.status ? json.data.status : 'UNKNOWN';
              statusEl.textContent = status;
              if (status === 'APPROVED') {
                msgEl.textContent = 'Pago aprobado. En unos segundos el negocio vera la cuota marcada como pagada.';
              } else if (status === 'DECLINED' || status === 'VOIDED' || status === 'ERROR') {
                msgEl.textContent = 'El pago no fue aprobado. Puedes intentarlo de nuevo desde el enlace del correo.';
              } else {
                msgEl.textContent = 'El pago esta pendiente de confirmacion. Wompi notificara al negocio automaticamente.';
              }
            })
            .catch(function () {
              statusEl.textContent = 'No disponible';
              msgEl.textContent = 'No pudimos consultar Wompi en este momento. Si pagaste, la confirmacion llegara automaticamente.';
            });
        })();
      </script>`,
  }));
}

async function processInstallmentPayment(client, transaction) {
  const reference = String(transaction?.reference || '');
  if (!reference.startsWith('INST-')) return false;
  if (transaction.status !== 'APPROVED') return true;

  const match = reference.match(/^INST-(\d+)-\d+$/);
  if (!match) {
    console.warn('[CreditPay] Referencia de cuota invalida:', reference);
    return true;
  }

  const installmentId = Number(match[1]);
  const amount = Number(transaction.amount_in_cents || 0) / 100;

  const { rows: [inst] } = await client.query(
    `SELECT cps.id, cps.sale_id, cps.installment_num, cps.status
     FROM credit_payment_schedule cps
     WHERE cps.id = $1
     FOR UPDATE`,
    [installmentId]
  );

  if (!inst) {
    console.warn('[CreditPay] Cuota no encontrada para referencia:', reference);
    return true;
  }

  if (inst.status === 'paid') return true;

  const { rows: [payment] } = await client.query(
    `INSERT INTO sale_payments (sale_id, amount, payment_method, notes, payment_date, created_by)
     VALUES ($1, $2, 'gateway', $3, CURRENT_DATE, NULL)
     RETURNING id`,
    [
      inst.sale_id,
      amount,
      `Wompi tx:${transaction.id} - cuota #${inst.installment_num}`,
    ]
  );

  await client.query(
    `UPDATE credit_payment_schedule
     SET status = 'paid',
         paid_at = NOW(),
         paid_amount = $1,
         sale_payment_id = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [amount, payment.id, installmentId]
  );

  await syncPaymentStatus(client, inst.sale_id);
  return true;
}

module.exports = {
  renderPayPage,
  renderResultPage,
  processInstallmentPayment,
};

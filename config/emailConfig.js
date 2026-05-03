// config/emailConfig.js

const SENDER = {
  name:  "Alesteb Boutique",
  email: process.env.BREVO_SENDER_EMAIL || "softturin@gmail.com",
};


// ============================================
// 🔧 INICIALIZACIÓN LAZY
// ============================================
let _apiInstance = null;
let _SendSmtpEmail = null;

function getBrevoClient() {
  if (_apiInstance) return { apiInstance: _apiInstance, SendSmtpEmail: _SendSmtpEmail };

  const brevo = require('@getbrevo/brevo');

  console.log('🔍 Brevo exports keys:', Object.keys(brevo));

  // ✅ Método correcto para @getbrevo/brevo v3+
  _SendSmtpEmail = brevo.SendSmtpEmail;

  if (!brevo.TransactionalEmailsApi || !_SendSmtpEmail) {
    throw new Error(`Brevo exports inválidos. Keys: ${Object.keys(brevo).join(', ')}`);
  }

  _apiInstance = new brevo.TransactionalEmailsApi();

  // ✅ AQUÍ estaba el bug: la autenticación cambió en v3
  _apiInstance.setApiKey(
    brevo.TransactionalEmailsApiApiKeys.apiKey,
    process.env.BREVO_API_KEY
  );

  console.log('🔑 API Key configurada:', process.env.BREVO_API_KEY
    ? `${process.env.BREVO_API_KEY.substring(0, 8)}...`
    : '❌ VACÍA'
  );

  return { apiInstance: _apiInstance, SendSmtpEmail: _SendSmtpEmail };
}

// ============================================
// 🔐 CÓDIGO DE VERIFICACIÓN
// ============================================
const generateVerificationCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const sendVerificationEmail = async (email, code, userName) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const sendSmtpEmail = new SendSmtpEmail();

  sendSmtpEmail.subject     = "🔐 Verifica tu cuenta - Alesteb Boutique";
  sendSmtpEmail.to          = [{ email, name: userName || 'Usuario' }];
  sendSmtpEmail.sender      = SENDER;
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html><html lang="es">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td style="background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:48px 40px;border-radius:20px 20px 0 0;text-align:center;">
                <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:50px;display:inline-block;padding:6px 20px;margin-bottom:20px;">
                  <span style="color:#93c5fd;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">Boutique Premium · 2026</span>
                </div>
                <div style="color:white;font-size:40px;font-weight:900;letter-spacing:-2px;text-transform:uppercase;margin:0;">ALESTEB</div>
                <div style="width:40px;height:3px;background:#3b82f6;margin:16px auto 24px;border-radius:2px;"></div>
                <div style="background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.4);border-radius:50px;display:inline-block;padding:10px 28px;">
                  <span style="color:#c7d2fe;font-size:13px;font-weight:700;">🔐 &nbsp;VERIFICACIÓN DE CUENTA</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background:white;padding:48px 40px;">
                <p style="font-size:24px;color:#0f172a;font-weight:800;margin:0 0 12px;">¡Hola, ${userName || 'bienvenido/a'}! 👋</p>
                <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 36px;">
                  Estás a un paso de unirte a <strong style="color:#0f172a;">Alesteb Boutique</strong>.
                  Usa el código de abajo para activar tu cuenta. Es válido por <strong>10 minutos</strong>.
                </p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f8fafc,#f1f5f9);border:2px dashed #cbd5e1;border-radius:20px;margin-bottom:36px;">
                  <tr>
                    <td style="padding:36px;text-align:center;">
                      <div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:3px;text-transform:uppercase;margin-bottom:16px;">Tu código de verificación</div>
                      <div style="font-size:52px;font-weight:900;color:#0f172a;letter-spacing:10px;font-family:'Courier New',monospace;line-height:1;">${code}</div>
                      <div style="margin-top:20px;display:inline-block;background:#3b82f6;color:white;padding:7px 20px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:1px;">⏱ VÁLIDO POR 10 MINUTOS</div>
                    </td>
                  </tr>
                </table>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef9ec;border-left:4px solid #f59e0b;border-radius:0 12px 12px 0;margin-bottom:32px;">
                  <tr>
                    <td style="padding:18px 20px;">
                      <p style="font-size:13px;color:#78350f;margin:0;line-height:1.7;">
                        🔒 <strong>No compartas este código</strong> con nadie — Alesteb nunca te lo pedirá.<br>
                        ❌ Si no creaste esta cuenta, puedes ignorar este mensaje con total tranquilidad.
                      </p>
                    </td>
                  </tr>
                </table>
                <p style="font-size:13px;color:#94a3b8;text-align:center;margin:0;">
                  ¿Necesitas ayuda? Escríbenos a <a href="mailto:web@alesteb.com" style="color:#3b82f6;text-decoration:none;font-weight:700;">web@alesteb.com</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:#0f172a;padding:28px 40px;border-radius:0 0 20px 20px;text-align:center;">
                <div style="color:#475569;font-size:12px;">© 2026 Alesteb Boutique · Todos los derechos reservados</div>
                <div style="color:#334155;font-size:11px;margin-top:6px;">Este es un correo automático, por favor no respondas directamente.</div>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body></html>
  `;

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Email verificación enviado:', data.messageId);
    return true;
  } catch (error) {
    console.error('❌ Error al enviar email de verificación:', error);
    throw new Error('No se pudo enviar el código de verificación');
  }
};

// ============================================
// 📦 EMAIL DE CONFIRMACIÓN DE PEDIDO
// ============================================
const sendOrderConfirmationEmail = async (email, userName, orderData) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const { orderCode, total, items = [], shippingAddress, shippingCity, shippingNotes, paymentMethod } = orderData;

  const itemsRows = items.map(item => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:700;color:#0f172a;font-size:14px;">${item.name}</div>
        ${item.sku ? `<div style="font-size:11px;color:#94a3b8;margin-top:3px;">SKU: ${item.sku}</div>` : ''}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:center;color:#64748b;font-weight:700;font-size:14px;">x${item.quantity}</td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:900;color:#0f172a;font-size:14px;">$${Number(item.unit_price * item.quantity).toLocaleString('es-CO')}</td>
    </tr>
  `).join('');

  const paymentLabels = { transfer:'🏦 Transferencia bancaria', cash:'💵 Efectivo', credit:'💳 Crédito', check:'📄 Cheque' };
  const paymentLabel = paymentLabels[paymentMethod] || paymentMethod || 'Por confirmar';

  const sendSmtpEmail = new SendSmtpEmail();
  sendSmtpEmail.subject     = `✅ Tu pedido ${orderCode} fue recibido - Alesteb`;
  sendSmtpEmail.to          = [{ email, name: userName }];
  sendSmtpEmail.sender      = SENDER;
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html><html lang="es">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:48px 40px;border-radius:20px 20px 0 0;text-align:center;">
                <div style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:50px;display:inline-block;padding:6px 20px;margin-bottom:20px;">
                  <span style="color:#93c5fd;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">Boutique Premium · 2026</span>
                </div>
                <div style="color:white;font-size:40px;font-weight:900;letter-spacing:-2px;text-transform:uppercase;margin:0;">ALESTEB</div>
                <div style="width:40px;height:3px;background:#3b82f6;margin:16px auto 24px;border-radius:2px;"></div>
                <div style="background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.35);border-radius:50px;display:inline-block;padding:12px 32px;">
                  <span style="color:#86efac;font-size:14px;font-weight:800;">✓ &nbsp;PEDIDO RECIBIDO</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background:white;padding:48px 40px;">
                <p style="font-size:24px;color:#0f172a;font-weight:800;margin:0 0 12px;">¡Gracias, ${userName}! 🎉</p>
                <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 36px;">
                  Recibimos tu pedido correctamente. Nuestro equipo lo revisará y se pondrá en contacto
                  contigo para coordinar el pago y el envío. Guarda tu código para cualquier consulta.
                </p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:2px solid #e2e8f0;border-radius:16px;margin-bottom:36px;">
                  <tr>
                    <td style="padding:22px 28px;">
                      <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Código de pedido</div>
                      <div style="font-size:30px;font-weight:900;color:#0f172a;letter-spacing:2px;font-family:'Courier New',monospace;">${orderCode}</div>
                    </td>
                    <td style="padding:22px 28px;text-align:right;border-left:1px solid #e2e8f0;">
                      <div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Fecha</div>
                      <div style="font-size:14px;font-weight:700;color:#475569;">${new Date().toLocaleDateString('es-CO',{year:'numeric',month:'long',day:'numeric'})}</div>
                    </td>
                  </tr>
                </table>
                <div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">Resumen del pedido</div>
                <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:36px;">
                  <thead><tr style="background:#f8fafc;">
                    <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Producto</th>
                    <th style="padding:10px 16px;text-align:center;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Cant.</th>
                    <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Subtotal</th>
                  </tr></thead>
                  <tbody>${itemsRows}</tbody>
                  <tfoot><tr style="background:#0f172a;">
                    <td colspan="2" style="padding:16px 18px;color:rgba(255,255,255,0.6);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Total del pedido</td>
                    <td style="padding:16px 18px;text-align:right;color:white;font-size:22px;font-weight:900;">$${Number(total).toLocaleString('es-CO')}</td>
                  </tr></tfoot>
                </table>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;margin-bottom:${shippingAddress ? '32px' : '36px'};">
                  <tr><td style="padding:20px 24px;">
                    <div style="font-size:11px;font-weight:800;color:#92400e;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Método de pago</div>
                    <div style="font-size:15px;font-weight:700;color:#78350f;">${paymentLabel}</div>
                    <div style="font-size:13px;color:#92400e;margin-top:10px;line-height:1.6;">
                      Tu pedido se confirmará una vez verifiquemos tu pago. Contáctanos por WhatsApp con el código
                      <strong style="font-family:'Courier New',monospace;">${orderCode}</strong> para agilizar el proceso.
                    </div>
                  </td></tr>
                </table>
                ${shippingAddress ? `
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;margin-bottom:36px;">
                  <tr><td style="padding:20px 24px;">
                    <div style="font-size:11px;font-weight:800;color:#166534;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Dirección de envío</div>
                    <div style="font-weight:800;color:#14532d;font-size:15px;margin-bottom:4px;">📍 ${shippingCity || ''}</div>
                    <div style="color:#166534;font-size:14px;line-height:1.6;">${shippingAddress}</div>
                    ${shippingNotes ? `<div style="color:#15803d;font-size:13px;margin-top:8px;font-style:italic;">📝 ${shippingNotes}</div>` : ''}
                  </td></tr>
                </table>` : ''}
                <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
                  <a href="https://wa.me/573145055073?text=Hola!%20Quiero%20confirmar%20mi%20pedido%20${orderCode}"
                     style="display:inline-block;background:#16a34a;color:white;text-decoration:none;font-size:14px;font-weight:800;padding:17px 40px;border-radius:50px;letter-spacing:0.5px;">
                    💬 &nbsp;Confirmar pago por WhatsApp
                  </a>
                </td></tr></table>
              </td>
            </tr>
            <tr>
              <td style="background:#0f172a;padding:28px 40px;border-radius:0 0 20px 20px;text-align:center;">
                <div style="color:#475569;font-size:12px;">© 2026 Alesteb Boutique · Todos los derechos reservados</div>
                <div style="color:#334155;font-size:11px;margin-top:6px;">Este es un correo automático, por favor no respondas directamente.</div>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body></html>
  `;

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Email confirmación pedido enviado:', data.messageId);
    return true;
  } catch (error) {
    console.error('❌ Error al enviar email de confirmación:', error);
    return false;
  }
};

// ============================================
// ✅ EMAIL DE PAGO CONFIRMADO (Admin → Cliente)
// ============================================
const sendPaymentConfirmedEmail = async (email, userName, orderData) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const { orderCode, total, items = [], shippingAddress, shippingCity, shippingNotes, paymentMethod } = orderData;

  const paymentLabels = { transfer:'🏦 Transferencia bancaria', cash:'💵 Efectivo', credit:'💳 Tarjeta', check:'📄 Cheque' };
  const paymentLabel = paymentLabels[paymentMethod] || paymentMethod || 'Confirmado';

  const itemsRows = items.map(item => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;">
        <div style="font-weight:700;color:#0f172a;font-size:14px;">${item.name}</div>
        ${item.sku ? `<div style="font-size:11px;color:#94a3b8;margin-top:3px;">SKU: ${item.sku}</div>` : ''}
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:center;color:#64748b;font-weight:700;font-size:14px;">x${item.quantity}</td>
      <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:900;color:#0f172a;font-size:14px;">$${Number(item.unit_price * item.quantity).toLocaleString('es-CO')}</td>
    </tr>
  `).join('');

  const sendSmtpEmail = new SendSmtpEmail();
  sendSmtpEmail.subject     = `🎉 ¡Pago confirmado! Tu pedido ${orderCode} está en camino - Alesteb`;
  sendSmtpEmail.to          = [{ email, name: userName }];
  sendSmtpEmail.sender      = SENDER;
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html><html lang="es">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background-color:#f0fdf4;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;padding:40px 16px;">
        <tr><td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td style="background:linear-gradient(135deg,#064e3b 0%,#065f46 60%,#047857 100%);padding:48px 40px;border-radius:20px 20px 0 0;text-align:center;">
                <div style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:50px;display:inline-block;padding:6px 20px;margin-bottom:20px;">
                  <span style="color:#a7f3d0;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;">Boutique Premium · 2026</span>
                </div>
                <div style="color:white;font-size:40px;font-weight:900;letter-spacing:-2px;text-transform:uppercase;margin:0;">ALESTEB</div>
                <div style="width:40px;height:3px;background:#34d399;margin:16px auto 24px;border-radius:2px;"></div>
                <div style="background:rgba(52,211,153,0.2);border:2px solid rgba(52,211,153,0.5);border-radius:50px;display:inline-block;padding:14px 36px;">
                  <span style="color:#6ee7b7;font-size:16px;font-weight:800;letter-spacing:1px;">✅ &nbsp;PAGO CONFIRMADO</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background:white;padding:48px 40px;">
                <p style="font-size:24px;color:#0f172a;font-weight:800;margin:0 0 12px;">¡Excelente noticia, ${userName}! 🎉</p>
                <p style="font-size:15px;color:#64748b;line-height:1.75;margin:0 0 36px;">
                  Tu pago fue <strong style="color:#059669;">verificado y aprobado</strong> por nuestro equipo.
                  Tu pedido está siendo preparado y pronto nos comunicaremos contigo para coordinar la entrega.
                  ¡Gracias por confiar en Alesteb!
                </p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:2px solid #86efac;border-radius:16px;margin-bottom:36px;">
                  <tr>
                    <td style="padding:22px 28px;">
                      <div style="font-size:11px;font-weight:700;color:#059669;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Código de pedido</div>
                      <div style="font-size:30px;font-weight:900;color:#064e3b;letter-spacing:2px;font-family:'Courier New',monospace;">${orderCode}</div>
                    </td>
                    <td style="padding:22px 28px;text-align:right;border-left:1px solid #86efac;">
                      <div style="font-size:11px;font-weight:700;color:#059669;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Estado</div>
                      <div style="background:#16a34a;color:white;font-size:13px;font-weight:800;padding:8px 18px;border-radius:50px;display:inline-block;">✅ Pagado</div>
                    </td>
                  </tr>
                </table>
                <div style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">Resumen del pedido</div>
                <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:36px;">
                  <thead><tr style="background:#f8fafc;">
                    <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Producto</th>
                    <th style="padding:10px 16px;text-align:center;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Cant.</th>
                    <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:1px;text-transform:uppercase;">Subtotal</th>
                  </tr></thead>
                  <tbody>${itemsRows}</tbody>
                  <tfoot><tr style="background:#064e3b;">
                    <td colspan="2" style="padding:16px 18px;color:rgba(255,255,255,0.6);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Total pagado</td>
                    <td style="padding:16px 18px;text-align:right;color:white;font-size:22px;font-weight:900;">$${Number(total).toLocaleString('es-CO')}</td>
                  </tr></tfoot>
                </table>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;margin-bottom:${shippingAddress ? '32px' : '36px'};">
                  <tr><td style="padding:20px 24px;">
                    <div style="font-size:11px;font-weight:800;color:#059669;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">Método de pago</div>
                    <div style="font-size:15px;font-weight:700;color:#065f46;">${paymentLabel}</div>
                  </td></tr>
                </table>
                ${shippingAddress ? `
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:14px;margin-bottom:36px;">
                  <tr><td style="padding:20px 24px;">
                    <div style="font-size:11px;font-weight:800;color:#1d4ed8;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Dirección de entrega</div>
                    <div style="font-weight:800;color:#1e3a8a;font-size:15px;margin-bottom:4px;">📍 ${shippingCity || ''}</div>
                    <div style="color:#1d4ed8;font-size:14px;line-height:1.6;">${shippingAddress}</div>
                    ${shippingNotes ? `<div style="color:#3b82f6;font-size:13px;margin-top:8px;font-style:italic;">📝 ${shippingNotes}</div>` : ''}
                  </td></tr>
                </table>` : ''}
                <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
                  <a href="https://wa.me/573145055073?text=Hola!%20Tengo%20una%20pregunta%20sobre%20mi%20pedido%20${orderCode}"
                     style="display:inline-block;background:#16a34a;color:white;text-decoration:none;font-size:14px;font-weight:800;padding:17px 40px;border-radius:50px;letter-spacing:0.5px;">
                    💬 &nbsp;Contactar por WhatsApp
                  </a>
                </td></tr></table>
              </td>
            </tr>
            <tr>
              <td style="background:#0f172a;padding:28px 40px;border-radius:0 0 20px 20px;text-align:center;">
                <div style="color:#475569;font-size:12px;">© 2026 Alesteb Boutique · Todos los derechos reservados</div>
                <div style="color:#334155;font-size:11px;margin-top:6px;">Este es un correo automático, por favor no respondas directamente.</div>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </body></html>
  `;

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Email pago confirmado enviado:', data.messageId);
    return true;
  } catch (error) {
    console.error('❌ Error al enviar email pago confirmado:', error);
    return false;
  }
};

// ============================================
// 🔍 VERIFICAR CONFIGURACIÓN AL INICIAR
// ============================================
const verifyEmailConfig = () => {
  if (!process.env.BREVO_API_KEY) {
    console.warn('⚠️  BREVO_API_KEY no configurada — emails desactivados');
    return false;
  }
  console.log('✅ Brevo lista — key:', `${process.env.BREVO_API_KEY.substring(0, 8)}...`);
  return true;
};

verifyEmailConfig();
// ============================================
// 📊 REPORTE DEL AGENTE IA — HTML branded
// ============================================
function markdownToHtml(md) {
  return md
    // Tablas markdown → <table>
    .replace(/^\|(.+)\|$/gm, (line) => {
      const cells = line.split("|").filter((_, i, a) => i > 0 && i < a.length - 1);
      return `<tr>${cells.map(c => `<td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#334155;">${c.trim()}</td>`).join("")}</tr>`;
    })
    .replace(/^\|[-| ]+\|$/gm, "") // eliminar fila separadora
    .replace(/(<tr>.*?<\/tr>)/gs, (match, _, offset, str) => {
      // Primera fila → thead
      const allRows = str.match(/<tr>.*?<\/tr>/gs) || [];
      if (allRows[0] === match) {
        const header = match.replace(/<td/g, '<td style="padding:10px 14px;background:#0f172a;color:white;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;"');
        return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin-bottom:20px;border-collapse:collapse;"><thead>${header}</thead><tbody>`;
      }
      return match;
    })
    .replace(/(<\/tr>)(?![\s\S]*<tr>)/, "$1</tbody></table>")
    // Encabezados
    .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:800;color:#0f172a;margin:24px 0 8px;">$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2 style="font-size:17px;font-weight:800;color:#0f172a;margin:28px 0 10px;border-left:4px solid #FF9900;padding-left:12px;">$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1 style="font-size:22px;font-weight:900;color:#0f172a;margin:0 0 20px;">$1</h1>')
    // Negrita
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0f172a;">$1</strong>')
    // Saltos de línea
    .replace(/\n\n/g, '</p><p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 12px;">')
    .replace(/\n/g, "<br>");
}

const sendAgentReportEmail = async (email, title, markdownContent) => {
  const { apiInstance, SendSmtpEmail } = getBrevoClient();
  const sendSmtpEmail = new SendSmtpEmail();

  const htmlBody = markdownToHtml(markdownContent);
  const dateStr  = new Date().toLocaleDateString("es-CO", { weekday:"long", day:"numeric", month:"long", year:"numeric" });

  sendSmtpEmail.subject     = `📊 ${title} — Alesteb ERP`;
  sendSmtpEmail.to          = [{ email, name: "Administrador" }];
  sendSmtpEmail.sender      = SENDER;
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html><html lang="es">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
        <tr><td align="center">
          <table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;">

            <!-- HEADER -->
            <tr>
              <td style="background:linear-gradient(135deg,#0A0A0A 0%,#1a0d00 100%);padding:40px;border-radius:20px 20px 0 0;text-align:center;">
                <div style="color:white;font-size:36px;font-weight:900;letter-spacing:-1px;text-transform:uppercase;margin:0;">ALESTEB</div>
                <div style="width:40px;height:3px;background:#FF9900;margin:12px auto 16px;border-radius:2px;"></div>
                <div style="background:rgba(255,153,0,0.15);border:1px solid rgba(255,153,0,0.4);border-radius:50px;display:inline-block;padding:8px 24px;">
                  <span style="color:#FF9900;font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;">📊 AGENTE IA — REPORTE</span>
                </div>
              </td>
            </tr>

            <!-- META -->
            <tr>
              <td style="background:#FF9900;padding:12px 40px;display:flex;justify-content:space-between;">
                <table width="100%"><tr>
                  <td style="font-size:12px;font-weight:800;color:#0A0A0A;">${title.toUpperCase()}</td>
                  <td style="font-size:12px;color:#0A0A0A;text-align:right;">${dateStr}</td>
                </tr></table>
              </td>
            </tr>

            <!-- BODY -->
            <tr>
              <td style="background:white;padding:40px;">
                <p style="font-size:14px;color:#475569;line-height:1.7;margin:0 0 24px;">
                  Tu agente IA completó el análisis solicitado. A continuación el reporte generado automáticamente.
                </p>
                <div style="border-left:4px solid #FF9900;padding-left:20px;margin-bottom:28px;">
                  ${htmlBody}
                </div>
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8ec;border:1px solid #fde68a;border-radius:12px;margin-top:32px;">
                  <tr><td style="padding:16px 20px;font-size:12px;color:#92400e;line-height:1.6;">
                    🤖 <strong>Generado por el Agente IA de ALESTEB</strong> — Este reporte fue creado automáticamente.
                    Los datos reflejan el estado de tu ERP al momento de la ejecución.
                  </td></tr>
                </table>
              </td>
            </tr>

            <!-- FOOTER -->
            <tr>
              <td style="background:#0A0A0A;padding:24px 40px;border-radius:0 0 20px 20px;text-align:center;">
                <div style="color:#555;font-size:11px;">© 2026 Alesteb ERP · Reporte automático del sistema</div>
              </td>
            </tr>

          </table>
        </td></tr>
      </table>
    </body></html>
  `;

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log("✅ Reporte IA enviado:", data.messageId);
    return true;
  } catch (err) {
    console.error("❌ Error enviando reporte IA:", err.message);
    return false;
  }
};

module.exports = {
  generateVerificationCode,
  sendVerificationEmail,
  sendOrderConfirmationEmail,
  sendPaymentConfirmedEmail,
  sendAgentReportEmail,
};
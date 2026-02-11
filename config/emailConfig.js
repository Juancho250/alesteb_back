// config/emailConfig.js
const SibApiV3Sdk = require('@getbrevo/brevo');

// ============================================
// 🔧 CONFIGURACIÓN CLIENTE BREVO
// ============================================
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
apiInstance.setApiKey(
  SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

const SENDER = {
  name:  "Alesteb Boutique",
  email: process.env.BREVO_SENDER_EMAIL || "web@alesteb.com",
};

// ============================================
// 🔐 CÓDIGO DE VERIFICACIÓN (existente)
// ============================================
const generateVerificationCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const sendVerificationEmail = async (email, code, userName) => {
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

  sendSmtpEmail.subject  = "🔐 Código de Verificación - Alesteb";
  sendSmtpEmail.to       = [{ email, name: userName || 'Usuario' }];
  sendSmtpEmail.sender   = SENDER;
  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Arial', sans-serif; background-color: #f5f5f7; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background: white; border-radius: 24px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 40px 30px; text-align: center; }
        .header h1 { color: white; font-size: 32px; font-weight: 900; margin: 0; letter-spacing: -1px; text-transform: uppercase; }
        .header p { color: #94a3b8; margin: 10px 0 0; font-size: 14px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; }
        .content { padding: 50px 40px; text-align: center; }
        .greeting { font-size: 18px; color: #475569; margin-bottom: 20px; font-weight: 600; }
        .message { font-size: 15px; color: #64748b; line-height: 1.6; margin-bottom: 30px; }
        .code-container { background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 16px; padding: 30px; margin: 30px 0; }
        .code { font-size: 48px; font-weight: 900; color: #0f172a; letter-spacing: 8px; font-family: 'Courier New', monospace; margin: 0; }
        .code-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px; font-weight: 700; margin-bottom: 10px; }
        .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px 20px; margin: 30px 0; border-radius: 8px; text-align: left; }
        .warning-text { font-size: 13px; color: #92400e; margin: 0; line-height: 1.5; }
        .footer { background: #f8fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0; }
        .footer-text { font-size: 12px; color: #94a3b8; margin: 5px 0; }
        .badge { display: inline-block; background: #3b82f6; color: white; padding: 6px 16px; border-radius: 20px; font-size: 11px; font-weight: 700; letter-spacing: 1px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>ALESTEB</h1>
          <p>Boutique Premium 2026</p>
        </div>
        <div class="content">
          <p class="greeting">¡Hola, ${userName || 'Usuario'}! 👋</p>
          <p class="message">
            Estás a un paso de unirte a nuestra comunidad exclusiva. 
            Para verificar tu cuenta, utiliza el siguiente código:
          </p>
          <div class="code-container">
            <p class="code-label">Tu Código de Verificación</p>
            <p class="code">${code}</p>
          </div>
          <div class="warning">
            <p class="warning-text">
              ⏱️ <strong>Este código expira en 10 minutos.</strong><br>
              🔒 No compartas este código con nadie.<br>
              ❌ Si no solicitaste este registro, ignora este mensaje.
            </p>
          </div>
          <div class="badge">CÓDIGO VÁLIDO POR 10 MINUTOS</div>
        </div>
        <div class="footer">
          <p class="footer-text">© 2026 Alesteb System - Auth Module</p>
          <p class="footer-text" style="margin-top: 15px;">Este es un email automático, por favor no respondas.</p>
        </div>
      </div>
    </body>
    </html>
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
// 📦 EMAIL DE CONFIRMACIÓN DE PEDIDO (NUEVO)
// ============================================

/**
 * Envía confirmación de pedido al cliente
 * @param {string} email         - correo del cliente
 * @param {string} userName      - nombre del cliente
 * @param {object} orderData     - { orderCode, total, items, shippingAddress, shippingCity, shippingNotes, paymentMethod }
 */
const sendOrderConfirmationEmail = async (email, userName, orderData) => {
  const {
    orderCode,
    total,
    items = [],
    shippingAddress,
    shippingCity,
    shippingNotes,
    paymentMethod,
  } = orderData;

  // Construir filas de productos
  const itemsRows = items.map(item => `
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid #f1f5f9;">
        <div style="font-weight: 700; color: #0f172a; font-size: 14px;">${item.name}</div>
        ${item.sku ? `<div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">SKU: ${item.sku}</div>` : ''}
      </td>
      <td style="padding: 12px 16px; border-bottom: 1px solid #f1f5f9; text-align: center; color: #475569; font-weight: 600; font-size: 14px;">
        ×${item.quantity}
      </td>
      <td style="padding: 12px 16px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 800; color: #0f172a; font-size: 14px;">
        $${Number(item.unit_price * item.quantity).toLocaleString('es-CO')}
      </td>
    </tr>
  `).join('');

  // Etiqueta de método de pago legible
  const paymentLabels = {
    transfer: 'Transferencia bancaria',
    cash:     'Efectivo',
    credit:   'Crédito',
    check:    'Cheque',
  };
  const paymentLabel = paymentLabels[paymentMethod] || paymentMethod || 'Por confirmar';

  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.subject = `✅ Pedido ${orderCode} confirmado - Alesteb`;
  sendSmtpEmail.to      = [{ email, name: userName }];
  sendSmtpEmail.sender  = SENDER;

  sendSmtpEmail.htmlContent = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Confirmación de Pedido</title>
    </head>
    <body style="margin:0; padding:0; background-color:#f1f5f9; font-family: 'Georgia', serif;">
      
      <!-- WRAPPER -->
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9; padding: 40px 16px;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%;">

              <!-- HEADER -->
              <tr>
                <td style="background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); padding: 48px 40px; border-radius: 20px 20px 0 0; text-align:center;">
                  <div style="display:inline-block; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 50px; padding: 6px 20px; margin-bottom: 20px;">
                    <span style="color: #93c5fd; font-size: 11px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; font-family: Arial, sans-serif;">Boutique Premium</span>
                  </div>
                  <div style="color: white; font-size: 38px; font-weight: 900; letter-spacing: -2px; margin: 0; text-transform: uppercase; font-family: Arial, sans-serif;">ALESTEB</div>
                  <div style="width: 40px; height: 3px; background: #3b82f6; margin: 16px auto 20px; border-radius: 2px;"></div>
                  <div style="background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.3); border-radius: 50px; display: inline-block; padding: 10px 28px;">
                    <span style="color: #86efac; font-size: 13px; font-weight: 700; font-family: Arial, sans-serif;">✓ &nbsp;PEDIDO RECIBIDO</span>
                  </div>
                </td>
              </tr>

              <!-- BODY -->
              <tr>
                <td style="background: white; padding: 40px;">

                  <!-- SALUDO -->
                  <p style="font-size: 22px; color: #0f172a; font-weight: 700; margin: 0 0 8px; font-family: Arial, sans-serif;">
                    ¡Hola, ${userName}! 👋
                  </p>
                  <p style="font-size: 15px; color: #64748b; line-height: 1.7; margin: 0 0 32px; font-family: Arial, sans-serif;">
                    Hemos recibido tu pedido exitosamente. A continuación encontrarás el resumen completo. 
                    Nuestro equipo lo revisará y se pondrá en contacto contigo pronto para coordinar el envío.
                  </p>

                  <!-- CÓDIGO DE ORDEN -->
                  <table width="100%" cellpadding="0" cellspacing="0" style="background: #f8fafc; border: 2px solid #e2e8f0; border-radius: 16px; margin-bottom: 32px;">
                    <tr>
                      <td style="padding: 20px 24px;">
                        <div style="font-size: 11px; font-weight: 700; color: #94a3b8; letter-spacing: 2px; text-transform: uppercase; font-family: Arial, sans-serif; margin-bottom: 6px;">Código de pedido</div>
                        <div style="font-size: 28px; font-weight: 900; color: #0f172a; letter-spacing: 1px; font-family: 'Courier New', monospace;">${orderCode}</div>
                      </td>
                      <td style="padding: 20px 24px; text-align: right; border-left: 1px solid #e2e8f0;">
                        <div style="font-size: 11px; font-weight: 700; color: #94a3b8; letter-spacing: 2px; text-transform: uppercase; font-family: Arial, sans-serif; margin-bottom: 6px;">Fecha</div>
                        <div style="font-size: 15px; font-weight: 700; color: #475569; font-family: Arial, sans-serif;">
                          ${new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })}
                        </div>
                      </td>
                    </tr>
                  </table>

                  <!-- PRODUCTOS -->
                  <div style="font-size: 11px; font-weight: 800; color: #94a3b8; letter-spacing: 2px; text-transform: uppercase; font-family: Arial, sans-serif; margin-bottom: 12px;">
                    Productos
                  </div>
                  <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; margin-bottom: 32px;">
                    <thead>
                      <tr style="background: #f8fafc;">
                        <th style="padding: 10px 16px; text-align:left; font-size:11px; font-weight:800; color:#94a3b8; letter-spacing:1px; text-transform:uppercase; font-family:Arial,sans-serif;">Producto</th>
                        <th style="padding: 10px 16px; text-align:center; font-size:11px; font-weight:800; color:#94a3b8; letter-spacing:1px; text-transform:uppercase; font-family:Arial,sans-serif;">Cant.</th>
                        <th style="padding: 10px 16px; text-align:right; font-size:11px; font-weight:800; color:#94a3b8; letter-spacing:1px; text-transform:uppercase; font-family:Arial,sans-serif;">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${itemsRows}
                    </tbody>
                    <tfoot>
                      <tr style="background: #0f172a;">
                        <td colspan="2" style="padding: 16px 16px; color: rgba(255,255,255,0.7); font-size: 13px; font-weight: 700; font-family: Arial, sans-serif; text-transform: uppercase; letter-spacing: 1px;">
                          Total del Pedido
                        </td>
                        <td style="padding: 16px 16px; text-align: right; color: white; font-size: 22px; font-weight: 900; font-family: Arial, sans-serif;">
                          $${Number(total).toLocaleString('es-CO')}
                        </td>
                      </tr>
                    </tfoot>
                  </table>

                  <!-- DIRECCIÓN DE ENVÍO -->
                  ${shippingAddress ? `
                  <div style="font-size: 11px; font-weight: 800; color: #94a3b8; letter-spacing: 2px; text-transform: uppercase; font-family: Arial, sans-serif; margin-bottom: 12px;">
                    Datos de envío
                  </div>
                  <table width="100%" cellpadding="0" cellspacing="0" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; margin-bottom: 32px;">
                    <tr>
                      <td style="padding: 20px 24px;">
                        <div style="display:flex; gap:12px; align-items:flex-start;">
                          <span style="font-size: 20px;">📍</span>
                          <div>
                            <div style="font-weight: 800; color: #14532d; font-size: 15px; font-family: Arial, sans-serif; margin-bottom: 4px;">
                              ${shippingCity || ''}
                            </div>
                            <div style="color: #166534; font-size: 14px; font-family: Arial, sans-serif; line-height: 1.5;">
                              ${shippingAddress}
                            </div>
                            ${shippingNotes ? `
                            <div style="color: #15803d; font-size: 12px; font-family: Arial, sans-serif; margin-top: 6px; font-style: italic;">
                              Nota: ${shippingNotes}
                            </div>` : ''}
                          </div>
                        </div>
                      </td>
                    </tr>
                  </table>
                  ` : ''}

                  <!-- MÉTODO DE PAGO -->
                  <table width="100%" cellpadding="0" cellspacing="0" style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; margin-bottom: 32px;">
                    <tr>
                      <td style="padding: 18px 24px;">
                        <div style="font-size: 11px; font-weight: 800; color: #92400e; letter-spacing: 2px; text-transform: uppercase; font-family: Arial, sans-serif; margin-bottom: 6px;">
                          Método de pago
                        </div>
                        <div style="font-size: 15px; font-weight: 700; color: #78350f; font-family: Arial, sans-serif;">
                          💳 &nbsp;${paymentLabel}
                        </div>
                        <div style="font-size: 12px; color: #92400e; font-family: Arial, sans-serif; margin-top: 8px; line-height: 1.5;">
                          Tu pedido quedará confirmado una vez verifiquemos tu pago. 
                          Contáctanos por WhatsApp con el código <strong>${orderCode}</strong> para agilizar el proceso.
                        </div>
                      </td>
                    </tr>
                  </table>

                  <!-- CTA WHATSAPP -->
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="center" style="padding-bottom: 8px;">
                        <a href="https://wa.me/573145055073?text=Hola!%20Quiero%20confirmar%20mi%20pedido%20${orderCode}"
                           style="display:inline-block; background: #16a34a; color: white; text-decoration: none; font-size: 14px; font-weight: 800; padding: 16px 36px; border-radius: 50px; letter-spacing: 0.5px; font-family: Arial, sans-serif;">
                          💬 &nbsp;Confirmar por WhatsApp
                        </a>
                      </td>
                    </tr>
                  </table>

                </td>
              </tr>

              <!-- FOOTER -->
              <tr>
                <td style="background: #0f172a; padding: 28px 40px; border-radius: 0 0 20px 20px; text-align: center;">
                  <div style="color: #94a3b8; font-size: 12px; font-family: Arial, sans-serif; margin-bottom: 8px;">
                    © 2026 Alesteb Boutique · Todos los derechos reservados
                  </div>
                  <div style="color: #475569; font-size: 11px; font-family: Arial, sans-serif;">
                    Este es un correo automático, por favor no respondas directamente.
                  </div>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>

    </body>
    </html>
  `;

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Email confirmación pedido enviado:', data.messageId);
    return true;
  } catch (error) {
    console.error('❌ Error al enviar email de confirmación:', error);
    // No lanzamos error — el pedido ya fue creado; el email es best-effort
    return false;
  }
};

// ============================================
// 🔍 VERIFICAR CONFIGURACIÓN AL INICIAR
// ============================================
const verifyEmailConfig = () => {
  if (!process.env.BREVO_API_KEY) {
    console.error('❌ BREVO_API_KEY no configurada en .env');
    return false;
  }
  console.log('✅ Configuración de Brevo lista');
  return true;
};

verifyEmailConfig();

module.exports = {
  generateVerificationCode,
  sendVerificationEmail,
  sendOrderConfirmationEmail,   // ← NUEVO
};
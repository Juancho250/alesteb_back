// config/emailConfig.js
const SibApiV3Sdk = require('@getbrevo/brevo');

// Configurar cliente de Brevo
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
apiInstance.setApiKey(
  SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

// Generar código de verificación de 6 dígitos
const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Enviar email de verificación
const sendVerificationEmail = async (email, code, userName) => {
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

  sendSmtpEmail.subject = "🔐 Código de Verificación - Alesteb";
  sendSmtpEmail.to = [{ email, name: userName || 'Usuario' }];
  sendSmtpEmail.sender = { 
    name: "Alesteb Boutique", 
    email: process.env.BREVO_SENDER_EMAIL || "noreply@alesteb.com" 
  };
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
          <p class="footer-text" style="margin-top: 15px;">
            Este es un email automático, por favor no respondas.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Email enviado exitosamente:', data.messageId);
    return true;
  } catch (error) {
    console.error('❌ Error al enviar email:', error);
    throw new Error('No se pudo enviar el código de verificación');
  }
};

// Verificar configuración al iniciar
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
  sendVerificationEmail
};
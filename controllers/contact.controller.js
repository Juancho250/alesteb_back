const { Resend } = require('resend');
const db = require("../config/db");
const { z } = require("zod");

const resend = new Resend(process.env.RESEND_API_KEY);

// ===============================
// ESQUEMA DE VALIDACIÓN
// ===============================

const contactSchema = z.object({
  name: z.string()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .max(100, "El nombre no puede exceder 100 caracteres")
    .trim(),
  email: z.string()
    .email("Email inválido")
    .max(255, "Email demasiado largo")
    .trim()
    .toLowerCase(),
  subject: z.string()
    .min(5, "El asunto debe tener al menos 5 caracteres")
    .max(200, "El asunto no puede exceder 200 caracteres")
    .trim(),
  message: z.string()
    .min(10, "El mensaje debe tener al menos 10 caracteres")
    .max(2000, "El mensaje no puede exceder 2000 caracteres")
    .trim(),
  phone: z.string()
    .regex(/^\+?[\d\s\-()]+$/, "Número de teléfono inválido")
    .min(7, "Número de teléfono demasiado corto")
    .max(20, "Número de teléfono demasiado largo")
    .optional()
    .or(z.literal(""))
});

// ===============================
// CONTROLADOR
// ===============================

const submitContact = async (req, res) => {
  try {
    // Validar datos
    const validatedData = contactSchema.parse(req.body);

    // 1. Guardar en base de datos
    const query = `
      INSERT INTO contact_messages (name, email, subject, message, phone, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW()) 
      RETURNING *
    `;
    
    const result = await db.query(query, [
      validatedData.name,
      validatedData.email,
      validatedData.subject,
      validatedData.message,
      validatedData.phone || null
    ]);

    // 2. Enviar correo de notificación
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'ALESTEB Store <onboarding@resend.dev>',
        to: [process.env.CONTACT_EMAIL || 'softturin@gmail.com'],
        subject: `Nuevo Contacto: ${validatedData.subject}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f9f9f9; border-radius: 10px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0;">Nuevo Mensaje de Contacto</h1>
            </div>
            
            <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px;">
              <h2 style="color: #333; margin-bottom: 20px;">Información del Contacto</h2>
              
              <div style="margin-bottom: 15px;">
                <strong style="color: #667eea;">Nombre:</strong>
                <p style="margin: 5px 0; color: #666;">${validatedData.name}</p>
              </div>
              
              <div style="margin-bottom: 15px;">
                <strong style="color: #667eea;">Email:</strong>
                <p style="margin: 5px 0; color: #666;">${validatedData.email}</p>
              </div>
              
              ${validatedData.phone ? `
                <div style="margin-bottom: 15px;">
                  <strong style="color: #667eea;">Teléfono:</strong>
                  <p style="margin: 5px 0; color: #666;">${validatedData.phone}</p>
                </div>
              ` : ''}
              
              <div style="margin-bottom: 15px;">
                <strong style="color: #667eea;">Asunto:</strong>
                <p style="margin: 5px 0; color: #666;">${validatedData.subject}</p>
              </div>
              
              <div style="margin-bottom: 15px;">
                <strong style="color: #667eea;">Mensaje:</strong>
                <div style="background: #f9f9f9; padding: 15px; border-left: 4px solid #667eea; border-radius: 5px; margin-top: 10px;">
                  <p style="margin: 0; color: #333; white-space: pre-wrap;">${validatedData.message}</p>
                </div>
              </div>
              
              <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee;">
                <p style="font-size: 12px; color: #999; margin: 0;">
                  Mensaje recibido el ${new Date().toLocaleString('es-ES')}
                </p>
              </div>
            </div>
          </div>
        `
      });
    } catch (mailError) {
      // Log del error pero no fallar la request
      console.error("ERROR ENVIANDO EMAIL DE CONTACTO:", {
        message: mailError.message,
        contactEmail: validatedData.email
      });
      // El mensaje se guardó en la DB, así que la operación fue exitosa
    }

    // 3. Enviar correo de confirmación al usuario (opcional)
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'ALESTEB Store <onboarding@resend.dev>',
        to: [validatedData.email],
        subject: 'Hemos recibido tu mensaje - ALESTEB',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #667eea;">¡Gracias por contactarnos!</h2>
            
            <p style="color: #666; line-height: 1.6;">
              Hola <strong>${validatedData.name}</strong>,
            </p>
            
            <p style="color: #666; line-height: 1.6;">
              Hemos recibido tu mensaje y uno de nuestros representantes se pondrá en contacto contigo pronto.
            </p>
            
            <div style="background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p style="margin: 0; color: #999; font-size: 14px;">
                <strong>Tu mensaje:</strong>
              </p>
              <p style="margin: 10px 0 0 0; color: #333;">
                ${validatedData.message}
              </p>
            </div>
            
            <p style="color: #666; line-height: 1.6;">
              Saludos,<br>
              El equipo de ALESTEB
            </p>
          </div>
        `
      });
    } catch (confirmError) {
      console.error("ERROR ENVIANDO EMAIL DE CONFIRMACIÓN:", confirmError);
    }

    res.status(201).json({ 
      success: true, 
      message: "Mensaje enviado con éxito. Te contactaremos pronto.",
      data: {
        id: result.rows[0].id,
        created_at: result.rows[0].created_at
      }
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: "Datos de entrada inválidos",
        errors: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }

    console.error("ERROR EN CONTACTO:", {
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    res.status(500).json({ 
      success: false,
      message: "Error al procesar el mensaje. Por favor intenta nuevamente." 
    });
  }
};

module.exports = { submitContact };
import { Resend } from 'resend';
// Cambiamos require por import para ser consistentes con tus otros controladores
import db from "../config/db.js"; 

const resend = new Resend(process.env.RESEND_API_KEY);

export const submitContact = async (req, res) => {
  const { name, email, subject, message, phone } = req.body;

  try {
    // 1. Guardar en la base de datos (Neon)
    const query = `
      INSERT INTO contact_messages (name, email, subject, message, phone, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *
    `;
    
    // IMPORTANTE: Asegúrate de usar la variable 'db' que importaste arriba
    const result = await db.query(query, [name, email, subject, message, phone]);

    // 2. Enviar correo vía Resend
    await resend.emails.send({
      from: 'ALESTEB Store <onboarding@resend.dev>',
      to: ['softturin@gmail.com'], 
      subject: `Nuevo Registro: ${subject}`,
      html: `
        <div style="font-family: sans-serif; color: #1d1d1f; max-width: 600px; margin: auto; border: 1px solid #f0f0f0; padding: 40px; border-radius: 24px;">
          <p style="font-size: 10px; font-weight: 900; letter-spacing: 2px; color: #2563eb; text-transform: uppercase;">Notificación de Registro</p>
          <h1 style="font-size: 32px; font-weight: 900; font-style: italic; letter-spacing: -1px; margin-bottom: 20px;">NUEVO MENSAJE</h1>
          <div style="background: #f5f5f7; padding: 25px; border-radius: 20px; margin-bottom: 20px;">
            <p style="margin: 5px 0;"><strong>Usuario:</strong> ${name}</p>
            <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 5px 0;"><strong>Tel:</strong> ${phone || 'N/A'}</p>
          </div>
          <p style="font-size: 12px; font-weight: 800; text-transform: uppercase; color: #86868b;">Mensaje:</p>
          <p style="line-height: 1.6; color: #424245;">${message}</p>
        </div>
      `
    });

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Error en contacto:", error);
    res.status(500).json({ error: "Error al procesar el registro" });
  }
};
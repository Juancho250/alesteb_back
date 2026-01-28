import { Resend } from 'resend';
// Asumo que tienes una pool de conexión configurada para Neon
import { pool } from '../config/db.js'; 

const resend = new Resend(process.env.RESEND_API_KEY);

export const submitContact = async (req, res) => {
  const { name, email, subject, message, phone } = req.body;

  try {
    // 1. Guardar en la base de datos (Neon)
    const query = `
      INSERT INTO contact_messages (name, email, subject, message, phone, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *
    `;
    const result = await pool.query(query, [name, email, subject, message, phone]);

    // 2. Enviar correo vía Resend
    await resend.emails.send({
      from: 'ALESTEB Store <onboarding@resend.dev>', // Luego configuras tu dominio
      to: ['softturin@gmail.com'], // Donde quieres recibir las notificaciones
      subject: `Nuevo Registro de Contacto: ${subject}`,
      html: `
        <div style="font-family: sans-serif; color: #1d1d1f;">
          <h1 style="font-size: 24px; font-weight: 900 italic;">NUEVO MENSAJE RECIBIDO</h1>
          <hr />
          <p><strong>Nombre:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Teléfono:</strong> ${phone || 'No provisto'}</p>
          <p><strong>Asunto:</strong> ${subject}</p>
          <p><strong>Mensaje:</strong></p>
          <div style="background: #f5f5f7; padding: 20px; border-radius: 12px;">${message}</div>
        </div>
      `
    });

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Error en contacto:", error);
    res.status(500).json({ error: "Error al procesar el registro" });
  }
};
const { Resend } = require('resend');
const db = require("../config/db"); // Usando require como el resto de tu app

const resend = new Resend(process.env.RESEND_API_KEY);

const submitContact = async (req, res) => {
  const { name, email, subject, message, phone } = req.body;

  try {
    // 1. Guardar en Neon
    const query = `
      INSERT INTO contact_messages (name, email, subject, message, phone, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *
    `;
    
    const result = await db.query(query, [name, email, subject, message, phone]);

    // 2. Enviar correo
    await resend.emails.send({
      from: 'ALESTEB Store <onboarding@resend.dev>',
      to: ['softturin@gmail.com'], 
      subject: `Nuevo Registro: ${subject}`,
      html: `<h1>Nuevo mensaje de ${name}</h1><p>${message}</p>`
    });

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error("Error en contacto:", error);
    res.status(500).json({ error: "Error al procesar el registro" });
  }
};

module.exports = { submitContact }; // Cambiado a module.exports
const pool       = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { Readable } = require('stream');

/* ─────────────────────────────────────────────
   Helper: buffer → stream para Cloudinary
───────────────────────────────────────────── */
const bufferToStream = (buffer) => {
  const readable = new Readable();
  readable.push(buffer);
  readable.push(null);
  return readable;
};

/* ─────────────────────────────────────────────
   GET /api/admin-profile
───────────────────────────────────────────── */
const getAdminProfile = async (req, res) => {
  try {
    const { id } = req.user;

    const { rows } = await pool.query(
      `SELECT ap.*, u.name AS user_name, u.email AS user_email
       FROM   admin_profiles ap
       RIGHT  JOIN users u ON u.id = $1
       LEFT   JOIN admin_profiles ap2 ON ap2.user_id = u.id
       WHERE  u.id = $1`,
      [id]
    );

    // Consulta limpia: solo el perfil si existe
    const profileResult = await pool.query(
      'SELECT * FROM admin_profiles WHERE user_id = $1',
      [id]
    );

    res.json({
      success: true,
      data: profileResult.rows[0] ?? null,
    });
  } catch (error) {
    console.error('getAdminProfile error:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el perfil' });
  }
};

/* ─────────────────────────────────────────────
   PUT /api/admin-profile
───────────────────────────────────────────── */
const upsertAdminProfile = async (req, res) => {
  try {
    const { id } = req.user;

    const {
      business_name,
      tagline,
      description,
      tax_id,
      primary_color,
      secondary_color,
      accent_color,
      business_email,
      business_phone,
      website,
      address,
      city,
      department,
      country,
      currency,
      timezone,
      social_links,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO admin_profiles (
         user_id, business_name, tagline, description, tax_id,
         primary_color, secondary_color, accent_color,
         business_email, business_phone, website,
         address, city, department, country,
         currency, timezone, social_links,
         updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (user_id)
       DO UPDATE SET
         business_name    = EXCLUDED.business_name,
         tagline          = EXCLUDED.tagline,
         description      = EXCLUDED.description,
         tax_id           = EXCLUDED.tax_id,
         primary_color    = EXCLUDED.primary_color,
         secondary_color  = EXCLUDED.secondary_color,
         accent_color     = EXCLUDED.accent_color,
         business_email   = EXCLUDED.business_email,
         business_phone   = EXCLUDED.business_phone,
         website          = EXCLUDED.website,
         address          = EXCLUDED.address,
         city             = EXCLUDED.city,
         department       = EXCLUDED.department,
         country          = EXCLUDED.country,
         currency         = EXCLUDED.currency,
         timezone         = EXCLUDED.timezone,
         social_links     = EXCLUDED.social_links,
         updated_at       = now()
       RETURNING *`,
      [
        id,
        business_name   ?? null,
        tagline         ?? null,
        description     ?? null,
        tax_id          ?? null,
        primary_color   ?? '#3B82F6',
        secondary_color ?? '#1E40AF',
        accent_color    ?? '#F59E0B',
        business_email  ?? null,
        business_phone  ?? null,
        website         ?? null,
        address         ?? null,
        city            ?? null,
        department      ?? null,
        country         ?? 'Colombia',
        currency        ?? 'COP',
        timezone        ?? 'America/Bogota',
        social_links ? JSON.stringify(social_links) : '{}',
      ]
    );

    res.json({ success: true, data: rows[0], message: 'Perfil actualizado correctamente' });
  } catch (error) {
    console.error('upsertAdminProfile error:', error);
    res.status(500).json({ success: false, message: 'Error al guardar el perfil' });
  }
};

/* ─────────────────────────────────────────────
   POST /api/admin-profile/logo
───────────────────────────────────────────── */
const uploadLogo = async (req, res) => {
  try {
    const { id } = req.user;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se recibió ningún archivo' });
    }

    // Obtener el public_id anterior para borrarlo de Cloudinary
    const existing = await pool.query(
      'SELECT logo_public_id FROM admin_profiles WHERE user_id = $1',
      [id]
    );

    if (existing.rows[0]?.logo_public_id) {
      await cloudinary.uploader.destroy(existing.rows[0].logo_public_id).catch(() => {});
    }

    // Subir nuevo logo
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder:    `admin_logos/${id}`,
          public_id: `logo_${id}_${Date.now()}`,
          overwrite: true,
          resource_type: 'image',
          transformation: [
            { width: 400, height: 400, crop: 'limit' }, // Max 400px, sin distorsionar
            { quality: 'auto:best' },
            { format: 'webp' },
          ],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );

      bufferToStream(req.file.buffer).pipe(uploadStream);
    });

    // Upsert con el nuevo logo
    const { rows } = await pool.query(
      `INSERT INTO admin_profiles (user_id, logo_url, logo_public_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id)
       DO UPDATE SET
         logo_url       = EXCLUDED.logo_url,
         logo_public_id = EXCLUDED.logo_public_id,
         updated_at     = now()
       RETURNING logo_url, logo_public_id`,
      [id, uploadResult.secure_url, uploadResult.public_id]
    );

    res.json({
      success: true,
      data: rows[0],
      message: 'Logo actualizado correctamente',
    });
  } catch (error) {
    console.error('uploadLogo error:', error);
    res.status(500).json({ success: false, message: 'Error al subir el logo' });
  }
};

/* ─────────────────────────────────────────────
   DELETE /api/admin-profile/logo
───────────────────────────────────────────── */
const deleteLogo = async (req, res) => {
  try {
    const { id } = req.user;

    const { rows } = await pool.query(
      'SELECT logo_public_id FROM admin_profiles WHERE user_id = $1',
      [id]
    );

    if (rows[0]?.logo_public_id) {
      await cloudinary.uploader.destroy(rows[0].logo_public_id).catch(() => {});
    }

    await pool.query(
      `UPDATE admin_profiles
       SET logo_url = NULL, logo_public_id = NULL, updated_at = now()
       WHERE user_id = $1`,
      [id]
    );

    res.json({ success: true, message: 'Logo eliminado' });
  } catch (error) {
    console.error('deleteLogo error:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el logo' });
  }
};

module.exports = { getAdminProfile, upsertAdminProfile, uploadLogo, deleteLogo };
const pool       = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { Readable } = require('stream');
const { invalidateBrandingCache } = require('../services/branding.service');

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

    // ❌ Elimina esto — resultado nunca usado
    // const { rows } = await pool.query(`SELECT ap.*, ...`, [id]);

    // ✅ Solo esta query importa
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

    const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
    if (req.body.store_navbar_bg  && !HEX_RE.test(req.body.store_navbar_bg))
      return res.status(400).json({ success: false, message: 'store_navbar_bg debe ser un color hexadecimal válido (#RRGGBB)' });
    if (req.body.store_page_bg    && !HEX_RE.test(req.body.store_page_bg))
      return res.status(400).json({ success: false, message: 'store_page_bg debe ser un color hexadecimal válido (#RRGGBB)' });
    if (req.body.store_navbar_text && !['light', 'dark'].includes(req.body.store_navbar_text))
      return res.status(400).json({ success: false, message: 'store_navbar_text debe ser "light" o "dark"' });

    // Ensure the row exists; DB column defaults apply on first creation
    await pool.query(
      `INSERT INTO admin_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [id]
    );

    // Whitelist of updatable fields — only columns present in req.body are touched
    const ALLOWED = {
      business_name:     v => v,
      tagline:           v => v,
      description:       v => v,
      tax_id:            v => v,
      primary_color:     v => v,
      secondary_color:   v => v,
      accent_color:      v => v,
      business_email:    v => v,
      business_phone:    v => v,
      website:           v => v,
      address:           v => v,
      city:              v => v,
      department:        v => v,
      country:           v => v,
      currency:          v => v,
      timezone:          v => v,
      social_links:      v => v != null ? JSON.stringify(v) : null,
      store_navbar_bg:   v => v,
      store_navbar_text: v => v,
      store_page_bg:     v => v,
      store_font:        v => v,
    };

    const setCols = [];
    const vals    = [id]; // $1 → user_id in WHERE

    for (const [col, transform] of Object.entries(ALLOWED)) {
      if (col in req.body) {
        setCols.push(`${col} = $${vals.length + 1}`);
        vals.push(transform(req.body[col]));
      }
    }

    if (setCols.length === 0) {
      const { rows: cur } = await pool.query('SELECT * FROM admin_profiles WHERE user_id = $1', [id]);
      return res.json({ success: true, data: cur[0] ?? null, message: 'Sin cambios' });
    }

    setCols.push('updated_at = now()');

    const { rows } = await pool.query(
      `UPDATE admin_profiles SET ${setCols.join(', ')} WHERE user_id = $1 RETURNING *`,
      vals
    );

    invalidateBrandingCache(id);
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
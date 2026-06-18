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
      store_navbar_bg,
      store_navbar_text,
      store_page_bg,
      store_font,
    } = req.body;

    const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
    if (store_navbar_bg  && !HEX_RE.test(store_navbar_bg))
      return res.status(400).json({ success: false, message: 'store_navbar_bg debe ser un color hexadecimal válido (#RRGGBB)' });
    if (store_page_bg    && !HEX_RE.test(store_page_bg))
      return res.status(400).json({ success: false, message: 'store_page_bg debe ser un color hexadecimal válido (#RRGGBB)' });
    if (store_navbar_text && !['light', 'dark'].includes(store_navbar_text))
      return res.status(400).json({ success: false, message: 'store_navbar_text debe ser "light" o "dark"' });

    const { rows } = await pool.query(
      `INSERT INTO admin_profiles (
         user_id, business_name, tagline, description, tax_id,
         primary_color, secondary_color, accent_color,
         business_email, business_phone, website,
         address, city, department, country,
         currency, timezone, social_links,
         store_navbar_bg, store_navbar_text, store_page_bg, store_font,
         updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
       ON CONFLICT (user_id)
       DO UPDATE SET
         business_name    = COALESCE(EXCLUDED.business_name, admin_profiles.business_name),
         tagline          = COALESCE(EXCLUDED.tagline, admin_profiles.tagline),
         description      = COALESCE(EXCLUDED.description, admin_profiles.description),
         tax_id           = COALESCE(EXCLUDED.tax_id, admin_profiles.tax_id),
         primary_color    = COALESCE(EXCLUDED.primary_color, admin_profiles.primary_color),
         secondary_color  = COALESCE(EXCLUDED.secondary_color, admin_profiles.secondary_color),
         accent_color     = COALESCE(EXCLUDED.accent_color, admin_profiles.accent_color),
         business_email   = COALESCE(EXCLUDED.business_email, admin_profiles.business_email),
         business_phone   = COALESCE(EXCLUDED.business_phone, admin_profiles.business_phone),
         website          = COALESCE(EXCLUDED.website, admin_profiles.website),
         address          = COALESCE(EXCLUDED.address, admin_profiles.address),
         city             = COALESCE(EXCLUDED.city, admin_profiles.city),
         department       = COALESCE(EXCLUDED.department, admin_profiles.department),
         country          = COALESCE(EXCLUDED.country, admin_profiles.country),
         currency         = COALESCE(EXCLUDED.currency, admin_profiles.currency),
         timezone         = COALESCE(EXCLUDED.timezone, admin_profiles.timezone),
         social_links      = COALESCE(EXCLUDED.social_links, admin_profiles.social_links),
         store_navbar_bg   = COALESCE(EXCLUDED.store_navbar_bg, admin_profiles.store_navbar_bg),
         store_navbar_text = COALESCE(EXCLUDED.store_navbar_text, admin_profiles.store_navbar_text),
         store_page_bg     = COALESCE(EXCLUDED.store_page_bg, admin_profiles.store_page_bg),
         store_font        = COALESCE(EXCLUDED.store_font, admin_profiles.store_font),
         updated_at        = now()
       RETURNING *`,
      [
        id,
        business_name   ?? null,
        tagline         ?? null,
        description     ?? null,
        tax_id          ?? null,
        primary_color   ?? null,
        secondary_color ?? null,
        accent_color    ?? null,
        business_email  ?? null,
        business_phone  ?? null,
        website         ?? null,
        address         ?? null,
        city            ?? null,
        department      ?? null,
        country         ?? null,
        currency        ?? null,
        timezone        ?? null,
        social_links != null ? JSON.stringify(social_links) : null,
        store_navbar_bg   ?? null,
        store_navbar_text ?? null,
        store_page_bg     ?? null,
        store_font        ?? null,
      ]
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
"use strict";

const db = require("../../platform/database");

async function getProfile(req, res) {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT
         ap.business_name, ap.tagline, ap.description,
         ap.logo_url, ap.favicon_url,
         ap.primary_color, ap.secondary_color, ap.accent_color,
         ap.business_email, ap.business_phone, ap.website,
         ap.address, ap.city, ap.department, ap.country,
         ap.currency, ap.social_links,
         ap.store_navbar_bg, ap.store_navbar_text, ap.store_page_bg, ap.store_font
       FROM admin_profiles ap
       WHERE ap.user_id = $1`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows[0] ?? null });
  } catch (error) {
    console.error("[PUBLIC API] GET /profile", error);
    res.status(500).json({ success: false, message: "Error al obtener el perfil del negocio" });
  }
}

function registerProfileRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function"
  ) {
    throw new TypeError(
      "registerProfileRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/profile",
    getProfile
  );
}

module.exports = Object.freeze({
  registerProfileRoutes,
  getProfile,
});


"use strict";

const db = require("../../platform/database");

async function getBanners(req, res) {
  try {
    const adminId = req.apiKey.adminId;

    const result = await db.query(
      `SELECT id, title, description, image_url, button_text, button_link, display_order, is_active
       FROM banners
       WHERE is_active = true
         AND created_by = $1
       ORDER BY display_order ASC`,
      [adminId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PUBLIC API] GET /banners", error);
    res.status(500).json({ success: false, message: "Error al obtener banners" });
  }
}

function registerBannerRoutes(router) {
  if (
    !router ||
    typeof router.get !== "function"
  ) {
    throw new TypeError(
      "registerBannerRoutes requiere un router Express válido"
    );
  }

  router.get(
    "/banners",
    getBanners
  );
}

module.exports = Object.freeze({
  registerBannerRoutes,
  getBanners,
});


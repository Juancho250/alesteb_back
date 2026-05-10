// controllers/banners.controller.js
const db = require("../config/db");
const { emitDataUpdate } = require("../config/socket");

// Cache para la ruta pública del storefront
const CACHE_CONTROL_PUBLIC =
  "public, max-age=60, s-maxage=120, stale-while-revalidate=300";

const bannerController = {

  // ── GET /banners — público (storefront) ──────────────────────────────────
  // Devuelve TODOS los banners activos (sin filtro de tenant).
  // Si en el futuro quieres banners por admin, agrega owner_admin_id a la tabla.
  getAll: async (req, res) => {
    try {
      const result = await db.query(`
        SELECT id, title, description, image_url, button_text, button_link,
               is_active, display_order, created_at, updated_at
        FROM banners
        WHERE is_active = true
        ORDER BY display_order ASC, id DESC
      `);

      res.set("Cache-Control", CACHE_CONTROL_PUBLIC);
      res.set("Vary", "Accept-Encoding");
      res.json(result.rows);
    } catch (error) {
      console.error("[GET BANNERS ERROR]", error.message);
      res.status(500).json({ success: false, error: "Error al obtener banners" });
    }
  },

  // ── GET /banners/admin — panel admin (todos, sin caché) ──────────────────
  // Permite al admin ver sus propios banners por created_by.
  // El superadmin ve todos.
  getAllAdmin: async (req, res) => {
    try {
      const isSuperAdmin = req.user?.roles?.includes("superadmin");
      const tenantClause = isSuperAdmin ? "" : "AND created_by = $1";
      const params       = isSuperAdmin ? [] : [req.user.id];

      const result = await db.query(`
        SELECT b.id, b.title, b.description, b.image_url, b.button_text,
               b.button_link, b.is_active, b.display_order,
               b.created_at, b.updated_at, b.created_by,
               u.name AS created_by_name
        FROM banners b
        LEFT JOIN users u ON u.id = b.created_by
        WHERE 1=1 ${tenantClause}
        ORDER BY b.display_order ASC, b.id DESC
      `, params);

      res.json({ success: true, data: result.rows });
    } catch (error) {
      console.error("[GET BANNERS ADMIN ERROR]", error.message);
      res.status(500).json({ success: false, error: "Error al obtener banners" });
    }
  },

  // ── POST /banners ─────────────────────────────────────────────────────────
  create: async (req, res) => {
    // ✅ FIX: eliminado 'label' que no existe en la tabla
    const { title, description, button_text, button_link, display_order } = req.body;
    const image_url = req.file ? req.file.path : "";

    if (!title?.trim()) {
      return res.status(400).json({ success: false, error: "El título es requerido" });
    }
    if (!image_url) {
      return res.status(400).json({ success: false, error: "La imagen es requerida" });
    }

    try {
      const result = await db.query(
        `INSERT INTO banners
           (title, description, image_url, button_text, button_link, display_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          title.trim(),
          description?.trim() || null,
          image_url,
          button_text?.trim() || "Ver más",
          button_link?.trim() || "/productos",
          display_order ? parseInt(display_order) : 0,
          req.user.id,   // ✅ created_by
        ]
      );

      const newBanner = result.rows[0];
      emitDataUpdate("banners", "created", newBanner);

      res.status(201).json({
        success: true,
        id: newBanner.id,
        message: "Banner creado con éxito",
        data: newBanner,
      });
    } catch (error) {
      console.error("[CREATE BANNER ERROR]", error.message);
      res.status(500).json({ success: false, error: "Error al crear banner" });
    }
  },

  // ── PUT /banners/:id ──────────────────────────────────────────────────────
  update: async (req, res) => {
    const { id } = req.params;
    // ✅ FIX: eliminado 'label', añadido updated_at
    const { title, description, button_text, button_link, is_active, display_order } = req.body;
    const image_url = req.file ? req.file.path : null;

    try {
      // Verificar propiedad (superadmin puede editar cualquiera)
      const isSuperAdmin = req.user?.roles?.includes("superadmin");
      if (!isSuperAdmin) {
        const owned = await db.query(
          "SELECT id FROM banners WHERE id = $1 AND created_by = $2",
          [id, req.user.id]
        );
        if (owned.rowCount === 0) {
          const exists = await db.query("SELECT id FROM banners WHERE id = $1", [id]);
          return exists.rowCount
            ? res.status(403).json({ success: false, error: "No tienes permisos sobre este banner" })
            : res.status(404).json({ success: false, error: "Banner no encontrado" });
        }
      }

      let result;
      if (image_url) {
        result = await db.query(
          `UPDATE banners
           SET title        = COALESCE($1, title),
               description  = $2,
               button_text  = COALESCE($3, button_text),
               button_link  = COALESCE($4, button_link),
               is_active    = COALESCE($5, is_active),
               display_order = COALESCE($6, display_order),
               image_url    = $7,
               updated_at   = NOW()
           WHERE id = $8
           RETURNING *`,
          [
            title?.trim() || null,
            description?.trim() ?? null,
            button_text?.trim() || null,
            button_link?.trim() || null,
            is_active ?? null,
            display_order !== undefined ? parseInt(display_order) : null,
            image_url,
            id,
          ]
        );
      } else {
        result = await db.query(
          `UPDATE banners
           SET title        = COALESCE($1, title),
               description  = $2,
               button_text  = COALESCE($3, button_text),
               button_link  = COALESCE($4, button_link),
               is_active    = COALESCE($5, is_active),
               display_order = COALESCE($6, display_order),
               updated_at   = NOW()
           WHERE id = $7
           RETURNING *`,
          [
            title?.trim() || null,
            description?.trim() ?? null,
            button_text?.trim() || null,
            button_link?.trim() || null,
            is_active ?? null,
            display_order !== undefined ? parseInt(display_order) : null,
            id,
          ]
        );
      }

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Banner no encontrado" });
      }

      emitDataUpdate("banners", "updated", result.rows[0]);
      res.json({ success: true, message: "Banner actualizado", data: result.rows[0] });
    } catch (error) {
      console.error("[UPDATE BANNER ERROR]", error.message);
      res.status(500).json({ success: false, error: "Error al actualizar banner" });
    }
  },

  // ── DELETE /banners/:id ───────────────────────────────────────────────────
  delete: async (req, res) => {
    const { id } = req.params;
    try {
      const isSuperAdmin = req.user?.roles?.includes("superadmin");
      if (!isSuperAdmin) {
        const owned = await db.query(
          "SELECT id FROM banners WHERE id = $1 AND created_by = $2",
          [id, req.user.id]
        );
        if (owned.rowCount === 0) {
          const exists = await db.query("SELECT id FROM banners WHERE id = $1", [id]);
          return exists.rowCount
            ? res.status(403).json({ success: false, error: "No tienes permisos sobre este banner" })
            : res.status(404).json({ success: false, error: "Banner no encontrado" });
        }
      }

      const result = await db.query(
        "DELETE FROM banners WHERE id = $1 RETURNING id", [id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, error: "Banner no encontrado" });
      }

      emitDataUpdate("banners", "deleted", { id: parseInt(id) });
      res.json({ success: true, message: "Banner eliminado" });
    } catch (error) {
      console.error("[DELETE BANNER ERROR]", error.message);
      res.status(500).json({ success: false, error: "Error al eliminar banner" });
    }
  },
};

module.exports = bannerController;
const db = require("../config/db");
const { emitDataUpdate } = require("../config/socket");

const bannerController = {

  getAll: async (req, res) => {
    try {
      const result = await db.query("SELECT * FROM banners ORDER BY id DESC");
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },

  create: async (req, res) => {
    const { title, description, button_text, button_link } = req.body;
    const image_url = req.file ? req.file.path : "";

    try {
      const result = await db.query(
        `INSERT INTO banners (title, description, image_url, button_text, button_link)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [title, description, image_url, button_text, button_link]
      );

      const newBanner = result.rows[0];
      emitDataUpdate("banners", "created", newBanner);

      res.json({ id: newBanner.id, message: "Banner creado con éxito" });
    } catch (error) {
      console.error("CREATE BANNER ERROR:", error);
      res.status(500).json({ error: "Error al crear banner" });
    }
  },

  update: async (req, res) => {
    const { id } = req.params;
    const { title, description, button_text, button_link, is_active } = req.body;
    const image_url = req.file ? req.file.path : null;

    try {
      let result;

      if (image_url) {
        result = await db.query(
          `UPDATE banners
           SET title=$1, description=$2, button_text=$3, button_link=$4, is_active=$5, image_url=$6
           WHERE id=$7
           RETURNING *`,
          [title, description, button_text, button_link, is_active, image_url, id]
        );
      } else {
        result = await db.query(
          `UPDATE banners
           SET title=$1, description=$2, button_text=$3, button_link=$4, is_active=$5
           WHERE id=$6
           RETURNING *`,
          [title, description, button_text, button_link, is_active, id]
        );
      }

      emitDataUpdate("banners", "updated", result.rows[0]);

      res.json({ message: "Banner actualizado" });
    } catch (error) {
      console.error("UPDATE BANNER ERROR:", error);
      res.status(500).json({ error: "Error al actualizar banner" });
    }
  },

  delete: async (req, res) => {
    const { id } = req.params;

    try {
      await db.query("DELETE FROM banners WHERE id = $1", [id]);

      emitDataUpdate("banners", "deleted", { id: parseInt(id) });

      res.json({ message: "Banner eliminado" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
};

module.exports = bannerController;
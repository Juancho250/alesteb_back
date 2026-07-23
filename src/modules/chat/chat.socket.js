"use strict";

const db = require("../../platform/database");
const { notifyUser, Payloads } = require("../notifications").push;

/**
 * Registra exclusivamente los eventos Socket.IO pertenecientes al dominio Chat.
 * La autenticación, creación del servidor y administración de salas permanecen
 * en config/socket.js como infraestructura compartida.
 */
function registerChatSocketHandlers({ io, socket }) {
  const { id, name, adminId } = socket.user;

  socket.on("chat:dm", async ({ recipientId, message }) => {
    const parsedRecipientId = Number(recipientId);
    const cleanMessage = typeof message === "string" ? message.trim() : "";

    if (
      !Number.isSafeInteger(parsedRecipientId) ||
      parsedRecipientId <= 0 ||
      !cleanMessage ||
      cleanMessage.length > 2000
    ) {
      return socket.emit("chat:error", {
        code: "DM_INVALID_INPUT",
        message: "Mensaje invalido",
      });
    }

    try {
      const recipientCheck = await db.query(
        `SELECT id
         FROM users
         WHERE id = $1
           AND COALESCE(owner_admin_id, id) = $2
           AND is_active = true
         LIMIT 1`,
        [parsedRecipientId, adminId]
      );

      if (!recipientCheck.rows.length) {
        return socket.emit("chat:error", {
          code: "DM_RECIPIENT_NOT_FOUND",
          message: "Destinatario no disponible",
        });
      }

      const result = await db.query(
        `INSERT INTO chat_messages (user_id, user_name, recipient_id, message)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, name, parsedRecipientId, cleanMessage]
      );

      const msg = result.rows[0];

      io.to(`user_${parsedRecipientId}`).emit("chat:dm", msg);
      socket.emit("chat:dm", msg);

      notifyUser(parsedRecipientId, Payloads.newChat(name)).catch(() => {});
    } catch (err) {
      console.error("[Chat] Error DM:", err);

      socket.emit("chat:error", {
        code: "DM_FAILED",
        message: "No se pudo enviar el mensaje",
      });
    }
  });

  socket.on("chat:typing", ({ recipientId, isTyping }) => {
    if (!recipientId) return;

    socket
      .to(`user_${recipientId}`)
      .emit("chat:typing", { userId: id, isTyping });
  });
}

module.exports = {
  registerChatSocketHandlers,
};
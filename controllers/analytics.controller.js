// controllers/analytics.controller.js
const { pool } = require("../config/db"); // ajusta si tu import es diferente

// ─── Inicialización: crea la tabla si no existe ───────────────────────────────
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS page_views (
      id            SERIAL PRIMARY KEY,
      session_id    VARCHAR(60)  NOT NULL,
      page          VARCHAR(255) NOT NULL,
      page_label    VARCHAR(255),
      referrer      VARCHAR(255),
      referrer_label VARCHAR(255),
      time_on_prev  INTEGER,          -- segundos en la página anterior
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      device        VARCHAR(20),      -- Mobile / Desktop / Tablet
      screen_w      INTEGER,
      screen_h      INTEGER,
      created_at    TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pv_created  ON page_views (created_at);
    CREATE INDEX IF NOT EXISTS idx_pv_page     ON page_views (page);
    CREATE INDEX IF NOT EXISTS idx_pv_session  ON page_views (session_id);
  `);
}
ensureTable().catch(console.error);

// ─── Detectar dispositivo desde user-agent ────────────────────────────────────
function detectDevice(ua = "", screenW = 0) {
  if (/mobile|android|iphone|ipod/i.test(ua) || screenW < 768)  return "Móvil";
  if (/ipad|tablet/i.test(ua) || (screenW >= 768 && screenW < 1024)) return "Tablet";
  return "Escritorio";
}

// ─── Helper: rango de fechas según period ─────────────────────────────────────
function periodToInterval(period = "today") {
  switch (period) {
    case "week":    return "7 days";
    case "month":   return "30 days";
    case "today":
    default:        return "1 day";
  }
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/analytics/pageview
// ════════════════════════════════════════════════════════════════════════════
exports.trackPageview = async (req, res) => {
  try {
    const {
      sessionId, page, pageLabel,
      referrer, referrerLabel, timeOnPrevPage,
      userAgent, screenW, screenH, userId,
    } = req.body;

    if (!sessionId || !page) {
      return res.status(400).json({ success: false, message: "sessionId y page son requeridos" });
    }

    const device = detectDevice(userAgent, screenW);

    await pool.query(
      `INSERT INTO page_views
         (session_id, page, page_label, referrer, referrer_label,
          time_on_prev, user_id, device, screen_w, screen_h)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        sessionId, page, pageLabel ?? page,
        referrer ?? null, referrerLabel ?? null,
        timeOnPrevPage ?? null,
        userId ?? null,
        device,
        screenW ?? null,
        screenH ?? null,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("[analytics.trackPageview]", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// GET /api/analytics/summary?period=today|week|month
// ════════════════════════════════════════════════════════════════════════════
exports.getSummary = async (req, res) => {
  try {
    const interval = periodToInterval(req.query.period);

    // ── Top páginas ──────────────────────────────────────────────────────
    const { rows: topPages } = await pool.query(`
      SELECT
        page,
        COALESCE(MAX(page_label), page)         AS label,
        COUNT(*)                                 AS views,
        COUNT(DISTINCT session_id)               AS sessions,
        ROUND(AVG(time_on_prev))::int            AS avg_time,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE time_on_prev < 10 OR time_on_prev IS NULL)
          / NULLIF(COUNT(*), 0)
        )::int                                   AS bounce_rate
      FROM page_views
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY page
      ORDER BY views DESC
      LIMIT 10
    `);

    // ── Flujo de navegación (transiciones) ───────────────────────────────
    const { rows: flow } = await pool.query(`
      SELECT
        pv1.page_label  AS "from",
        pv2.page_label  AS "to",
        COUNT(*)        AS count
      FROM page_views pv1
      JOIN page_views pv2
        ON  pv1.session_id = pv2.session_id
        AND pv2.created_at > pv1.created_at
        AND pv2.created_at <= pv1.created_at + INTERVAL '10 minutes'
      WHERE pv1.created_at >= NOW() - INTERVAL '${interval}'
        AND pv1.page_label IS NOT NULL
        AND pv2.page_label IS NOT NULL
        AND pv1.page_label <> pv2.page_label
      GROUP BY pv1.page_label, pv2.page_label
      ORDER BY count DESC
      LIMIT 12
    `);

    // ── Embudo de compra (páginas clave en orden) ─────────────────────────
    const funnelPages = ["/", "/productos", "/productos/detalle", "/carrito", "/checkout", "/order-success"];
    const funnelLabels = ["Inicio", "Productos", "Detalle", "Carrito", "Checkout", "Pedido exitoso"];

    const { rows: funnelRaw } = await pool.query(`
      SELECT page, COUNT(DISTINCT session_id) AS sessions
      FROM page_views
      WHERE created_at >= NOW() - INTERVAL '${interval}'
        AND page = ANY($1)
      GROUP BY page
    `, [funnelPages]);

    const funnelMap = Object.fromEntries(funnelRaw.map(r => [r.page, parseInt(r.sessions)]));
    const funnel = funnelPages.map((p, i) => ({
      name:  funnelLabels[i],
      value: funnelMap[p] ?? 0,
    }));

    // ── Visitas por hora (hoy) ────────────────────────────────────────────
    const { rows: hourly } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'HH24:00') AS hora,
        COUNT(*) AS "Visitas"
      FROM page_views
      WHERE created_at >= NOW() - INTERVAL '1 day'
      GROUP BY DATE_TRUNC('hour', created_at)
      ORDER BY DATE_TRUNC('hour', created_at)
    `);

    // ── Últimas sesiones ──────────────────────────────────────────────────
    const { rows: sessionsRaw } = await pool.query(`
      SELECT
        session_id                             AS id,
        STRING_AGG(page_label, ' → '
          ORDER BY created_at)                AS path,
        COUNT(*)                               AS pages,
        EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::int AS duration,
        MAX(device)                            AS device,
        TO_CHAR(MIN(created_at), 'HH24:MI')   AS time,
        BOOL_OR(page = '/order-success')       AS converted
      FROM page_views
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY session_id
      ORDER BY MIN(created_at) DESC
      LIMIT 20
    `);

    const sessions = sessionsRaw.map(s => ({
      id:        s.id,
      path:      s.path,
      pages:     parseInt(s.pages),
      duration:  s.duration ?? 0,
      device:    s.device,
      time:      s.time,
      converted: s.converted,
    }));

    res.json({ success: true, topPages, flow, funnel, hourly, sessions });
  } catch (err) {
    console.error("[analytics.getSummary]", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
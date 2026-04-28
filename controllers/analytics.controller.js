// controllers/analytics.controller.js
const db = require("../config/db");

// ─── Tabla creada de forma lazy ───────────────────────────────────────────────
let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS page_views (
      id             SERIAL PRIMARY KEY,
      session_id     VARCHAR(60)  NOT NULL,
      page           VARCHAR(255) NOT NULL,
      page_label     VARCHAR(255),
      referrer       VARCHAR(255),
      referrer_label VARCHAR(255),
      time_on_prev   INTEGER,
      user_id        INTEGER,
      device         VARCHAR(20),
      screen_w       INTEGER,
      screen_h       INTEGER,
      created_at     TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views (created_at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pv_page    ON page_views (page)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pv_session ON page_views (session_id)`);
  tableReady = true;
}

// ─── Detectar dispositivo ─────────────────────────────────────────────────────
function detectDevice(ua = "", screenW = 0) {
  if (/mobile|android|iphone|ipod/i.test(ua) || screenW < 768)       return "Móvil";
  if (/ipad|tablet/i.test(ua) || (screenW >= 768 && screenW < 1024)) return "Tablet";
  return "Escritorio";
}

// ─── Helper: intervalo por período ───────────────────────────────────────────
function periodToInterval(period = "today") {
  if (period === "week")  return "7 days";
  if (period === "month") return "30 days";
  return "1 day";
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/analytics/pageview
// ════════════════════════════════════════════════════════════════════════════
exports.trackPageview = async (req, res) => {
  try {
    await ensureTable();

    const {
      sessionId, page, pageLabel,
      referrer, referrerLabel, timeOnPrevPage,
      userAgent, screenW, screenH, userId,
    } = req.body;

    if (!sessionId || !page)
      return res.status(400).json({ success: false, message: "sessionId y page son requeridos" });

    const device = detectDevice(userAgent, screenW);

    await db.query(
      `INSERT INTO page_views
         (session_id, page, page_label, referrer, referrer_label,
          time_on_prev, user_id, device, screen_w, screen_h)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        sessionId,
        page,
        pageLabel      ?? page,
        referrer       ?? null,
        referrerLabel  ?? null,
        timeOnPrevPage ?? null,
        userId         ?? null,
        device,
        screenW        ?? null,
        screenH        ?? null,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("[analytics.trackPageview]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// GET /api/analytics/summary?period=today|week|month
// ════════════════════════════════════════════════════════════════════════════
exports.getSummary = async (req, res) => {
  try {
    await ensureTable();

    const interval = periodToInterval(req.query.period);

    // Top páginas
    const { rows: topPages } = await db.query(`
      SELECT
        page,
        COALESCE(MAX(page_label), page)                                AS label,
        COUNT(*)::int                                                  AS views,
        COUNT(DISTINCT session_id)::int                                AS sessions,
        COALESCE(ROUND(AVG(time_on_prev))::int, 0)                    AS avg_time,
        COALESCE(ROUND(
          100.0 * COUNT(*) FILTER (WHERE time_on_prev < 10 OR time_on_prev IS NULL)
          / NULLIF(COUNT(*), 0)
        )::int, 0)                                                     AS bounce_rate
      FROM page_views
      WHERE created_at >= NOW() - ($1)::INTERVAL
      GROUP BY page
      ORDER BY views DESC
      LIMIT 10
    `, [interval]);

    // Flujo entre páginas
    const { rows: flow } = await db.query(`
      SELECT
        pv1.page_label AS "from",
        pv2.page_label AS "to",
        COUNT(*)::int  AS count
      FROM page_views pv1
      JOIN page_views pv2
        ON  pv1.session_id = pv2.session_id
        AND pv2.created_at > pv1.created_at
        AND pv2.created_at <= pv1.created_at + INTERVAL '10 minutes'
      WHERE pv1.created_at >= NOW() - ($1)::INTERVAL
        AND pv1.page_label IS NOT NULL
        AND pv2.page_label IS NOT NULL
        AND pv1.page_label <> pv2.page_label
      GROUP BY pv1.page_label, pv2.page_label
      ORDER BY count DESC
      LIMIT 12
    `, [interval]);

    // Embudo de compra
    const funnelPages  = ["/", "/productos", "/productos/detalle", "/carrito", "/checkout", "/order-success"];
    const funnelLabels = ["Inicio", "Productos", "Detalle", "Carrito", "Checkout", "Pedido exitoso"];

    const { rows: funnelRaw } = await db.query(`
      SELECT page, COUNT(DISTINCT session_id)::int AS sessions
      FROM page_views
      WHERE created_at >= NOW() - ($1)::INTERVAL
        AND page = ANY($2)
      GROUP BY page
    `, [interval, funnelPages]);

    const funnelMap = Object.fromEntries(funnelRaw.map(r => [r.page, r.sessions]));
    const funnel = funnelPages.map((p, i) => ({
      name:  funnelLabels[i],
      value: funnelMap[p] ?? 0,
    }));

    // Visitas por hora (siempre hoy)
    const { rows: hourly } = await db.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'HH24:00') AS hora,
        COUNT(*)::int                                       AS "Visitas"
      FROM page_views
      WHERE created_at >= NOW() - INTERVAL '1 day'
      GROUP BY DATE_TRUNC('hour', created_at)
      ORDER BY DATE_TRUNC('hour', created_at)
    `);

    // Últimas sesiones
    const { rows: sessionsRaw } = await db.query(`
      SELECT
        session_id                                                       AS id,
        STRING_AGG(page_label, ' → ' ORDER BY created_at)              AS path,
        COUNT(*)::int                                                    AS pages,
        COALESCE(
          EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::int,
          0
        )                                                                AS duration,
        MAX(device)                                                      AS device,
        TO_CHAR(MIN(created_at), 'HH24:MI')                            AS time,
        BOOL_OR(page = '/order-success')                                AS converted
      FROM page_views
      WHERE created_at >= NOW() - ($1)::INTERVAL
      GROUP BY session_id
      ORDER BY MIN(created_at) DESC
      LIMIT 20
    `, [interval]);

    res.json({
      success: true,
      topPages,
      flow,
      funnel,
      hourly,
      sessions: sessionsRaw,
    });

  } catch (err) {
    console.error("[analytics.getSummary]", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};
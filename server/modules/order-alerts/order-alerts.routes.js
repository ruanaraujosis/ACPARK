import { query, tx, asInt } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { handleOrderAlertEvents } from "../../services/order-alerts/order-alerts.events.js";

const defaultPreferences = {
  enabled: true,
  soundId: "repetitive-alert",
  volume: 70,
  visualNotifications: true,
  repeatMode: "three_times",
  repeatIntervalSeconds: 5,
  stopOnView: true,
  stopOnServiceStart: true
};

const systemSounds = [
  { id: "default", displayName: "Alerta padrao", isSystem: true },
  { id: "bell", displayName: "Campainha curta", isSystem: true },
  { id: "soft", displayName: "Toque suave", isSystem: true },
  { id: "chime", displayName: "Chime", isSystem: true },
  { id: "double", displayName: "Toque duplo", isSystem: true },
  { id: "repetitive-alert", displayName: "Alerta repetitivo", isSystem: true },
  { id: "repetitive-bell", displayName: "Campainha repetitiva", isSystem: true },
  { id: "urgent", displayName: "Chamada urgente", isSystem: true },
  { id: "waiting", displayName: "Pedido aguardando", isSystem: true },
  { id: "soft-continuous", displayName: "Alerta continuo suave", isSystem: true }
];

const allowedRepeatModes = new Set(["once", "two_times", "three_times", "thirty_seconds", "until_viewed", "until_service_start"]);
const allowedIntervals = new Set([3, 5, 10, 15, 30]);

let schemaReady = null;

// Cria/atualiza (uma única vez, cacheado em memória) as tabelas de preferências e sons de alerta
export function ensureOrderAlertTables() {
  schemaReady ||= tx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_order_alert_preferences (
        id BIGSERIAL PRIMARY KEY,
        user_key TEXT NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sound_id VARCHAR(100) NOT NULL DEFAULT 'repetitive-alert',
        volume INTEGER NOT NULL DEFAULT 70,
        visual_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        repeat_mode VARCHAR(40) NOT NULL DEFAULT 'three_times',
        repeat_interval_seconds INTEGER NOT NULL DEFAULT 5,
        stop_on_view BOOLEAN NOT NULL DEFAULT TRUE,
        stop_on_service_start BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query("ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS repeat_mode VARCHAR(40) NOT NULL DEFAULT 'three_times'");
    await client.query("ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS repeat_interval_seconds INTEGER NOT NULL DEFAULT 5");
    await client.query("ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS stop_on_view BOOLEAN NOT NULL DEFAULT TRUE");
    await client.query("ALTER TABLE user_order_alert_preferences ADD COLUMN IF NOT EXISTS stop_on_service_start BOOLEAN NOT NULL DEFAULT TRUE");
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_alert_sounds (
        id BIGSERIAL PRIMARY KEY,
        sound_key VARCHAR(100) NOT NULL UNIQUE,
        display_name VARCHAR(150) NOT NULL,
        storage_path VARCHAR(500),
        mime_type VARCHAR(100),
        size_bytes BIGINT DEFAULT 0,
        duration_seconds NUMERIC,
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    for (const sound of systemSounds) {
      await client.query(
        `INSERT INTO order_alert_sounds (sound_key, display_name, is_system, is_active)
         VALUES ($1, $2, TRUE, TRUE)
         ON CONFLICT (sound_key) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             is_system = TRUE,
             is_active = TRUE`,
        [sound.id, sound.displayName]
      );
    }
  });
  return schemaReady;
}

// Gera a chave usada para persistir preferências de alerta por usuário (admin ou PDV)
function userKey(user) {
  return user.role === "admin" ? `admin:${user.name || "Almoxarifado"}` : `pdv:${user.pdvId || user.name || "unknown"}`;
}

// Valida e aplica defaults nas preferências de alerta sonoro enviadas pelo cliente
function normalizePreferences(body = {}) {
  const soundId = normalizeText(body.soundId || body.sound_id || defaultPreferences.soundId, 100) || defaultPreferences.soundId;
  const volume = Math.max(0, Math.min(100, asInt(body.volume ?? defaultPreferences.volume)));
  const repeatMode = normalizeText(body.repeatMode || body.repeat_mode || defaultPreferences.repeatMode, 40) || defaultPreferences.repeatMode;
  const repeatIntervalSeconds = asInt(body.repeatIntervalSeconds ?? body.repeat_interval_seconds ?? defaultPreferences.repeatIntervalSeconds);
  return {
    enabled: body.enabled !== false,
    soundId,
    volume,
    visualNotifications: body.visualNotifications !== false && body.visual_notifications !== false,
    repeatMode: allowedRepeatModes.has(repeatMode) ? repeatMode : defaultPreferences.repeatMode,
    repeatIntervalSeconds: allowedIntervals.has(repeatIntervalSeconds) ? repeatIntervalSeconds : defaultPreferences.repeatIntervalSeconds,
    stopOnView: body.stopOnView !== false && body.stop_on_view !== false,
    stopOnServiceStart: body.stopOnServiceStart !== false && body.stop_on_service_start !== false
  };
}

// Converte a linha do banco (snake_case) para o formato de preferências usado pelo front (camelCase)
function mapPreferenceRow(row) {
  if (!row) return { ...defaultPreferences };
  return {
    enabled: row.enabled,
    soundId: row.sound_id,
    volume: asInt(row.volume),
    visualNotifications: row.visual_notifications,
    repeatMode: row.repeat_mode || defaultPreferences.repeatMode,
    repeatIntervalSeconds: asInt(row.repeat_interval_seconds || defaultPreferences.repeatIntervalSeconds),
    stopOnView: row.stop_on_view !== false,
    stopOnServiceStart: row.stop_on_service_start !== false
  };
}

// Resumo dos pedidos pendentes (agrupados por código) usado para exibir alertas ao Almoxarifado
async function pendingOrdersSummary() {
  const rows = await query(
    `SELECT
       COALESCE(NULLIF(p.codigo_pedido, ''), p.id::text) AS "orderNumber",
       COALESCE(NULLIF(p.codigo_pedido, ''), p.id::text) AS "orderId",
       COALESCE(MAX(pd.nome), 'PDV') AS "pointName",
       MIN(COALESCE(p.criado_em, p.data_hora)) AS "createdAt",
       COUNT(*)::int AS "itemCount"
     FROM pedidos p
     LEFT JOIN pdvs pd ON pd.id = p.pdv_id
     WHERE p.status = 'Pendente'
     GROUP BY COALESCE(NULLIF(p.codigo_pedido, ''), p.id::text)
     ORDER BY MIN(COALESCE(p.criado_em, p.data_hora)) DESC
     LIMIT 30`
  );
  return rows;
}

// Total de pedidos distintos aguardando atendimento
async function pendingOrdersCount() {
  const rows = await query(
    `SELECT COUNT(DISTINCT COALESCE(NULLIF(codigo_pedido, ''), id::text))::int AS pending
     FROM pedidos
     WHERE status = 'Pendente'`
  );
  return asInt(rows[0]?.pending);
}

// Lista os identificadores dos pedidos pendentes, usada pelo cliente para detectar novidades
async function pendingOrderIds() {
  const rows = await query(
    `SELECT COALESCE(NULLIF(codigo_pedido, ''), id::text) AS "orderId"
     FROM pedidos
     WHERE status = 'Pendente'
     GROUP BY COALESCE(NULLIF(codigo_pedido, ''), id::text)
     ORDER BY MIN(COALESCE(criado_em, data_hora)) DESC`
  );
  return rows.map((row) => String(row.orderId)).filter(Boolean);
}

// Roteador dos alertas sonoros/visuais de novos pedidos exibidos para o Almoxarifado
export async function handleOrderAlertRoutes(req, res, context) {
  const { method, url, user } = context;

  // Conexão de eventos em tempo real (SSE) para notificar novos pedidos pendentes
  if (url.pathname === "/api/admin/order-alert-events") {
    if (user.role !== "admin") return send(res, 403, { error: "Acesso restrito ao Almoxarifado." }), true;
    handleOrderAlertEvents(req, res);
    return true;
  }

  if (url.pathname === "/api/admin/order-alert-summary" && method === "GET") {
    if (user.role !== "admin") return send(res, 403, { error: "Acesso restrito ao Almoxarifado." }), true;
    const pendingOrders = await pendingOrdersSummary();
    const pending = await pendingOrdersCount();
    const ids = await pendingOrderIds();
    return send(res, 200, { pending, pendingOrders, pendingOrderIds: ids }), true;
  }

  // Consulta/atualiza as preferências pessoais de alerta (som, volume, repetição) do usuário logado
  if (url.pathname === "/api/user/order-alert-preferences") {
    if (user.role !== "admin") return send(res, 403, { error: "Alertas sonoros disponiveis apenas para o Almoxarifado." }), true;
    await ensureOrderAlertTables();
    const key = userKey(user);

    if (method === "GET") {
      const rows = await query(
        `SELECT enabled, sound_id, volume, visual_notifications, repeat_mode, repeat_interval_seconds, stop_on_view, stop_on_service_start
         FROM user_order_alert_preferences
         WHERE user_key = $1`,
        [key]
      );
      const sounds = await query(
        `SELECT sound_key AS id, display_name AS "displayName", is_system AS "isSystem"
         FROM order_alert_sounds
         WHERE is_active = TRUE
         ORDER BY is_system DESC, display_name`
      );
      return send(res, 200, { preferences: mapPreferenceRow(rows[0]), sounds }), true;
    }

    if (method === "PUT") {
      const body = await readBody(req);
      const preferences = normalizePreferences(body);
      const soundRows = await query(
        "SELECT 1 FROM order_alert_sounds WHERE sound_key = $1 AND is_active = TRUE",
        [preferences.soundId]
      );
      if (!soundRows[0]) return send(res, 400, { error: "Toque selecionado nao esta disponivel." }), true;
      await query(
        `INSERT INTO user_order_alert_preferences
          (user_key, enabled, sound_id, volume, visual_notifications, repeat_mode, repeat_interval_seconds, stop_on_view, stop_on_service_start, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (user_key) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             sound_id = EXCLUDED.sound_id,
             volume = EXCLUDED.volume,
             visual_notifications = EXCLUDED.visual_notifications,
             repeat_mode = EXCLUDED.repeat_mode,
             repeat_interval_seconds = EXCLUDED.repeat_interval_seconds,
             stop_on_view = EXCLUDED.stop_on_view,
             stop_on_service_start = EXCLUDED.stop_on_service_start,
             updated_at = NOW()`,
        [
          key,
          preferences.enabled,
          preferences.soundId,
          preferences.volume,
          preferences.visualNotifications,
          preferences.repeatMode,
          preferences.repeatIntervalSeconds,
          preferences.stopOnView,
          preferences.stopOnServiceStart
        ]
      );
      return send(res, 200, { ok: true, preferences }), true;
    }
  }

  // Lista os sons disponíveis para uso como alerta
  if (url.pathname === "/api/admin/order-alert-sounds" && method === "GET") {
    if (user.role !== "admin") return send(res, 403, { error: "Acesso restrito ao Almoxarifado." }), true;
    await ensureOrderAlertTables();
    const sounds = await query(
      `SELECT sound_key AS id, display_name AS "displayName", is_system AS "isSystem"
       FROM order_alert_sounds
       WHERE is_active = TRUE
       ORDER BY is_system DESC, display_name`
    );
    return send(res, 200, { sounds }), true;
  }

  return false;
}

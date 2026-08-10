import crypto from "node:crypto";
import { asInt, code, query, tx, verifyPassword } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { getStorageService } from "../../services/storage/storage.service.js";

let avariaColumnsReady = null;
let avariaIdempotencyReady = null;

const OMIE_DISABLED_STATUS = "Integração desativada";

// Garante colunas adicionais usadas pelo fluxo manual de avarias (cacheado em memória)
function ensureAvariaColumns() {
  avariaColumnsReady ||= tx(async (client) => {
    await client.query("ALTER TABLE devolucao_avaria_itens ADD COLUMN IF NOT EXISTS retirada_assinatura TEXT");
    await client.query("ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS manual_quantidade_processada INTEGER DEFAULT 0");
    await client.query("ALTER TABLE devolucoes_avaria ADD COLUMN IF NOT EXISTS movimento_manual_status TEXT DEFAULT 'Pendente'");
    await client.query("ALTER TABLE devolucao_avaria_itens ADD COLUMN IF NOT EXISTS manual_quantidade_processada INTEGER DEFAULT 0");
    await client.query("ALTER TABLE devolucao_avaria_itens ADD COLUMN IF NOT EXISTS movimento_manual_status TEXT DEFAULT 'Pendente'");
  });
  return avariaColumnsReady;
}

// Cria a tabela de controle de idempotência das operações de avaria (cacheado em memória)
function ensureAvariaIdempotencyTable() {
  avariaIdempotencyReady ||= tx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS devolucao_idempotencia (
        id SERIAL PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        user_role TEXT NOT NULL,
        user_name TEXT NOT NULL,
        pdv_id INTEGER REFERENCES pdvs(id) ON DELETE SET NULL,
        devolucao_id INTEGER REFERENCES devolucoes_avaria(id) ON DELETE SET NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER,
        response_body JSONB,
        processing_status TEXT NOT NULL DEFAULT 'PROCESSING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        UNIQUE (idempotency_key, operation_type, user_role, user_name)
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_devolucao_idempotencia_devolucao ON devolucao_idempotencia(devolucao_id, operation_type)");
  });
  return avariaIdempotencyReady;
}

const officialAvariaStatuses = [
  "Aguardando Produto",
  "Em Aprovação",
  "Aprovação Parcial",
  "Finalizado",
  "Recusado",
  "Verificação",
  "Cancelado"
];

const avariaStatuses = [
  ...officialAvariaStatuses,
  "Aguardando Produto",
  "Aguardando Produto",
  "Em Aprovação",
  "Aprovada",
  "Aprovação Parcial",
  "Verificação",
  "Recusada",
  "Finalizada",
  "Pendente",
  "Enviada ao almoxarifado",
  "Aguardando entrega física",
  "Em recebimento",
  "Recebida e assinada",
  "Em conferência",
  "Aprovada parcialmente",
  "Aguardando integração com o OMIE",
  "Aguardando recebimento físico",
  "Recebida",
  "Cancelado",
  "Cancelada"
];

const motivosAvaria = [
  "Produto vencido",
  "Produto danificado",
  "Produto estragado",
  "Embalagem violada",
  "Quebra",
  "Contaminação",
  "Problema de armazenamento",
  "Outro motivo"
];

// Normaliza fotos recebidas em diversos formatos (array, JSON string, lista separada) para data URLs válidas
function parsePhotos(value) {
  const normalizePhoto = (item) => {
    const raw = typeof item === "string" ? item : item?.data || "";
    const value = String(raw || "");
    if (!value) return "";
    if (!/^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,/i.test(value)) return "";
    if (value.length > 7500000) return "";
    return value;
  };
  if (Array.isArray(value)) return value.map(normalizePhoto).filter(Boolean).slice(0, 12);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (Array.isArray(parsed)) return parsed.map(normalizePhoto).filter(Boolean).slice(0, 12);
  } catch {}
  return String(value || "")
    .split(/\r?\n|[,;]/)
    .map((item) => normalizePhoto(item))
    .filter(Boolean)
    .slice(0, 12);
}

// Extrai a lista de itens de uma devolução, aceitando array direto ou JSON serializado
function parseItems(body) {
  if (Array.isArray(body.produtos)) return body.produtos;
  if (Array.isArray(body.items)) return body.items;
  try {
    const parsed = JSON.parse(String(body.produtos || "[]"));
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  try {
    const parsed = JSON.parse(String(body.items || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Lê o corpo bruto da requisição (usado para upload multipart de fotos)
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Parser simples de multipart/form-data (sem dependência externa) para extrair campos e arquivos
function parseMultipart(req, buffer) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return { fields: {}, files: [] };
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const raw = buffer.toString("binary");
  const parts = raw.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];
  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const separator = trimmed.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headerText = trimmed.slice(0, separator);
    const bodyText = trimmed.slice(separator + 4);
    const disposition = headerText.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!disposition) continue;
    const name = disposition[1];
    const filename = disposition[2];
    const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);
    const data = Buffer.from(bodyText, "binary");
    if (filename) {
      files.push({ field: name, filename, mimeType: typeMatch?.[1] || "application/octet-stream", buffer: data });
    } else {
      fields[name] = data.toString("utf8");
    }
  }
  return { fields, files };
}

// Monta o payload público de uma foto, incluindo URL assinada de acesso
function photoJson(row, storage = getStorageService()) {
  return {
    id: row.id,
    storage_key: row.storage_key,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    url: storage.getSignedUrl(row.id),
    thumbnail_url: storage.getSignedUrl(row.id)
  };
}

// Admin acessa qualquer foto; PDV só acessa fotos próprias ou vinculadas a devoluções do seu PDV
async function userCanAccessPhoto(client, user, photo) {
  if (user.role === "admin") return true;
  if (user.role !== "pdv") return false;
  if (asInt(photo.owner_pdv_id) === asInt(user.pdvId) && !photo.devolucao_id) return true;
  if (!photo.devolucao_id) return false;
  const allowed = await client.query("SELECT 1 FROM devolucoes_avaria WHERE id = $1 AND pdv_id = $2", [photo.devolucao_id, user.pdvId]);
  return Boolean(allowed.rows[0]);
}

// Garante que as fotos temporárias informadas existam, pertençam ao PDV e ainda não estejam vinculadas a um item
async function assertPhotoIdsAvailable(client, { photoIds, pdvId }) {
  const uniqueIds = [...new Set((photoIds || []).map(asInt).filter(Boolean))];
  if (!uniqueIds.length) return;
  const result = await client.query(
    `SELECT id
     FROM devolucao_avaria_fotos
     WHERE id = ANY($1::bigint[])
       AND owner_pdv_id = $2
       AND item_id IS NULL
       AND deleted_at IS NULL
     FOR UPDATE`,
    [uniqueIds, pdvId]
  );
  if (result.rows.length !== uniqueIds.length) {
    const error = new Error("Uma ou mais fotos anexadas nao estao disponiveis para esta devolucao.");
    error.statusCode = 400;
    throw error;
  }
}

// Ordena chaves de objetos e remove campos de idempotência para gerar um hash estável do payload
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (["idempotencyKey", "idempotency_key"].includes(key)) return acc;
        acc[key] = stableValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

// Hash SHA-256 do payload normalizado, usado para detectar reuso de idempotency-key com dados diferentes
function hashPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(payload || {})))
    .digest("hex");
}

// Lê a chave de idempotência do header ou do corpo da requisição
function normalizeIdempotencyKey(req, body = {}) {
  return normalizeText(
    req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || body.idempotencyKey || body.idempotency_key,
    120
  );
}

// Exige uma chave de idempotência válida; lança erro 400 se ausente
function requireIdempotencyKey(req, body) {
  const key = normalizeIdempotencyKey(req, body);
  if (!key) {
    const error = new Error("Identificador da operação ausente. Atualize a página e tente novamente.");
    error.statusCode = 400;
    throw error;
  }
  return key;
}

// Define o escopo (papel, nome, pdv) usado para isolar chaves de idempotência entre usuários
function idempotencyUserScope(user) {
  return {
    role: normalizeText(user?.role, 40) || "unknown",
    name: normalizeText(user?.name, 120) || "unknown",
    pdvId: asInt(user?.pdvId || user?.pdv_id)
  };
}

// Registra o início de uma operação idempotente; se a chave já foi usada, retorna a resposta anterior
// (repeated=true) em vez de repetir o efeito colateral, ou bloqueia se ainda estiver em processamento
async function beginIdempotentOperation(client, { req, body, user, operationType, devolucaoId = 0 }) {
  await ensureAvariaIdempotencyTable();
  const idempotencyKey = requireIdempotencyKey(req, body);
  const requestHash = hashPayload(body);
  const scope = idempotencyUserScope(user);
  // Tenta reservar a chave; se já existir, cai no fluxo de reconsulta abaixo
  const inserted = await client.query(
    `INSERT INTO devolucao_idempotencia
       (idempotency_key, operation_type, user_role, user_name, pdv_id, devolucao_id, request_hash, processing_status)
     VALUES ($1, $2, $3, $4, NULLIF($5, 0), NULLIF($6, 0), $7, 'PROCESSING')
     ON CONFLICT (idempotency_key, operation_type, user_role, user_name) DO NOTHING
     RETURNING id`,
    [idempotencyKey, operationType, scope.role, scope.name, scope.pdvId || 0, asInt(devolucaoId), requestHash]
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, repeated: false };

  const existing = await client.query(
    `SELECT *
     FROM devolucao_idempotencia
     WHERE idempotency_key = $1 AND operation_type = $2 AND user_role = $3 AND user_name = $4
     FOR UPDATE`,
    [idempotencyKey, operationType, scope.role, scope.name]
  );
  const row = existing.rows[0];
  if (!row) {
    const error = new Error("Não foi possível validar a operação. Tente novamente.");
    error.statusCode = 409;
    throw error;
  }
  if (row.request_hash !== requestHash) {
    // Mesma chave de idempotência reaproveitada com payload diferente: não é seguro reexecutar
    const error = new Error("Esta chave de operação já foi usada com dados diferentes.");
    error.statusCode = 409;
    throw error;
  }
  if (row.processing_status === "COMPLETED" && row.response_body) {
    return {
      repeated: true,
      responseStatus: asInt(row.response_status) || 200,
      responseBody: typeof row.response_body === "string" ? JSON.parse(row.response_body) : row.response_body
    };
  }
  const error = new Error("Esta operação já está em processamento.");
  error.statusCode = 409;
  throw error;
}

// Marca a operação idempotente como concluída, salvando a resposta para futuras repetições da mesma chave
async function completeIdempotentOperation(client, operation, responseStatus, responseBody) {
  if (!operation?.id) return;
  await client.query(
    `UPDATE devolucao_idempotencia
     SET response_status = $2,
         response_body = $3::jsonb,
         processing_status = 'COMPLETED',
         completed_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [operation.id, responseStatus, JSON.stringify(responseBody || { ok: true })]
  );
}

// Mapeia os muitos status históricos/alternativos de avaria para os status oficiais atuais
function normalizeDamageStatus(status) {
  if (["Cancelado", "Cancelada"].includes(status)) return "Cancelado";
  if (["Pendente", "Enviada ao almoxarifado", "Enviar para o Almoxarifado", "Aguardando Produto", "Aguardando recebimento físico", "Aguardando entrega física", "Aguardando Entrega Física"].includes(status)) return "Aguardando Produto";
  if (["Em recebimento", "Recebida e assinada", "Em conferência", "Recebida", "Em Aprovação", "Aprovada", "Aguardando integração com o OMIE"].includes(status)) return "Em Aprovação";
  if (["Aprovação Parcial", "Aprovada parcialmente"].includes(status)) return "Aprovação Parcial";
  if (status === "Recusada") return "Recusado";
  if (status === "Finalizada") return "Finalizado";
  if (status === "Verificação") return "Verificação";
  return status || "Aguardando Produto";
}

const finalDamageStatuses = ["Cancelado", "Cancelada", "Finalizado", "Finalizada", "Recusado", "Recusada"];

// Trecho SQL reutilizável que compara produto/lote/validade para detectar devoluções duplicadas
function duplicateMatchClause(alias = "i") {
  return `
    ${alias}.sku_produto = $2
    AND COALESCE(NULLIF(${alias}.lote, ''), '') = COALESCE(NULLIF($3, ''), '')
    AND COALESCE(${alias}.data_validade::text, '') = COALESCE(NULLIF($4, ''), '')
  `;
}

// Bloqueia (via advisory lock) e valida que não existe outra devolução ativa para o mesmo
// produto/lote/validade neste PDV, evitando solicitações duplicadas em corridas concorrentes
async function assertNoActiveDuplicate(client, { pdvId, sku, lote = "", dataValidade = "", currentDevolucaoId = 0, usuario = "", origem = "Sistema" }) {
  const lockKey = `${pdvId}|${sku}|${lote || ""}|${dataValidade || ""}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  const duplicate = await client.query(
    `SELECT d.id, d.codigo_devolucao, d.status, d.criado_em, d.quantidade, pd.nome AS pdv,
            COALESCE(i.quantidade, d.quantidade) AS item_quantidade
     FROM devolucoes_avaria d
     LEFT JOIN devolucao_avaria_itens i ON i.devolucao_id = d.id
     LEFT JOIN pdvs pd ON pd.id = d.pdv_id
     CROSS JOIN LATERAL (
       SELECT CASE
         WHEN d.status IN ('Cancelado', 'Cancelada') THEN 'Cancelado'
         WHEN d.status IN ('Finalizado', 'Finalizada') THEN 'Finalizado'
         WHEN d.status IN ('Recusado', 'Recusada') THEN 'Recusado'
         ELSE d.status
       END AS status
     ) normalize_status
     WHERE d.pdv_id = $1
       AND COALESCE(d.id, 0) <> $5
       AND normalize_status.status NOT IN ('Cancelado', 'Finalizado', 'Recusado')
       AND (
         (${duplicateMatchClause("i")})
         OR (
           i.id IS NULL
           AND d.sku_produto = $2
           AND COALESCE(NULLIF(d.lote, ''), '') = COALESCE(NULLIF($3, ''), '')
           AND COALESCE(d.data_validade::text, '') = COALESCE(NULLIF($4, ''), '')
         )
       )
     ORDER BY d.criado_em DESC
     LIMIT 1`,
    [asInt(pdvId), sku, lote || "", dataValidade || "", asInt(currentDevolucaoId)]
  );
  if (duplicate.rows[0]) {
    const existing = duplicate.rows[0];
    await audit(client, existing.id, {
      usuario,
      acao: "Tentativa de duplicidade",
      statusAnterior: existing.status,
      novoStatus: existing.status,
      quantidade: existing.item_quantidade,
      observacao: `Tentativa bloqueada para o produto ${sku}.`,
      origem
    });
    const error = new Error("Já existe uma solicitação ativa para este produto.");
    error.statusCode = 409;
    error.code = "DUPLICATE_ACTIVE_RETURN";
    error.existingRequest = {
      id: existing.id,
      number: existing.codigo_devolucao,
      status: normalizeDamageStatus(existing.status),
      createdAt: existing.criado_em,
      quantidade: existing.item_quantidade,
      pdv: existing.pdv
    };
    throw error;
  }
}

// Define para quais status uma devolução finalizada/recusada pode retornar (fluxo de estorno)
function statusTransitionOptions(status) {
  const current = normalizeDamageStatus(status);
  if (current === "Finalizado" || current === "Recusado") return ["Verificação"];
  if (current === "Verificação") return ["Finalizado", "Recusado"];
  return [];
}

// Status simplificado de um item de devolução, exibido ao PDV
function itemVisibleStatus(item) {
  if (item.status_item === "Aguardando retirada pelo ponto") return "Aguardando retirada pelo ponto";
  if (item.status_item === "Pendente") return "Pendente";
  if (["Aprovado", "Parcial"].includes(item.status_item)) return "Aprovado";
  if (["Recusado", "Recusada"].includes(item.status_item)) return "Recusado";
  return normalizeDamageStatus(item.status_item);
}

// Grava uma linha no histórico de auditoria da devolução de avaria
async function audit(client, devolucaoId, { usuario, acao, statusAnterior, novoStatus, quantidade, observacao, origem }) {
  await client.query(
    `INSERT INTO devolucao_avaria_historico
       (devolucao_id, usuario, acao, status_anterior, novo_status, quantidade, observacao, origem)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      devolucaoId,
      normalizeText(usuario, 120) || null,
      normalizeText(acao, 120),
      statusAnterior || null,
      novoStatus || null,
      asInt(quantidade),
      normalizeText(observacao, 700) || null,
      normalizeText(origem, 80) || null
    ]
  );
}

// Exclui definitivamente devoluções de avaria e todos os registros dependentes (fotos, histórico, itens)
async function deleteDamageReturns(client, ids = []) {
  const validIds = [...new Set(ids.map(asInt).filter(Boolean))];
  if (!validIds.length) return 0;

  await ensureAvariaIdempotencyTable();
  await client.query("DELETE FROM estoque_avarias WHERE devolucao_id = ANY($1::int[])", [validIds]);
  await client.query("DELETE FROM devolucao_avaria_fotos WHERE devolucao_id = ANY($1::int[])", [validIds]);
  await client.query("DELETE FROM devolucao_avaria_historico WHERE devolucao_id = ANY($1::int[])", [validIds]);
  await client.query("UPDATE devolucao_idempotencia SET devolucao_id = NULL WHERE devolucao_id = ANY($1::int[])", [validIds]);
  await client.query("DELETE FROM devolucao_avaria_itens WHERE devolucao_id = ANY($1::int[])", [validIds]);
  const result = await client.query("DELETE FROM devolucoes_avaria WHERE id = ANY($1::int[]) RETURNING id", [validIds]);
  return result.rowCount;
}

// Confirma a senha do almoxarifado para ações sensíveis (ex: alterar devolução já finalizada); audita tentativas inválidas
async function requireAdminPassword(client, devolucaoId, password, usuario, acao) {
  const config = await client.query("SELECT valor FROM configuracoes WHERE chave = 'senha_almoxarifado'");
  if (!password || !config.rows[0] || !verifyPassword(password, config.rows[0].valor)) {
    await audit(client, devolucaoId, {
      usuario,
      acao: "Tentativa inválida de autorização admin",
      observacao: acao,
      origem: "Almoxarifado"
    });
    const error = new Error("Senha do admin incorreta.");
    error.statusCode = 401;
    throw error;
  }
}

// Lista devoluções de avaria com seus itens agregados em JSON, filtráveis por PDV/status/período
async function listDevolucoes({ pdvId = 0, status = "", from = "", to = "" } = {}) {
  const allowedStatus = officialAvariaStatuses.includes(status) ? status : "";
  return query(
    `SELECT d.id, d.codigo_devolucao, d.pdv_id, pd.nome AS pdv, d.sku_produto, pr.nome AS produto,
            d.quantidade, d.unidade_medida, d.motivo, d.outro_motivo, d.data_identificacao,
            d.lote, d.data_validade, d.observacao, d.fotos, d.usuario_solicitante, d.status,
            d.quantidade_recebida, d.quantidade_aprovada, d.quantidade_recusada,
            d.motivo_divergencia, d.observacao_interna, d.assinatura_imagem, d.assinatura_confirmada_em,
            d.responsavel_entrega_nome, d.responsavel_entrega_documento, d.responsavel_entrega_cargo,
            d.entrega_em, d.recebido_por_usuario, d.recebido_sessao, d.recebido_ip,
            d.omie_status, d.omie_request_id,
            d.omie_error, d.omie_attempts, d.omie_quantidade_processada, d.criado_em,
            COALESCE(d.manual_quantidade_processada, d.omie_quantidade_processada, 0) AS manual_quantidade_processada,
            COALESCE(d.movimento_manual_status, 'Pendente') AS movimento_manual_status,
            d.atualizado_em, d.recebido_em, d.finalizado_em, d.cancelado_em,
            COALESCE(d.verificado, FALSE) AS verificado, d.estornado_em, d.estornado_por, d.motivo_estorno,
            COALESCE(e.quantidade, 0) AS saldo_pdv,
            COALESCE(items.itens, '[]'::json) AS itens,
            COALESCE(items.total_quantidade, d.quantidade, 0) AS total_quantidade,
            COALESCE(items.total_aprovada, d.quantidade_aprovada, 0) AS total_aprovada,
            COALESCE(items.total_recusada, d.quantidade_recusada, 0) AS total_recusada
     FROM devolucoes_avaria d
     LEFT JOIN pdvs pd ON pd.id = d.pdv_id
     LEFT JOIN produtos pr ON pr.sku = d.sku_produto
     LEFT JOIN estoque_pdv e ON e.pdv_id = d.pdv_id AND e.sku_produto = d.sku_produto
     LEFT JOIN LATERAL (
       SELECT
         json_agg(json_build_object(
           'id', i.id,
           'sku_produto', i.sku_produto,
           'produto', p2.nome,
           'quantidade', i.quantidade,
           'unidade_medida', i.unidade_medida,
           'motivo', i.motivo,
           'outro_motivo', i.outro_motivo,
           'data_identificacao', i.data_identificacao,
           'lote', i.lote,
           'data_validade', i.data_validade,
           'observacao', i.observacao,
           'fotos', COALESCE((
             SELECT json_agg(json_build_object(
               'id', f.id,
               'storage_key', f.storage_key,
               'url', '/api/avarias/fotos/' || f.id,
               'thumbnail_url', '/api/avarias/fotos/' || f.id,
               'original_name', f.original_name,
               'mime_type', f.mime_type,
               'size_bytes', f.size_bytes,
               'sha256', f.sha256
             ) ORDER BY f.id)
             FROM devolucao_avaria_fotos f
             WHERE f.item_id = i.id AND f.deleted_at IS NULL
           ), NULLIF(i.fotos, '')::json),
           'status_item', i.status_item,
           'quantidade_recebida', i.quantidade_recebida,
           'quantidade_aprovada', i.quantidade_aprovada,
           'quantidade_recusada', i.quantidade_recusada,
           'motivo_divergencia', i.motivo_divergencia,
           'observacao_interna', i.observacao_interna,
           'manual_quantidade_processada', COALESCE(i.manual_quantidade_processada, i.omie_quantidade_processada, 0),
           'movimento_manual_status', COALESCE(i.movimento_manual_status, 'Pendente'),
           'retirada_responsavel', i.retirada_responsavel,
           'retirada_assinatura', i.retirada_assinatura,
           'retirada_em', i.retirada_em,
           'retirada_confirmada', i.retirada_confirmada
         ) ORDER BY i.id) AS itens,
         SUM(i.quantidade) AS total_quantidade,
         SUM(i.quantidade_aprovada) AS total_aprovada,
         SUM(i.quantidade_recusada) AS total_recusada
       FROM devolucao_avaria_itens i
       LEFT JOIN produtos p2 ON p2.sku = i.sku_produto
       WHERE i.devolucao_id = d.id
     ) items ON TRUE
     WHERE ($1::int = 0 OR d.pdv_id = $1)
       AND ($2::text IS NULL OR d.status = $2)
       AND ($3::date IS NULL OR d.criado_em::date >= $3::date)
       AND ($4::date IS NULL OR d.criado_em::date <= $4::date)
     ORDER BY d.criado_em DESC, d.id DESC
     LIMIT 500`,
    [asInt(pdvId), allowedStatus || null, from || null, to || null]
  );
}

// Roteador do módulo de avarias (devoluções de produto com avaria/vencimento)
export async function handleAvariasRoutes(req, res, context) {
  await ensureAvariaColumns();
  const { method, requireUser, url, user } = context;

  // Serve o binário de uma foto de avaria, validando permissão de acesso antes
  if (url.pathname.startsWith("/api/avarias/fotos/") && method === "GET") {
    const photoId = asInt(url.pathname.split("/").pop());
    if (!photoId) return send(res, 404, { error: "Foto não encontrada." }), true;
    const rows = await query("SELECT * FROM devolucao_avaria_fotos WHERE id = $1 AND deleted_at IS NULL", [photoId]);
    const photo = rows[0];
    if (!photo) return send(res, 404, { error: "Foto não encontrada." }), true;
    const allowed = await tx((client) => userCanAccessPhoto(client, user, photo));
    if (!allowed) return send(res, 403, { error: "Acesso não permitido para esta foto." }), true;
    const file = await getStorageService().readFile(photo.storage_key);
    res.writeHead(200, {
      "Content-Type": photo.mime_type,
      "Cache-Control": "private, max-age=300",
      "Content-Length": file.length
    });
    res.end(file);
    return true;
  }

  // Upload de fotos temporárias (antes da devolução ser criada), vinculadas por draftId+itemTempId
  if (url.pathname === "/api/pdv/avarias/fotos/temp" && method === "POST") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para anexar fotos." }), true;
    const raw = await readRawBody(req);
    const { fields, files } = parseMultipart(req, raw);
    const draftId = normalizeText(fields.draftId, 120);
    const itemTempId = normalizeText(fields.itemTempId, 120);
    if (!draftId || !itemTempId) return send(res, 400, { error: "Rascunho inválido para upload da foto." }), true;
    if (!files.length) return send(res, 400, { error: "Selecione uma foto para enviar." }), true;
    const storage = getStorageService();
    const savedPhotos = [];
    await tx(async (client) => {
      const count = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM devolucao_avaria_fotos
         WHERE draft_id = $1 AND owner_pdv_id = $2 AND deleted_at IS NULL`,
        [`${draftId}:${itemTempId}`, user.pdvId]
      );
      if (asInt(count.rows[0]?.total) + files.length > storage.config.maxImagesPerItem) {
        const error = new Error(`Limite de ${storage.config.maxImagesPerItem} fotos por produto.`);
        error.statusCode = 400;
        throw error;
      }
      for (const file of files) {
        const saved = await storage.saveImage({
          buffer: file.buffer,
          originalName: file.filename,
          folder: `avarias/${user.pdvId}/${draftId}`
        });
        const existing = await client.query(
          `SELECT id
           FROM devolucao_avaria_fotos
           WHERE draft_id = $1 AND owner_pdv_id = $2 AND sha256 = $3 AND deleted_at IS NULL
           LIMIT 1`,
          [`${draftId}:${itemTempId}`, user.pdvId, saved.sha256]
        );
        if (existing.rows[0]) {
          const error = new Error("Esta foto já foi anexada a este produto.");
          error.statusCode = 409;
          throw error;
        }
        const inserted = await client.query(
          `INSERT INTO devolucao_avaria_fotos
             (draft_id, owner_role, owner_name, owner_pdv_id, storage_key, original_name, mime_type,
              size_bytes, width, height, sha256, uploaded_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP + INTERVAL '24 hours')
           RETURNING *`,
          [
            `${draftId}:${itemTempId}`,
            user.role,
            user.name,
            user.pdvId,
            saved.storageKey,
            saved.originalName,
            saved.mimeType,
            saved.sizeBytes,
            saved.width,
            saved.height,
            saved.sha256,
            user.name
          ]
        );
        savedPhotos.push(photoJson(inserted.rows[0], storage));
      }
    });
    return send(res, 201, { ok: true, photos: savedPhotos }), true;
  }

  // Listagem e criação de devoluções de avaria pelo PDV
  if (url.pathname === "/api/pdv/avarias") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para registrar devoluções de avaria." }), true;

    if (method === "GET") {
      const rows = await listDevolucoes({
        pdvId: user.pdvId,
        status: url.searchParams.get("status") || "",
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || ""
      });
      return send(res, 200, { devolucoes: rows }), true;
    }

    if (method === "POST") {
      const body = await readBody(req);
      if (!normalizeIdempotencyKey(req, body)) {
        return send(res, 400, { error: "Identificador da operação ausente. Atualize a página e tente novamente." }), true;
      }
      const itemPayloads = parseItems(body);
      // Fluxo multi-item: uma devolução pode agrupar vários produtos em uma única solicitação
      if (itemPayloads.length) {
        const usuarioSolicitante = normalizeText(body.usuario_solicitante || user.name, 120).toUpperCase();
        if (!usuarioSolicitante) return send(res, 400, { error: "Informe o usuário responsável." }), true;
        if (itemPayloads.length > 30) return send(res, 400, { error: "Limite de 30 produtos por devolução." }), true;

        const normalizedItems = itemPayloads.map((item) => {
          const fotos = parsePhotos(item.fotos);
          const photoIds = Array.isArray(item.photoIds || item.foto_ids)
            ? (item.photoIds || item.foto_ids).map(asInt).filter(Boolean)
            : String(item.photoIds || item.foto_ids || "")
                .split(",")
                .map(asInt)
                .filter(Boolean);
          return {
            sku: normalizeText(item.sku || item.sku_produto || item.produtoId || item.produto_id, 60),
            quantidade: asInt(item.quantidade),
            unidade: normalizeText(item.unidade_medida || item.unidadeMedida || "UN", 30).toUpperCase(),
            motivo: normalizeText(item.motivo, 80),
            outroMotivo: normalizeText(item.outro_motivo, 300),
            dataIdentificacao: normalizeText(item.data_identificacao || item.dataIdentificacao, 20),
            lote: normalizeText(item.lote, 80),
            dataValidade: normalizeText(item.data_validade || item.validade, 20),
            observacao: normalizeText(item.observacao, 700),
            fotos,
            photoIds
          };
        });

        for (const item of normalizedItems) {
          if (!item.sku) return send(res, 400, { error: "Informe o produto em todos os itens." }), true;
          if (item.quantidade <= 0) return send(res, 400, { error: "A quantidade deve ser maior que zero em todos os itens." }), true;
          if (!motivosAvaria.includes(item.motivo)) return send(res, 400, { error: "Informe um motivo válido para todos os itens." }), true;
          if (["Outro motivo", "Outro"].includes(item.motivo) && !item.outroMotivo && !item.observacao) return send(res, 400, { error: "Informe a justificativa para outro motivo." }), true;
          if (!item.dataIdentificacao) return send(res, 400, { error: "Informe a data de identificação da avaria em todos os itens." }), true;
          if (item.motivo === "Produto vencido" && !item.dataValidade) return send(res, 400, { error: "Informe a validade dos produtos vencidos." }), true;
          if (!item.fotos.length && !item.photoIds.length) return send(res, 400, { error: "Anexe ao menos uma foto para cada produto." }), true;
        }
        const uniqueItems = new Set();
        for (const item of normalizedItems) {
          const key = `${item.sku}|${item.lote || ""}|${item.dataValidade || ""}|${item.motivo || ""}`;
          if (uniqueItems.has(key)) {
            return send(res, 409, {
              error: "DUPLICATE_ITEM_IN_RETURN",
              message: "Este produto já foi adicionado nesta devolução."
            }), true;
          }
          uniqueItems.add(key);
        }

        const result = await tx(async (client) => {
          const operation = await beginIdempotentOperation(client, {
            req,
            body,
            user,
            operationType: "pdv_avaria_create"
          });
          if (operation.repeated) {
            return {
              status: operation.responseStatus,
              payload: { ...operation.responseBody, repeated: true }
            };
          }
          // Valida saldo suficiente no PDV para cada produto antes de reservar a devolução
          const totalsBySku = normalizedItems.reduce((acc, item) => {
            acc[item.sku] = (acc[item.sku] || 0) + item.quantidade;
            return acc;
          }, {});
          for (const [sku, requestedQty] of Object.entries(totalsBySku)) {
            const stock = await client.query(
              `SELECT e.quantidade, p.nome
               FROM estoque_pdv e
               JOIN produtos p ON p.sku = e.sku_produto
               WHERE e.pdv_id = $1 AND e.sku_produto = $2 AND e.permitido = TRUE
               FOR UPDATE`,
              [user.pdvId, sku]
            );
            if (!stock.rows[0]) throw new Error("Produto não encontrado no estoque deste PDV.");
            const saldoAtual = asInt(stock.rows[0].quantidade);
            if (saldoAtual < requestedQty) {
              const error = new Error(`Saldo insuficiente para ${stock.rows[0].nome}. Saldo disponível: ${saldoAtual}.`);
              error.statusCode = 400;
              throw error;
            }
          }
          for (const item of normalizedItems) {
            await assertPhotoIdsAvailable(client, { photoIds: item.photoIds, pdvId: user.pdvId });
            await assertNoActiveDuplicate(client, {
              pdvId: user.pdvId,
              sku: item.sku,
              lote: item.lote,
              dataValidade: item.dataValidade,
              usuario: usuarioSolicitante,
              origem: "PDV"
            });
          }

          // A devolução "pai" guarda o primeiro item por compatibilidade; os demais ficam em devolucao_avaria_itens
          const first = normalizedItems[0];
          const totalQuantidade = normalizedItems.reduce((sum, item) => sum + item.quantidade, 0);
          const inserted = await client.query(
            `INSERT INTO devolucoes_avaria
               (codigo_devolucao, pdv_id, sku_produto, quantidade, unidade_medida, motivo, outro_motivo,
                data_identificacao, lote, data_validade, observacao, fotos, usuario_solicitante, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, NULLIF($10, '')::date, $11, $12, $13, 'Aguardando Produto')
             RETURNING id, codigo_devolucao`,
            [
              code("AVR"),
              user.pdvId,
              first.sku,
              totalQuantidade,
              first.unidade || "UN",
              first.motivo,
              first.outroMotivo || null,
              first.dataIdentificacao,
              first.lote || null,
              first.dataValidade || "",
              normalizeText(body.observacao, 700) || first.observacao || null,
              JSON.stringify(first.fotos),
              usuarioSolicitante
            ]
          );
          const devolucao = inserted.rows[0];
          for (const item of normalizedItems) {
            const insertedItem = await client.query(
              `INSERT INTO devolucao_avaria_itens
                 (devolucao_id, sku_produto, quantidade, unidade_medida, motivo, outro_motivo,
                  data_identificacao, lote, data_validade, observacao, fotos, status_item)
               VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, NULLIF($9, '')::date, $10, $11, 'Aguardando Produto')
               RETURNING id`,
              [
                devolucao.id,
                item.sku,
                item.quantidade,
                item.unidade || "UN",
                item.motivo,
                item.outroMotivo || null,
                item.dataIdentificacao,
                item.lote || null,
                item.dataValidade || "",
                item.observacao || null,
                JSON.stringify(item.fotos)
              ]
            );
            if (item.photoIds.length) {
              await client.query(
                `UPDATE devolucao_avaria_fotos
                 SET devolucao_id = $1,
                     item_id = $2,
                     linked_at = CURRENT_TIMESTAMP,
                     expires_at = NULL
                 WHERE id = ANY($3::bigint[])
                   AND owner_pdv_id = $4
                   AND item_id IS NULL
                   AND deleted_at IS NULL`,
                [devolucao.id, insertedItem.rows[0].id, item.photoIds, user.pdvId]
              );
            }
            await audit(client, devolucao.id, {
              usuario: usuarioSolicitante,
              acao: "Inclusão de produto na devolução",
              statusAnterior: null,
              novoStatus: "Aguardando Produto",
              quantidade: item.quantidade,
              observacao: `${item.sku} incluído na devolução. Item ${insertedItem.rows[0].id}. Reserva sem baixa definitiva.`,
              origem: "PDV"
            });
          }
          await audit(client, devolucao.id, {
            usuario: usuarioSolicitante,
            acao: "Criação da devolução",
            statusAnterior: null,
            novoStatus: "Aguardando Produto",
            quantidade: totalQuantidade,
            observacao: "Devolução enviada ao almoxarifado com baixa apenas reservada.",
            origem: "PDV"
          });
          const payload = { ok: true, devolucao };
          await completeIdempotentOperation(client, operation, 201, payload);
          return { status: 201, payload };
        });
        return send(res, result.status, result.payload), true;
      }
      // Fluxo legado de item único (mantido para compatibilidade com clientes antigos)
      const sku = normalizeText(body.sku, 60);
      const quantidade = asInt(body.quantidade);
      const unidade = normalizeText(body.unidade_medida || "UN", 30).toUpperCase();
      const motivo = normalizeText(body.motivo, 80);
      const outroMotivo = normalizeText(body.outro_motivo, 300);
      const dataIdentificacao = normalizeText(body.data_identificacao, 20);
      const lote = normalizeText(body.lote, 80);
      const dataValidade = normalizeText(body.data_validade, 20);
      const observacao = normalizeText(body.observacao, 700);
      const fotos = parsePhotos(body.fotos);
      const photoIds = Array.isArray(body.photoIds || body.foto_ids)
        ? (body.photoIds || body.foto_ids).map(asInt).filter(Boolean)
        : String(body.photoIds || body.foto_ids || "")
            .split(",")
            .map(asInt)
            .filter(Boolean);
      const usuarioSolicitante = normalizeText(body.usuario_solicitante || user.name, 120).toUpperCase();

      if (!sku) return send(res, 400, { error: "Informe o produto." }), true;
      if (quantidade <= 0) return send(res, 400, { error: "A quantidade deve ser maior que zero." }), true;
      if (!motivosAvaria.includes(motivo)) return send(res, 400, { error: "Informe um motivo válido para a avaria." }), true;
      if (motivo === "Outro motivo" && !outroMotivo) return send(res, 400, { error: "Informe a justificativa para outro motivo." }), true;
      if (!dataIdentificacao) return send(res, 400, { error: "Informe a data de identificação da avaria." }), true;
      if (!usuarioSolicitante) return send(res, 400, { error: "Informe o usuário responsável." }), true;

      if (!fotos.length && !photoIds.length) return send(res, 400, { error: "Anexe ao menos uma foto do produto." }), true;

      const result = await tx(async (client) => {
        const operation = await beginIdempotentOperation(client, {
          req,
          body,
          user,
          operationType: "pdv_avaria_create"
        });
        if (operation.repeated) {
          return {
            status: operation.responseStatus,
            payload: { ...operation.responseBody, repeated: true }
          };
        }
        const stock = await client.query(
          `SELECT e.quantidade, p.nome
           FROM estoque_pdv e
           JOIN produtos p ON p.sku = e.sku_produto
           WHERE e.pdv_id = $1 AND e.sku_produto = $2 AND e.permitido = TRUE
           FOR UPDATE`,
          [user.pdvId, sku]
        );
        if (!stock.rows[0]) throw new Error("Produto não encontrado no estoque deste PDV.");
        const saldoAnterior = asInt(stock.rows[0].quantidade);
        const saldoPosterior = saldoAnterior;
        if (saldoAnterior < quantidade) {
          const error = new Error(`Saldo insuficiente. Saldo disponível: ${saldoAnterior}.`);
          error.statusCode = 400;
          throw error;
        }
        await assertNoActiveDuplicate(client, {
          pdvId: user.pdvId,
          sku,
          lote,
          dataValidade,
          usuario: usuarioSolicitante,
          origem: "PDV"
        });
        await assertPhotoIdsAvailable(client, { photoIds, pdvId: user.pdvId });
        const inserted = await client.query(
          `INSERT INTO devolucoes_avaria
             (codigo_devolucao, pdv_id, sku_produto, quantidade, unidade_medida, motivo, outro_motivo,
              data_identificacao, lote, data_validade, observacao, fotos, usuario_solicitante, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, NULLIF($10, '')::date, $11, $12, $13, 'Aguardando Produto')
           RETURNING id, codigo_devolucao`,
          [
            code("AVR"),
            user.pdvId,
            sku,
            quantidade,
            unidade || "UN",
            motivo,
            outroMotivo || null,
            dataIdentificacao,
            lote || null,
            dataValidade || "",
            observacao || null,
            JSON.stringify(fotos),
            usuarioSolicitante
          ]
        );
        const devolucao = inserted.rows[0];
        await client.query("UPDATE devolucoes_avaria SET status = 'Aguardando Produto' WHERE id = $1", [devolucao.id]);
        const insertedItem = await client.query(
           `INSERT INTO devolucao_avaria_itens
             (devolucao_id, sku_produto, quantidade, unidade_medida, motivo, outro_motivo,
              data_identificacao, lote, data_validade, observacao, fotos, status_item)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, NULLIF($9, '')::date, $10, $11, 'Aguardando Produto')
           RETURNING id`,
          [devolucao.id, sku, quantidade, unidade || "UN", motivo, outroMotivo || null, dataIdentificacao, lote || null, dataValidade || "", observacao || null, JSON.stringify(fotos)]
        );
        if (photoIds.length) {
          await client.query(
            `UPDATE devolucao_avaria_fotos
             SET devolucao_id = $1,
                 item_id = $2,
                 linked_at = CURRENT_TIMESTAMP,
                 expires_at = NULL
             WHERE id = ANY($3::bigint[])
               AND owner_pdv_id = $4
               AND item_id IS NULL
               AND deleted_at IS NULL`,
            [devolucao.id, insertedItem.rows[0]?.id, photoIds, user.pdvId]
          );
        }
        await client.query(
          `INSERT INTO estoque_avarias (devolucao_id, pdv_id, sku_produto, quantidade, status)
           VALUES ($1, $2, $3, $4, 'Em análise')
           ON CONFLICT (devolucao_id, sku_produto)
           DO UPDATE SET quantidade = EXCLUDED.quantidade, atualizado_em = CURRENT_TIMESTAMP`,
          [devolucao.id, user.pdvId, sku, quantidade]
        );
        await client.query(
          "UPDATE estoque_avarias SET quantidade = 0, status = 'Reservado', atualizado_em = CURRENT_TIMESTAMP WHERE devolucao_id = $1",
          [devolucao.id]
        );
        await audit(client, devolucao.id, {
          usuario: usuarioSolicitante,
          acao: "Baixa por avaria",
          statusAnterior: null,
          novoStatus: "Aguardando Produto",
          quantidade,
          observacao: `Devolução enviada. Saldo anterior ${saldoAnterior}; saldo posterior ${saldoPosterior}; motivo: ${motivo}.`,
          origem: "PDV"
        });
        const payload = { ok: true, devolucao };
        await completeIdempotentOperation(client, operation, 201, payload);
        return { status: 201, payload };
      });
      return send(res, result.status, result.payload), true;
    }
  }

  // PDV cancela uma devolução ainda não recebida pelo almoxarifado
  if (url.pathname === "/api/pdv/avarias/cancel" && method === "POST") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para cancelar devoluções." }), true;
    const body = await readBody(req);
    const id = asInt(body.id);
    const motivoCancelamento = normalizeText(body.motivo_cancelamento || body.motivo || body.observacao, 700);
    if (!id) return send(res, 400, { error: "Devolução inválida." }), true;
    if (!motivoCancelamento) return send(res, 400, { error: "Informe o motivo do cancelamento." }), true;
    if (!normalizeIdempotencyKey(req, body)) {
      return send(res, 400, { error: "Identificador da operação ausente. Atualize a página e tente novamente." }), true;
    }

    const result = await tx(async (client) => {
      const operation = await beginIdempotentOperation(client, {
        req,
        body,
        user,
        operationType: "pdv_avaria_cancel",
        devolucaoId: id
      });
      if (operation.repeated) {
        return {
          status: operation.responseStatus,
          payload: { ...operation.responseBody, repeated: true }
        };
      }
      const current = await client.query(
        "SELECT * FROM devolucoes_avaria WHERE id = $1 AND pdv_id = $2 FOR UPDATE",
        [id, user.pdvId]
      );
      const row = current.rows[0];
      if (!row) throw new Error("Devolução não encontrada.");
      if (normalizeDamageStatus(row.status) === "Cancelado") {
        const payload = { ok: true };
        await completeIdempotentOperation(client, operation, 200, payload);
        return { status: 200, payload };
      }
      if (!["Aguardando Produto", "Enviar para o Almoxarifado", "Pendente", "Aguardando recebimento físico", "Enviada ao almoxarifado", "Aguardando entrega física", "Aguardando Entrega Física"].includes(row.status)) {
        const error = new Error("Esta devolução não pode mais ser cancelada pelo PDV.");
        error.statusCode = 400;
        throw error;
      }
      // A devolução em aberto apenas reserva a quantidade; cancelamento não soma estoque.
      await client.query("UPDATE estoque_avarias SET quantidade = 0, status = 'Cancelado', atualizado_em = CURRENT_TIMESTAMP WHERE devolucao_id = $1", [id]);
      await client.query("UPDATE devolucao_avaria_itens SET status_item = 'Cancelado', atualizado_em = CURRENT_TIMESTAMP WHERE devolucao_id = $1", [id]);
      await client.query(
        `UPDATE devolucoes_avaria
         SET status = 'Cancelado', cancelado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
      );
      await audit(client, id, {
        usuario: user.name,
        acao: "Cancelamento",
        statusAnterior: row.status,
        novoStatus: "Cancelado",
        quantidade: row.quantidade,
        observacao: motivoCancelamento,
        origem: "PDV"
      });
      const payload = { ok: true };
      await completeIdempotentOperation(client, operation, 200, payload);
      return { status: 200, payload };
    });
    return send(res, result.status, result.payload), true;
  }

  // Listagem administrativa e exclusão de devoluções de avaria
  if (url.pathname === "/api/admin/avarias") {
    if (!requireUser(req, res, "admin")) return true;
    if (method === "DELETE") {
      const body = await readBody(req);
      const id = asInt(body.id);
      const clearStatus = normalizeDamageStatus(normalizeText(body.status || body.clearStatus, 80));
      // Limpeza em massa: só permitida para devoluções já canceladas
      if (body.all || body.clearAll) {
        if (clearStatus !== "Cancelado") {
          return send(res, 400, { error: "A limpeza geral só é permitida para devoluções canceladas." }), true;
        }
        const result = await tx(async (client) => {
          const rows = await client.query(
            "SELECT id FROM devolucoes_avaria WHERE status IN ('Cancelado', 'Cancelada') FOR UPDATE"
          );
          const deleted = await deleteDamageReturns(client, rows.rows.map((row) => row.id));
          return { deleted };
        });
        return send(res, 200, { ok: true, deleted: result.deleted }), true;
      }
      if (!id) return send(res, 400, { error: "Informe a devolução que deve ser excluída." }), true;

      const result = await tx(async (client) => {
        const current = await client.query("SELECT id, status FROM devolucoes_avaria WHERE id = $1 FOR UPDATE", [id]);
        const row = current.rows[0];
        if (!row) {
          const error = new Error("Devolução não encontrada.");
          error.statusCode = 404;
          throw error;
        }
        const normalizedStatus = normalizeDamageStatus(row.status);
        // Só pode excluir individualmente se ainda não avançou no fluxo de aprovação
        if (!["Cancelado", "Aguardando Produto"].includes(normalizedStatus)) {
          const error = new Error("Esta devolução só pode ser excluída nos status Cancelado ou Aguardando Produto.");
          error.statusCode = 400;
          throw error;
        }
        const deleted = await deleteDamageReturns(client, [id]);
        return { deleted };
      });
      return send(res, 200, { ok: true, deleted: result.deleted }), true;
    }
    if (method === "GET") {
      const rows = await listDevolucoes({
        pdvId: asInt(url.searchParams.get("pdvId")),
        status: url.searchParams.get("status") || "",
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || ""
      });
      const summary = rows.reduce((acc, item) => {
        acc.total += asInt(item.quantidade);
        acc.aprovada += asInt(item.quantidade_aprovada);
        acc.recusada += asInt(item.quantidade_recusada);
        acc.pendentes += normalizeDamageStatus(item.status) === "Aguardando Produto" ? 1 : 0;
        acc.falhasIntegracao += item.omie_status === "Falha na integração" ? 1 : 0;
        return acc;
      }, { total: 0, aprovada: 0, recusada: 0, pendentes: 0, falhasIntegracao: 0 });
      return send(res, 200, { devolucoes: rows, summary, statuses: officialAvariaStatuses }), true;
    }
  }

  // Máquina de estados do fluxo de aprovação de avaria: cada `action` representa uma transição
  if (url.pathname === "/api/admin/avarias/flow" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const id = asInt(body.id);
    const action = normalizeText(body.action, 40);
    if (!id) return send(res, 400, { error: "Devolução inválida." }), true;
    if (!normalizeIdempotencyKey(req, body)) {
      return send(res, 400, { error: "Identificador da operação ausente. Atualize a página e tente novamente." }), true;
    }

    const result = await tx(async (client) => {
      const operation = await beginIdempotentOperation(client, {
        req,
        body,
        user,
        operationType: `admin_avaria_${action || "flow"}`,
        devolucaoId: id
      });
      if (operation.repeated) {
        return {
          status: operation.responseStatus,
          payload: { ...operation.responseBody, repeated: true }
        };
      }
      const finish = async (payload = { ok: true }) => {
        await completeIdempotentOperation(client, operation, 200, payload);
        return { status: 200, payload };
      };
      const current = await client.query("SELECT * FROM devolucoes_avaria WHERE id = $1 FOR UPDATE", [id]);
      const row = current.rows[0];
      if (!row) throw new Error("Devolução não encontrada.");
      if (normalizeDamageStatus(row.status) === "Cancelado") {
        await audit(client, id, {
          usuario: user.name,
          acao: "Tentativa de alteração após cancelamento",
          statusAnterior: row.status,
          novoStatus: row.status,
          quantidade: row.quantidade,
          observacao: `Ação bloqueada: ${action}.`,
          origem: "Almoxarifado"
        });
        const error = new Error("Esta solicitação foi cancelada e não pode mais ser alterada.");
        error.statusCode = 400;
        throw error;
      }

      // Troca manual de status (ex: mover para Verificação), exigindo senha admin em casos sensíveis
      if (action === "change_status") {
        const currentStatus = normalizeDamageStatus(row.status);
        const nextStatus = normalizeDamageStatus(normalizeText(body.status, 80));
        const allowedNextStatuses = statusTransitionOptions(currentStatus);
        if (!officialAvariaStatuses.includes(nextStatus) || !allowedNextStatuses.includes(nextStatus) || nextStatus === "Finalizado") {
          const error = new Error("Esta alteração de status não é permitida para a devolução.");
          error.statusCode = 400;
          throw error;
        }
        const reason = normalizeText(body.motivo_estorno || body.motivo_divergencia || body.observacao_interna, 700);
        if ((nextStatus === "Recusado" || nextStatus === "Verificação" || currentStatus === "Verificação") && !reason) {
          const error = new Error("Informe a justificativa para alterar o status da devolução.");
          error.statusCode = 400;
          throw error;
        }
        if (["Finalizado", "Recusado", "Verificação"].includes(currentStatus) || nextStatus === "Verificação") {
          await requireAdminPassword(client, id, normalizeText(body.adminPassword, 160), user.name, `Alteração de status ${currentStatus} para ${nextStatus}`);
        }
        if (nextStatus === "Recusado") {
          const itemRows = await client.query("SELECT id, quantidade FROM devolucao_avaria_itens WHERE devolucao_id = $1 FOR UPDATE", [id]);
          for (const item of itemRows.rows) {
            await client.query(
              `UPDATE devolucao_avaria_itens
               SET quantidade_aprovada = 0,
                   quantidade_recusada = quantidade,
                   motivo_divergencia = COALESCE($2, motivo_divergencia),
                   observacao_interna = COALESCE($2, observacao_interna),
                   status_item = 'Aguardando retirada pelo ponto',
                   atualizado_em = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [item.id, reason]
            );
          }
          await client.query(
            `UPDATE devolucoes_avaria
             SET status = 'Recusado',
                 quantidade_aprovada = 0,
                 quantidade_recusada = COALESCE(NULLIF(total_itens.total, 0), quantidade),
                 motivo_divergencia = $2,
                 observacao_interna = COALESCE($3, observacao_interna),
                 atualizado_em = CURRENT_TIMESTAMP,
                 verificado = COALESCE(verificado, FALSE) OR $4::boolean
             FROM (SELECT COALESCE(SUM(quantidade), 0) AS total FROM devolucao_avaria_itens WHERE devolucao_id = $1) total_itens
             WHERE devolucoes_avaria.id = $1`,
            [id, reason, normalizeText(body.observacao_interna, 700) || reason, currentStatus === "Verificação"]
          );
          await audit(client, id, {
            usuario: user.name,
            acao: "Recusa da devolução",
            statusAnterior: row.status,
            novoStatus: "Recusado",
            quantidade: row.quantidade,
            observacao: reason,
            origem: "Almoxarifado"
          });
          return finish();
        }
        const verifiedReturn = nextStatus === "Verificação";
        await client.query(
          `UPDATE devolucoes_avaria
           SET status = $2,
               verificado = COALESCE(verificado, FALSE) OR $3::boolean,
               estornado_em = CASE WHEN $3::boolean THEN CURRENT_TIMESTAMP ELSE estornado_em END,
               estornado_por = CASE WHEN $3::boolean THEN $4 ELSE estornado_por END,
               motivo_estorno = CASE WHEN $3::boolean THEN $5 ELSE motivo_estorno END,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [
            id,
            nextStatus,
            verifiedReturn,
            user.name || "Almoxarifado",
            reason || "Alteração manual para verificação."
          ]
        );
        await audit(client, id, {
          usuario: user.name,
          acao: "Alteracao manual de status",
          statusAnterior: row.status,
          novoStatus: nextStatus,
          quantidade: row.quantidade_aprovada || row.quantidade,
          observacao: reason || (verifiedReturn ? "Senha do admin confirmada para retorno a verificação." : "Status alterado pelo almoxarifado."),
          origem: "Almoxarifado"
        });
        return finish();
      }

      // Ações desativadas: o recebimento físico agora exige assinatura via ação "receive"
      if (action === "start_receiving" || action === "awaiting") {
        const error = new Error("Use a coleta de assinatura para mover a devolução para Em Aprovação.");
        error.statusCode = 400;
        throw error;
      }

      // Confirma o recebimento físico do produto no almoxarifado, com assinatura do responsável
      if (action === "receive") {
        const currentStatus = normalizeDamageStatus(row.status);
        const recebida = asInt(body.quantidade_recebida);
        const responsavel = normalizeText(body.responsavel_entrega_nome, 160).toUpperCase();
        const documento = normalizeText(body.responsavel_entrega_documento, 80);
        const cargo = normalizeText(body.responsavel_entrega_cargo, 120);
        const entregaEm = normalizeText(body.entrega_em, 40);
        const assinatura = String(body.assinatura_imagem || "");
        if (!["Aguardando Produto", "Em Aprovação"].includes(currentStatus)) {
          throw new Error("Esta devolução não pode confirmar recebimento físico neste status.");
        }
        if (!responsavel) {
          const error = new Error("Informe o nome completo do responsável pelo ponto.");
          error.statusCode = 400;
          throw error;
        }
        if (recebida <= 0) {
          const error = new Error("Informe a quantidade recebida na entrega física.");
          error.statusCode = 400;
          throw error;
        }
        await client.query(
          `UPDATE devolucoes_avaria
           SET status = 'Em Aprovação',
               quantidade_recebida = $2,
               responsavel_entrega_nome = $3,
               responsavel_entrega_documento = $4,
               responsavel_entrega_cargo = $5,
               entrega_em = COALESCE(NULLIF($6, '')::timestamp, CURRENT_TIMESTAMP),
               assinatura_imagem = NULLIF($7, ''),
               assinatura_confirmada_em = CASE WHEN NULLIF($7, '') IS NULL THEN assinatura_confirmada_em ELSE CURRENT_TIMESTAMP END,
               recebido_por_usuario = $8,
               recebido_sessao = $9,
               recebido_ip = $10,
               recebido_em = CURRENT_TIMESTAMP,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [
            id,
            recebida,
            responsavel,
            documento || null,
            cargo || null,
            entregaEm || "",
            assinatura,
            user.name || "Almoxarifado",
            normalizeText(body.recebido_sessao, 160) || req.headers["user-agent"] || "Sessão do navegador",
            normalizeText(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "", 120) || null
          ]
        );
        await audit(client, id, {
          usuario: user.name,
          acao: assinatura ? "Recebimento físico assinado" : "Recebimento físico",
          statusAnterior: row.status,
          novoStatus: "Em Aprovação",
          quantidade: recebida,
          observacao: assinatura ? `Responsável: ${responsavel}. Assinatura coletada no dispositivo do almoxarifado.` : `Responsável: ${responsavel}. Recebimento confirmado sem assinatura.`,
          origem: "Almoxarifado"
        });
        return finish();
      }

      // Conferência do almoxarifado: aprova/recusa quantidades por item (ou recusa tudo de uma vez)
      if (action === "conference" || action === "refuse") {
        const currentStatus = normalizeDamageStatus(row.status);
        const recebida = asInt(row.quantidade_recebida);
        const aprovada = action === "refuse" ? 0 : asInt(body.quantidade_aprovada);
        const recusada = action === "refuse" ? asInt(row.quantidade) : asInt(body.quantidade_recusada);
        const justificativa = normalizeText(body.motivo_divergencia, 500);
        const observacaoInterna = normalizeText(body.observacao_interna, 700);
        const totalConferido = aprovada + recusada;
        const hasDivergence = action === "refuse" || recebida !== asInt(row.quantidade) || aprovada !== asInt(row.quantidade) || recusada > 0;

        if (!["Em Aprovação", "Aprovação Parcial", "Verificação"].includes(currentStatus)) {
          const error = new Error(currentStatus === "Aguardando Produto"
            ? "Confirme o recebimento dos produtos antes de iniciar a conferência."
            : "Esta devolução ainda não está disponível para conferência.");
          error.statusCode = 400;
          throw error;
        }
        const conferenceItems = parseItems(body);
        // Conferência por item (multi-produto): cada item recebe sua própria decisão de aprovação/recusa
        if (conferenceItems.length) {
          const existing = await client.query("SELECT * FROM devolucao_avaria_itens WHERE devolucao_id = $1 ORDER BY id FOR UPDATE", [id]);
          const existingById = new Map(existing.rows.map((item) => [String(item.id), item]));
          let totalApproved = 0;
          let totalRefused = 0;
          let hasPendingItem = false;
          let hasConcludedItem = false;
          for (const payloadItem of conferenceItems) {
            const currentItem = existingById.get(String(payloadItem.id));
            if (!currentItem) continue;
            const itemApproved = action === "refuse" ? 0 : asInt(payloadItem.quantidade_aprovada);
            const itemRefused = action === "refuse" ? asInt(currentItem.quantidade) : asInt(payloadItem.quantidade_recusada);
            const itemTotal = itemApproved + itemRefused;
            const itemJustification = normalizeText(payloadItem.motivo_divergencia, 500) || justificativa;
            const itemObservation = normalizeText(payloadItem.observacao_interna, 700);
            if (itemApproved < 0 || itemRefused < 0 || itemApproved + itemRefused > asInt(currentItem.quantidade)) {
              const error = new Error("As quantidades conferidas por produto são inválidas.");
              error.statusCode = 400;
              throw error;
            }
            if (itemTotal > 0 && (action === "refuse" || itemRefused > 0 || itemApproved < asInt(currentItem.quantidade)) && !itemJustification) {
              const error = new Error("Informe a justificativa para todo item recusado ou parcial.");
              error.statusCode = 400;
              throw error;
            }
            const itemStatus = itemTotal <= 0
              ? "Pendente"
              : itemRefused > 0 && itemApproved > 0
              ? "Parcial"
              : itemRefused > 0
                ? "Aguardando retirada pelo ponto"
                : "Aprovado";
            await client.query(
              `UPDATE devolucao_avaria_itens
               SET quantidade_recebida = quantidade,
                   quantidade_aprovada = $2,
                   quantidade_recusada = $3,
                   motivo_divergencia = $4,
                   observacao_interna = $5,
                   status_item = $6,
                   atualizado_em = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [currentItem.id, itemApproved, itemRefused, itemJustification || null, itemObservation || null, itemStatus]
            );
            totalApproved += itemApproved;
            totalRefused += itemRefused;
            if (itemTotal <= 0 || itemTotal < asInt(currentItem.quantidade)) hasPendingItem = true;
            if (itemTotal > 0) hasConcludedItem = true;
            await audit(client, id, {
              usuario: user.name,
              acao: itemRefused > 0 ? "Recusa de item" : "Aprovação de item",
              statusAnterior: currentItem.status_item,
              novoStatus: itemStatus,
              quantidade: itemApproved || itemRefused,
              observacao: `${currentItem.sku_produto}: ${itemJustification || itemObservation || "Conferência registrada."}`,
              origem: "Almoxarifado"
            });
          }
          const totalRequested = existing.rows.reduce((sum, item) => sum + asInt(item.quantidade), 0);
          const nextStatus = hasPendingItem && hasConcludedItem
            ? "Aprovação Parcial"
            : totalApproved <= 0 && totalRefused > 0 && !hasPendingItem
              ? "Recusado"
              : totalApproved > 0 && totalRefused > 0
                ? "Aprovação Parcial"
                : "Em Aprovação";
          await client.query(
            `UPDATE devolucoes_avaria
             SET status = $2, quantidade_recebida = $3, quantidade_aprovada = $4, quantidade_recusada = $5,
                 motivo_divergencia = $6, observacao_interna = $7, recebido_em = CURRENT_TIMESTAMP,
                 atualizado_em = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id, nextStatus, totalRequested, totalApproved, totalRefused, justificativa || null, observacaoInterna || null]
          );
          await audit(client, id, {
            usuario: user.name,
            acao: "Conferência por item",
            statusAnterior: row.status,
            novoStatus: nextStatus,
            quantidade: totalApproved,
            observacao: totalRefused > 0 ? "Há itens recusados nesta devolução." : "Itens conferidos para decisão final.",
            origem: "Almoxarifado"
          });
          return finish();
        }
        if (action !== "refuse" && (aprovada < 0 || recusada < 0 || totalConferido > asInt(row.quantidade))) {
          const error = new Error("As quantidades conferidas são inválidas.");
          error.statusCode = 400;
          throw error;
        }
        if (hasDivergence && !justificativa) {
          const error = new Error("Informe a justificativa para divergência, recebimento parcial ou recusa.");
          error.statusCode = 400;
          throw error;
        }

        const nextStatus = action === "refuse"
          ? "Recusado"
          : aprovada > 0 && recusada > 0
            ? "Aprovação Parcial"
            : aprovada <= 0 && recusada > 0
              ? "Recusado"
              : "Em Aprovação";
        await client.query(
          `UPDATE devolucoes_avaria
           SET status = $2, quantidade_recebida = $3, quantidade_aprovada = $4, quantidade_recusada = $5,
               motivo_divergencia = $6, observacao_interna = $7, recebido_em = CURRENT_TIMESTAMP,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, nextStatus, recebida, aprovada, recusada, justificativa || null, observacaoInterna || null]
        );
        await client.query(
          `UPDATE estoque_avarias
           SET quantidade = $2, status = $3, atualizado_em = CURRENT_TIMESTAMP
           WHERE devolucao_id = $1`,
          [id, aprovada, nextStatus]
        );
        await audit(client, id, {
          usuario: user.name,
          acao: action === "refuse" ? "Recusa" : "Conferência",
          statusAnterior: row.status,
          novoStatus: nextStatus,
          quantidade: aprovada,
          observacao: justificativa || observacaoInterna,
          origem: "Almoxarifado"
        });
        return finish();
      }

      // Confirma, com assinatura, a devolução física ao PDV de um item recusado (sem baixa de estoque)
      if (action === "withdraw_refused") {
        const itemId = asInt(body.itemId);
        const responsavel = normalizeText(body.retirada_responsavel, 160).toUpperCase();
        const assinatura = String(body.retirada_assinatura || "");
        if (!itemId) {
          const error = new Error("Informe o item recusado para confirmar a retirada.");
          error.statusCode = 400;
          throw error;
        }
        if (!responsavel) {
          const error = new Error("Informe o responsável pela retirada.");
          error.statusCode = 400;
          throw error;
        }
        if (!assinatura || !assinatura.startsWith("data:image/")) {
          const error = new Error("Colete a assinatura do responsável pela retirada.");
          error.statusCode = 400;
          throw error;
        }
        const itemResult = await client.query("SELECT * FROM devolucao_avaria_itens WHERE id = $1 AND devolucao_id = $2 FOR UPDATE", [itemId, id]);
        const item = itemResult.rows[0];
        if (!item || asInt(item.quantidade_recusada) <= 0) {
          const error = new Error("Item recusado não encontrado.");
          error.statusCode = 400;
          throw error;
        }
        if (item.retirada_confirmada) {
          const error = new Error("Este item já foi confirmado como devolvido ao ponto.");
          error.statusCode = 400;
          throw error;
        }
        await client.query(
          `UPDATE devolucao_avaria_itens
           SET retirada_responsavel = $2,
               retirada_assinatura = $3,
               retirada_em = CURRENT_TIMESTAMP,
               retirada_usuario_almoxarifado = $4,
               retirada_confirmada = TRUE,
               status_item = CASE WHEN quantidade_aprovada > 0 THEN 'Parcial' ELSE 'Recusado' END,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [itemId, responsavel, assinatura, user.name || "Almoxarifado"]
        );
        await audit(client, id, {
          usuario: user.name,
          acao: "Retirada pelo PDV",
          statusAnterior: item.status_item,
          novoStatus: asInt(item.quantidade_aprovada) > 0 ? "Parcial" : "Recusado",
          quantidade: item.quantidade_recusada,
          observacao: `${item.sku_produto}: retirada assinada por ${responsavel}. Produto recusado devolvido fisicamente ao ponto, sem baixa de estoque.`,
          origem: "Almoxarifado"
        });
        return finish();
      }

      // Mesmo fluxo de devolução física ao PDV, mas para todos os itens recusados pendentes de uma vez
      if (action === "withdraw_refused_all") {
        const responsavel = normalizeText(body.retirada_responsavel, 160).toUpperCase();
        const assinatura = String(body.retirada_assinatura || "");
        if (!responsavel) {
          const error = new Error("Informe o responsável pela devolução ao ponto.");
          error.statusCode = 400;
          throw error;
        }
        if (!assinatura || !assinatura.startsWith("data:image/")) {
          const error = new Error("Colete a assinatura do responsável pela retirada.");
          error.statusCode = 400;
          throw error;
        }
        const itemsResult = await client.query(
          `SELECT * FROM devolucao_avaria_itens
           WHERE devolucao_id = $1
             AND quantidade_recusada > 0
             AND COALESCE(retirada_confirmada, FALSE) = FALSE
           FOR UPDATE`,
          [id]
        );
        if (!itemsResult.rows.length) {
          const error = new Error("Não há produtos recusados pendentes de devolução ao ponto.");
          error.statusCode = 400;
          throw error;
        }
        for (const item of itemsResult.rows) {
          await client.query(
            `UPDATE devolucao_avaria_itens
             SET retirada_responsavel = $2,
                 retirada_assinatura = $3,
                 retirada_em = CURRENT_TIMESTAMP,
                 retirada_usuario_almoxarifado = $4,
                 retirada_confirmada = TRUE,
                 status_item = CASE WHEN quantidade_aprovada > 0 THEN 'Parcial' ELSE 'Recusado' END,
                 atualizado_em = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [item.id, responsavel, assinatura, user.name || "Almoxarifado"]
          );
        }
        await audit(client, id, {
          usuario: user.name,
          acao: "Devolução ao ponto",
          statusAnterior: row.status,
          novoStatus: row.status,
          quantidade: itemsResult.rows.reduce((sum, item) => sum + asInt(item.quantidade_recusada), 0),
          observacao: `Produtos recusados devolvidos fisicamente ao ponto com assinatura de ${responsavel}, sem baixa de estoque.`,
          origem: "Almoxarifado"
        });
        return finish();
      }

      // Finaliza a devolução: dá baixa definitiva no estoque do PDV pela quantidade aprovada
      // (integração com o OMIE está desativada nesta etapa, a baixa é só manual/local)
      if (action === "finalize" || action === "reprocess") {
        const currentStatus = normalizeDamageStatus(row.status);
        if (!["Em Aprovação", "Aprovação Parcial", "Verificação"].includes(currentStatus) && !["Aprovada", "Aprovada parcialmente", "Aguardando integração com o OMIE"].includes(row.status)) {
          throw new Error("Somente devoluções em aprovação ou verificação podem ser finalizadas.");
        }
        if (currentStatus === "Verificação") {
          await requireAdminPassword(client, id, normalizeText(body.adminPassword, 160), user.name, "Finalização de devolução em verificação");
        }
        const aprovado = asInt(row.quantidade_aprovada);
        if (aprovado <= 0) throw new Error("Não há quantidade aprovada para finalizar como avaria.");
        const itemRows = await client.query("SELECT * FROM devolucao_avaria_itens WHERE devolucao_id = $1 ORDER BY id FOR UPDATE", [id]);
        // Finalização por item: cada item já decidido dá baixa apenas do delta ainda não processado
        if (itemRows.rows.length) {
          const pendingAnalysis = itemRows.rows.filter((item) => {
            const requested = asInt(item.quantidade);
            const decided = asInt(item.quantidade_aprovada) + asInt(item.quantidade_recusada);
            return decided < requested;
          });
          if (pendingAnalysis.length) {
            const error = new Error("Existem produtos sem decisão completa. Aprove ou recuse toda a quantidade antes de finalizar.");
            error.statusCode = 400;
            throw error;
          }
          let processedDelta = 0;
          let processedTotal = 0;
          for (const item of itemRows.rows) {
            const itemApproved = asInt(item.quantidade_aprovada);
            const itemAlreadyProcessed = asInt(item.manual_quantidade_processada ?? item.omie_quantidade_processada);
            const itemDelta = itemApproved - itemAlreadyProcessed;
            processedTotal += itemApproved;
            if (itemDelta <= 0) continue;
            const stock = await client.query(
              `SELECT quantidade
               FROM estoque_pdv
               WHERE pdv_id = $1 AND sku_produto = $2
               FOR UPDATE`,
              [row.pdv_id, item.sku_produto]
            );
            const saldoAtual = asInt(stock.rows[0]?.quantidade);
            if (!stock.rows[0] || saldoAtual < itemDelta) {
              const error = new Error(`Saldo insuficiente no PDV para finalizar a avaria do produto ${item.sku_produto}. Saldo disponível: ${saldoAtual}.`);
              error.statusCode = 400;
              throw error;
            }
            await client.query(
              `UPDATE estoque_pdv SET quantidade = quantidade - $3 WHERE pdv_id = $1 AND sku_produto = $2`,
              [row.pdv_id, item.sku_produto, itemDelta]
            );
            await client.query(
              `UPDATE devolucao_avaria_itens
               SET manual_quantidade_processada = $2,
                   movimento_manual_status = 'Finalizado',
                   omie_quantidade_processada = $2,
                   status_item = CASE
                     WHEN quantidade_recusada > 0 THEN 'Parcial'
                     ELSE 'Finalizado'
                   END,
                   atualizado_em = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [item.id, itemApproved]
            );
            await client.query(
              `INSERT INTO estoque_avarias (devolucao_id, pdv_id, sku_produto, quantidade, status)
               VALUES ($1, $2, $3, 0, 'Finalizado')
               ON CONFLICT (devolucao_id, sku_produto)
               DO UPDATE SET quantidade = 0, status = 'Finalizado', atualizado_em = CURRENT_TIMESTAMP`,
              [id, row.pdv_id, item.sku_produto]
            );
            processedDelta += itemDelta;
            await audit(client, id, {
              usuario: user.name,
              acao: "Baixa definitiva de item",
              statusAnterior: item.status_item,
              novoStatus: "Finalizado",
              quantidade: itemDelta,
              observacao: `${item.sku_produto}: baixa definitiva por avaria. Não contabilizado como venda.`,
              origem: "Almoxarifado"
            });
          }
          await client.query(
            `UPDATE devolucoes_avaria
             SET status = 'Finalizado',
                 omie_status = $2,
                 omie_request_id = NULL,
                 omie_response = $3,
                 omie_error = $6,
                 omie_quantidade_processada = $4,
                 manual_quantidade_processada = $4,
                 movimento_manual_status = 'Finalizado',
                 finalizado_em = CURRENT_TIMESTAMP,
                 atualizado_em = CURRENT_TIMESTAMP,
                 verificado = COALESCE(verificado, FALSE) OR $5::boolean
             WHERE id = $1`,
            [
              id,
              OMIE_DISABLED_STATUS,
              JSON.stringify({ tipo: "baixa_avaria_manual", codigo_devolucao: row.codigo_devolucao, quantidade_aprovada: aprovado, delta: processedDelta, itens: itemRows.rows.length }),
              processedTotal,
              currentStatus === "Verificação",
              "Integração OMIE desativada nesta etapa. Baixa manual por avaria registrada no estoque do PDV."
            ]
          );
          await audit(client, id, {
            usuario: user.name,
            acao: "Finalização da devolução",
            statusAnterior: row.status,
            novoStatus: "Finalizado",
            quantidade: processedDelta,
            observacao: "Baixa manual por avaria registrada no estoque do PDV. Integração OMIE desativada nesta etapa.",
            origem: "Almoxarifado"
          });
          return finish();
        }
        // Fluxo legado de item único: calcula o delta ainda não baixado para evitar dupla baixa
        const alreadyProcessed = asInt(row.manual_quantidade_processada ?? row.omie_quantidade_processada);
        const delta = aprovado - alreadyProcessed;
        if (currentStatus !== "Verificação" && normalizeDamageStatus(row.status) === "Finalizado") {
          await audit(client, id, {
            usuario: user.name,
            acao: "Tentativa duplicada de finalização",
            statusAnterior: row.status,
            novoStatus: row.status,
            quantidade: aprovado,
            observacao: "Finalização ignorada por idempotência.",
            origem: "Almoxarifado"
          });
          return finish();
        }
        if (delta !== 0) {
          const stock = await client.query(
            `SELECT quantidade
             FROM estoque_pdv
             WHERE pdv_id = $1 AND sku_produto = $2
             FOR UPDATE`,
            [row.pdv_id, row.sku_produto]
          );
          const saldoAtual = asInt(stock.rows[0]?.quantidade);
          if (!stock.rows[0] || saldoAtual < delta) {
            const error = new Error(`Saldo insuficiente no PDV para finalizar a avaria. Saldo disponível: ${saldoAtual}.`);
            error.statusCode = 400;
            throw error;
          }
          await client.query(
            `UPDATE estoque_pdv SET quantidade = quantidade - $3 WHERE pdv_id = $1 AND sku_produto = $2`,
            [row.pdv_id, row.sku_produto, delta]
          );
        }
        await client.query(
          `UPDATE estoque_avarias
           SET quantidade = GREATEST(0, quantidade - $2), status = 'Finalizado', atualizado_em = CURRENT_TIMESTAMP
           WHERE devolucao_id = $1`,
          [id, Math.max(delta, 0)]
        );
        await client.query(
          `UPDATE devolucoes_avaria
           SET status = 'Finalizado',
               omie_status = $2,
               omie_request_id = NULL,
               omie_response = $3,
               omie_error = $6,
               omie_quantidade_processada = $4,
               manual_quantidade_processada = $4,
               movimento_manual_status = 'Finalizado',
               finalizado_em = CURRENT_TIMESTAMP,
               atualizado_em = CURRENT_TIMESTAMP,
               verificado = COALESCE(verificado, FALSE) OR $5::boolean
           WHERE id = $1`,
          [
            id,
            OMIE_DISABLED_STATUS,
            JSON.stringify({ tipo: "baixa_avaria_manual", codigo_devolucao: row.codigo_devolucao, quantidade_aprovada: aprovado, delta }),
            aprovado,
            currentStatus === "Verificação",
            "Integração OMIE desativada nesta etapa. Baixa manual por avaria registrada no estoque do PDV."
          ]
        );
        await audit(client, id, {
          usuario: user.name,
          acao: "Saída por avaria",
          statusAnterior: row.status,
          novoStatus: "Finalizado",
          quantidade: delta,
          observacao: "Baixa manual por avaria registrada. Não contabilizado como venda. Integração OMIE desativada nesta etapa.",
          origem: "Almoxarifado"
        });
        return finish();
      }

      // Estorna uma devolução finalizada/recusada de volta para Verificação (exige senha admin)
      if (action === "reverse_to_verification") {
        const reason = normalizeText(body.motivo_estorno, 700);
        if (!["Finalizado", "Recusado"].includes(normalizeDamageStatus(row.status))) throw new Error("Somente devoluções finalizadas ou recusadas podem ser enviadas para verificação.");
        if (!reason) {
          const error = new Error("Informe o motivo do estorno para continuar.");
          error.statusCode = 400;
          throw error;
        }
        const adminPassword = normalizeText(body.adminPassword, 160);
        const config = await client.query("SELECT valor FROM configuracoes WHERE chave = 'senha_almoxarifado'");
        if (!adminPassword || !config.rows[0] || !verifyPassword(adminPassword, config.rows[0].valor)) {
          const error = new Error("Senha do admin incorreta.");
          error.statusCode = 401;
          throw error;
        }
        await client.query(
          `UPDATE devolucoes_avaria
           SET status = 'Verificação',
               verificado = TRUE,
               estornado_em = CURRENT_TIMESTAMP,
               estornado_por = $2,
               motivo_estorno = $3,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, user.name || "Almoxarifado", reason]
        );
        await audit(client, id, {
          usuario: user.name,
          acao: "Estorno para verificação",
          statusAnterior: row.status,
          novoStatus: "Verificação",
          quantidade: row.quantidade_aprovada,
          observacao: reason,
          origem: "Almoxarifado"
        });
        return finish();
      }

      throw new Error("Ação inválida para devolução de avaria.");
    });

    return send(res, result.status, result.payload), true;
  }

  return false;
}




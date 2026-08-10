import { priorityRank } from "../integration.service.js";
import { decryptSecret } from "../integration.security.js";
import { syncOmieProducts } from "./omie.products.js";

export const SYNC_OMIE_PRODUCTS = "SYNC_OMIE_PRODUCTS";
export const SYNC_OMIE_LOCATIONS = "SYNC_OMIE_LOCATIONS";
export const SYNC_OMIE_STOCK = "SYNC_OMIE_STOCK";
export const SYNC_OMIE_STOCK_ITEM = "SYNC_OMIE_STOCK_ITEM";
export const SYNC_OMIE_MOVEMENTS = "SYNC_OMIE_MOVEMENTS";
export const RECONCILE_OMIE_STOCK = "RECONCILE_OMIE_STOCK";
export const SYNC_OMIE_FULL = "SYNC_OMIE_FULL";

// Traduz um escopo de sincronizacao em texto livre (PT/EN) para o tipo de job interno
export function normalizeSyncScope(scope) {
  const value = String(scope || "").trim().toLowerCase();
  if (["produtos", "products"].includes(value)) return SYNC_OMIE_PRODUCTS;
  if (["locais", "locations"].includes(value)) return SYNC_OMIE_LOCATIONS;
  if (["saldos", "saldo", "stock"].includes(value)) return SYNC_OMIE_STOCK;
  if (["saldo_item", "stock_item", "item"].includes(value)) return SYNC_OMIE_STOCK_ITEM;
  if (["movimentos", "movements"].includes(value)) return SYNC_OMIE_MOVEMENTS;
  if (value.includes("reconcilia")) return RECONCILE_OMIE_STOCK;
  return SYNC_OMIE_FULL;
}

// Enfileira um job de integracao, evitando duplicar um job equivalente ja pendente/em processamento
export async function enqueueIntegrationJob(client, {
  integrationId,
  jobType,
  payload = {},
  priority = "NORMAL",
  scheduledFor = null
}) {
  const normalizedType = normalizeSyncScope(jobType);
  const rank = priorityRank(priority);
  // Evita duplicar job identico ainda nao concluido
  const existing = await client.query(
    `SELECT *
     FROM integration_jobs
     WHERE integration_id = $1
       AND job_type = $2
       AND payload = $3::jsonb
       AND status IN ('PENDENTE', 'PROCESSANDO', 'REPROCESSAMENTO', 'ERRO_TEMPORARIO', 'AGUARDANDO_REPROCESSAMENTO')
     ORDER BY created_at DESC
     LIMIT 1`,
    [integrationId, normalizedType, JSON.stringify(payload)]
  );
  if (existing.rows[0]) return existing.rows[0];

  let result;
  try {
    result = await client.query(
      `INSERT INTO integration_jobs (integration_id, job_type, payload, priority, priority_rank, status, scheduled_for)
       VALUES ($1, $2, $3::jsonb, $4, $5, 'PENDENTE', COALESCE($6, CURRENT_TIMESTAMP))
       RETURNING *`,
      [integrationId, normalizedType, JSON.stringify(payload), priority, rank, scheduledFor]
    );
  } catch (error) {
    // Compatibilidade: banco sem a coluna scheduled_for ainda migrada, insere sem ela
    if (!String(error.message || "").includes("scheduled_for")) throw error;
    result = await client.query(
      `INSERT INTO integration_jobs (integration_id, job_type, payload, priority, priority_rank, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, 'PENDENTE')
       RETURNING *`,
      [integrationId, normalizedType, JSON.stringify(payload), priority, rank]
    );
  }
  return result.rows[0];
}

// Enfileira uma atualizacao pontual e prioritaria de saldo para um unico produto
export async function enqueueStockRefresh(client, { integrationId, productExternalId, productSku }) {
  return enqueueIntegrationJob(client, {
    integrationId,
    jobType: SYNC_OMIE_STOCK_ITEM,
    payload: { productExternalId, productSku, lista_produtos: [productExternalId || productSku].filter(Boolean) },
    priority: "ALTA"
  });
}

// Pega o proximo job elegivel da fila (por prioridade) e o processa; usa SKIP LOCKED para
// permitir multiplos workers concorrentes sem disputar o mesmo job
export async function processNextIntegrationJob(client) {
  const result = await client.query(
    `SELECT *
     FROM integration_jobs
     WHERE status IN ('PENDENTE', 'REPROCESSAMENTO', 'ERRO_TEMPORARIO', 'AGUARDANDO_REPROCESSAMENTO')
     ORDER BY priority_rank DESC, created_at
     LIMIT 1
     FOR UPDATE SKIP LOCKED`
  );
  const job = result.rows[0];
  if (!job) return null;
  await markIntegrationJobProcessing(client, job.id);
  try {
    const processed = await processIntegrationJob(client, job);
    await markSyncStateSuccess(client, job.integration_id, job.job_type);
    await markIntegrationSuccess(client, job.integration_id);
    const status = getCompletedJobStatus(processed.result);
    await markIntegrationJobCompleted(client, job.id, processed.result, status);
    return { ...job, status, result: processed.result };
  } catch (error) {
    await markIntegrationJobFailed(client, job.id, error);
    const failed = await getIntegrationJobById(client, job.id);
    return failed || { ...job, status: "ERRO_TEMPORARIO", last_error: safeErrorMessage(error) };
  }
}

// Mesmo fluxo de processNextIntegrationJob, mas para reprocessar um job especifico por id
export async function processIntegrationJobById(client, id) {
  const result = await client.query(
    `SELECT *
     FROM integration_jobs
     WHERE id = $1
       AND status NOT IN ('CONCLUIDO', 'SUCCESS')
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [id]
  );
  const job = result.rows[0];
  if (!job) return null;
  await markIntegrationJobProcessing(client, job.id);
  try {
    const processed = await processIntegrationJob(client, job);
    await markSyncStateSuccess(client, job.integration_id, job.job_type);
    await markIntegrationSuccess(client, job.integration_id);
    const status = getCompletedJobStatus(processed.result);
    await markIntegrationJobCompleted(client, job.id, processed.result, status);
    return { ...job, status, result: processed.result };
  } catch (error) {
    await markIntegrationJobFailed(client, job.id, error);
    const failed = await getIntegrationJobById(client, job.id);
    return failed || { ...job, status: "ERRO_TEMPORARIO", last_error: safeErrorMessage(error) };
  }
}

// Executa o job de acordo com o tipo; produtos re-enfileira automaticamente a proxima pagina
async function processIntegrationJob(client, job) {
  const loaded = await loadIntegrationWithSecrets(client, job.integration_id);
  const payload = job.payload || {};

  if (job.job_type === SYNC_OMIE_PRODUCTS || job.job_type === SYNC_OMIE_FULL) {
    const result = await syncOmieProducts(client, { loaded, payload });
    if (result.next_page) {
      // Ainda ha paginas restantes: agenda a continuacao como novo job
      await enqueueIntegrationJob(client, {
        integrationId: job.integration_id,
        jobType: SYNC_OMIE_PRODUCTS,
        payload: { ...payload, pageStart: result.next_page },
        priority: job.priority || "NORMAL"
      });
    }
    return { result };
  }

  return {
    result: {
      pages: 0,
      received: 0,
      created: 0,
      updated: 0,
      ignored: 0,
      message: "Processamento real deste escopo ainda nao foi habilitado nesta etapa."
    }
  };
}

// Carrega a integracao e descriptografa suas credenciais para uso na chamada OMIE
async function loadIntegrationWithSecrets(client, integrationId) {
  const integrationResult = await client.query("SELECT * FROM integrations WHERE id = $1 LIMIT 1", [integrationId]);
  const integration = integrationResult.rows[0];
  if (!integration) {
    const error = new Error("Integracao OMIE nao encontrada.");
    error.statusCode = 404;
    throw error;
  }

  const credentialResult = await client.query(
    "SELECT credential_key, encrypted_value FROM integration_credentials WHERE integration_id = $1",
    [integrationId]
  );
  const secrets = {};
  for (const credential of credentialResult.rows) {
    secrets[credential.credential_key] = decryptSecret(credential.encrypted_value);
  }
  return { integration, secrets };
}

// Marca o job como em processamento, incrementando tentativas quando a coluna existir
async function markIntegrationJobProcessing(client, id) {
  if (await hasColumn(client, "integration_jobs", "started_at")) {
    await client.query(
      `UPDATE integration_jobs
       SET status = 'PROCESSANDO',
           started_at = CURRENT_TIMESTAMP,
           attempts = COALESCE(attempts, 0) + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );
    return;
  }
  await client.query("UPDATE integration_jobs SET status = 'PROCESSANDO' WHERE id = $1", [id]);
}

// Job com warning fica CONCLUIDO_COM_ALERTAS em vez de CONCLUIDO, para chamar atencao na UI
function getCompletedJobStatus(result = {}) {
  return result?.warning ? "CONCLUIDO_COM_ALERTAS" : "CONCLUIDO";
}

async function markIntegrationJobCompleted(client, id, result = null, status = "CONCLUIDO") {
  if (await hasColumn(client, "integration_jobs", "completed_at")) {
    await client.query(
      `UPDATE integration_jobs
       SET status = $3,
           completed_at = CURRENT_TIMESTAMP,
           result = COALESCE($2::jsonb, result),
           last_error = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id, result ? JSON.stringify(result) : null, status, result?.warning || null]
    );
    return;
  }
  await client.query("UPDATE integration_jobs SET status = $2 WHERE id = $1", [id, status]);
}

// Registra a falha do job e propaga o erro para a integracao; classifica erro de credencial
// separadamente de erro temporario para orientar a estrategia de retentativa
async function markIntegrationJobFailed(client, id, error) {
  const message = safeErrorMessage(error);
  const credentialError = /credenciais|authenticate|autentic/i.test(message);
  const status = credentialError ? "ERRO_AUTENTICACAO" : "ERRO_TEMPORARIO";
  await client.query(
    `UPDATE integration_jobs
     SET status = $2,
         last_error = $3,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, status, message]
  );
  await client.query(
    `UPDATE integrations
     SET status = $2,
         last_error = $3,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (
       SELECT integration_id FROM integration_jobs WHERE id = $1
     )`,
    [id, status, message]
  ).catch(() => {});
}

async function getIntegrationJobById(client, id) {
  const result = await client.query("SELECT * FROM integration_jobs WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] || null;
}

// Extrai uma mensagem de erro segura e limitada em tamanho para armazenar no banco
function safeErrorMessage(error) {
  return String(error?.message || error || "Falha ao processar job OMIE.").slice(0, 1000);
}

// Atualiza o horario do ultimo sucesso de sincronizacao por escopo, se a tabela/coluna existir
async function markSyncStateSuccess(client, integrationId, scope) {
  const table = await client.query("SELECT to_regclass('integration_sync_state') AS exists");
  if (!table.rows[0]?.exists) return;
  const hasUpdatedAt = await hasColumn(client, "integration_sync_state", "updated_at");
  if (hasUpdatedAt) {
    await client.query(
      `UPDATE integration_sync_state
       SET last_success_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE integration_id = $1 AND scope = $2`,
      [integrationId, scope]
    );
    return;
  }
  await client.query(
    `UPDATE integration_sync_state
     SET last_success_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND scope = $2`,
    [integrationId, scope]
  );
}

// Marca a integracao como conectada e limpa o ultimo erro apos um job bem-sucedido
async function markIntegrationSuccess(client, integrationId) {
  await client.query(
    `UPDATE integrations
     SET status = 'CONECTADO',
         ultima_sincronizacao = CURRENT_TIMESTAMP,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [integrationId]
  ).catch(() => {});
}

// Verifica se uma coluna existe no schema (usado para compatibilidade entre versoes do banco)
async function hasColumn(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

// Leitura OMIE usa janela com sobreposicao de INTERVAL '2 minutes' para evitar lacunas.
export const OMIE_MOVEMENT_OVERLAP = "INTERVAL '2 minutes'";

// Classifica o "calor" de um produto pela recencia da ultima consulta, para priorizar
// atualizacoes de saldo em produtos consultados com mais frequencia
export function classifyProductTemperature(lastRequestedAt) {
  if (!lastRequestedAt) return "FRIO";
  const ageMs = Date.now() - new Date(lastRequestedAt).getTime();
  if (ageMs < 24 * 60 * 60_000) return "QUENTE";
  if (ageMs < 7 * 24 * 60 * 60_000) return "MORNO";
  return "FRIO";
}

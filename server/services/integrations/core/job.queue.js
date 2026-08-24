import { comoIntegrationError } from "./errors.js";

// Fila generica de jobs de integracao (tabela integration_jobs).
//
// Regra que a versao anterior violava: o tipo do job e SEMPRE o id da capacidade declarada
// pelo provider, gravado literalmente. Nao existe mais normalizacao de escopo aqui — era ela
// que traduzia SYNC_OMIE_PRODUCTS/STOCK/MOVEMENTS todos para SYNC_OMIE_FULL, fazendo saldos,
// locais e movimentos nunca rodarem.

export const PRIORIDADES = Object.freeze({
  CRITICA: 100,
  ALTA: 80,
  NORMAL: 50,
  BAIXA: 20
});

// Status em que um job ainda vai ser executado de novo
export const STATUS_EXECUTAVEIS = ["PENDENTE", "AGUARDANDO_REPROCESSAMENTO", "ERRO_TEMPORARIO"];

// Status finais: o job nao volta para a fila sozinho
export const STATUS_FINAIS = [
  "CONCLUIDO",
  "CONCLUIDO_COM_ALERTAS",
  "CANCELADO",
  "ERRO_CONFIGURACAO",
  "ERRO_AUTENTICACAO",
  "ERRO_DADOS"
];

export function normalizarPrioridade(valor) {
  const texto = String(valor || "")
    .trim()
    .toUpperCase();
  if (["CRITICA", "CRITICO", "CRITICAL"].includes(texto)) return "CRITICA";
  if (["ALTA", "HIGH"].includes(texto)) return "ALTA";
  if (["BAIXA", "LOW"].includes(texto)) return "BAIXA";
  return "NORMAL";
}

export function pesoPrioridade(prioridade) {
  return PRIORIDADES[normalizarPrioridade(prioridade)] ?? PRIORIDADES.NORMAL;
}

// Enfileira um job. Nao duplica: se ja existe um job igual (mesma integracao, capacidade e
// payload) ainda nao finalizado, devolve o existente em vez de criar outro.
export async function enfileirar(
  client,
  { integrationId, capacidade, payload = {}, prioridade = "NORMAL", agendadoPara = null }
) {
  const tipo = String(capacidade).toUpperCase();
  const payloadJson = JSON.stringify(payload || {});

  const existente = await client.query(
    `SELECT * FROM integration_jobs
     WHERE integration_id = $1 AND job_type = $2 AND payload = $3::jsonb
       AND status = ANY($4::text[])
     ORDER BY created_at DESC
     LIMIT 1`,
    [integrationId, tipo, payloadJson, [...STATUS_EXECUTAVEIS, "PROCESSANDO"]]
  );
  if (existente.rows[0]) return existente.rows[0];

  const resultado = await client.query(
    `INSERT INTO integration_jobs
       (integration_id, job_type, payload, priority, priority_rank, status, scheduled_for, next_run_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, 'PENDENTE', COALESCE($6, CURRENT_TIMESTAMP), COALESCE($6, CURRENT_TIMESTAMP))
     RETURNING *`,
    [integrationId, tipo, payloadJson, normalizarPrioridade(prioridade), pesoPrioridade(prioridade), agendadoPara]
  );
  return resultado.rows[0];
}

// Reserva o proximo job elegivel: maior prioridade primeiro, respeitando o horario agendado.
// SKIP LOCKED permite mais de um worker sem que dois peguem o mesmo job.
export async function reservarProximo(client) {
  const resultado = await client.query(
    `SELECT * FROM integration_jobs
     WHERE status = ANY($1::text[])
       AND COALESCE(next_run_at, scheduled_for, created_at) <= CURRENT_TIMESTAMP
     ORDER BY priority_rank DESC, COALESCE(next_run_at, scheduled_for, created_at)
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [STATUS_EXECUTAVEIS]
  );
  const job = resultado.rows[0];
  if (!job) return null;
  return marcarProcessando(client, job.id);
}

// Reserva um job especifico (usado pelo botao "Processar" da tela)
export async function reservarPorId(client, id) {
  const resultado = await client.query(
    `SELECT * FROM integration_jobs
     WHERE id = $1 AND status <> 'PROCESSANDO'
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [id]
  );
  if (!resultado.rows[0]) return null;
  return marcarProcessando(client, id);
}

async function marcarProcessando(client, id) {
  const resultado = await client.query(
    `UPDATE integration_jobs
     SET status = 'PROCESSANDO',
         started_at = CURRENT_TIMESTAMP,
         attempts = COALESCE(attempts, 0) + 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return resultado.rows[0] || null;
}

// Conclui o job. Resultado com "alerta" fica CONCLUIDO_COM_ALERTAS para chamar atencao na tela
// sem tratar a execucao como falha.
export async function concluir(client, id, resultado = {}) {
  const status = resultado?.alerta ? "CONCLUIDO_COM_ALERTAS" : "CONCLUIDO";
  const linha = await client.query(
    `UPDATE integration_jobs
     SET status = $2,
         completed_at = CURRENT_TIMESTAMP,
         result = $3::jsonb,
         current_page = COALESCE($4, current_page),
         last_error = $5,
         next_run_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [id, status, JSON.stringify(resultado || {}), resultado?.pagina || null, resultado?.alerta || null]
  );
  return linha.rows[0] || null;
}

// Tempo de espera antes da proxima tentativa, crescendo com o numero de tentativas
// (30s, 1min, 2min, 4min... ate 15min) para nao martelar uma API que esta fora do ar.
export function atrasoRetentativaMs(tentativas) {
  const base = 30_000;
  const teto = 15 * 60_000;
  return Math.min(base * 2 ** Math.max(0, Number(tentativas || 1) - 1), teto);
}

// Marca falha. Erro retentavel volta para a fila com espera crescente; os demais param
// num status final, para o operador ver e agir em vez de acumular 100 mil linhas na tabela.
export async function falhar(client, job, erroBruto) {
  const erro = comoIntegrationError(erroBruto);
  const podeRetentar = erro.retentavel && Number(job.attempts || 1) < 8;
  const status = podeRetentar ? "ERRO_TEMPORARIO" : erro.statusJob;
  const proximaTentativa = podeRetentar ? atrasoRetentativaMs(job.attempts) : null;

  const linha = await client.query(
    `UPDATE integration_jobs
     SET status = $2,
         last_error = $3,
         result = $4::jsonb,
         next_run_at = CASE WHEN $5::int IS NULL THEN NULL
                            ELSE CURRENT_TIMESTAMP + ($5::int * INTERVAL '1 millisecond') END,
         completed_at = CASE WHEN $5::int IS NULL THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [
      job.id,
      status,
      String(erro.message || "").slice(0, 1000),
      JSON.stringify({ codigo: erro.codigo, detalhes: erro.detalhes || null }),
      proximaTentativa
    ]
  );
  return { job: linha.rows[0] || null, erro };
}

// Reabre um job parado para nova tentativa manual
export async function reabrir(client, id, motivo) {
  const resultado = await client.query(
    `UPDATE integration_jobs
     SET status = 'AGUARDANDO_REPROCESSAMENTO',
         next_run_at = CURRENT_TIMESTAMP,
         last_error = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status <> 'PROCESSANDO'
     RETURNING *`,
    [id, String(motivo || "").slice(0, 500) || null]
  );
  return resultado.rows[0] || null;
}

export async function listarJobs(client, { integrationId = null, status = "", capacidade = "", limite = 100 } = {}) {
  const resultado = await client.query(
    `SELECT j.*, i.nome AS integracao_nome, i.provedor
     FROM integration_jobs j
     LEFT JOIN integrations i ON i.id = j.integration_id
     WHERE ($1::bigint IS NULL OR j.integration_id = $1)
       AND ($2::text = '' OR j.status = $2)
       AND ($3::text = '' OR j.job_type = $3)
     ORDER BY j.created_at DESC
     LIMIT $4`,
    [integrationId, status, String(capacidade || "").toUpperCase(), Math.min(Number(limite) || 100, 500)]
  );
  return resultado.rows;
}

// Resumo por capacidade/status para os cartoes da tela, sem trazer as linhas
export async function resumirJobs(client) {
  const resultado = await client.query(
    `SELECT integration_id, job_type, status, COUNT(*)::int AS total, MAX(created_at) AS ultimo
     FROM integration_jobs
     GROUP BY integration_id, job_type, status`
  );
  return resultado.rows;
}

// Poda a tabela: jobs finalizados velhos nao servem para nada e ja passaram de 100 mil linhas
// nesta instalacao. Mantem os mais recentes de cada tipo para o historico continuar util.
export async function podarJobsAntigos(client, { manterDias = 7, manterPorTipo = 200 } = {}) {
  const resultado = await client.query(
    `WITH ranqueados AS (
       SELECT id,
              ROW_NUMBER() OVER (PARTITION BY integration_id, job_type ORDER BY created_at DESC) AS posicao
       FROM integration_jobs
       WHERE status = ANY($1::text[])
     )
     DELETE FROM integration_jobs
     WHERE id IN (
       SELECT r.id FROM ranqueados r
       JOIN integration_jobs j ON j.id = r.id
       WHERE r.posicao > $2
         AND j.created_at < CURRENT_TIMESTAMP - ($3::int * INTERVAL '1 day')
     )`,
    [STATUS_FINAIS, manterPorTipo, manterDias]
  );
  return resultado.rowCount || 0;
}

// Cursor de sincronizacao por integracao + capacidade (tabela integration_sync_state).
//
// E o que permite leitura incremental: o provider guarda aqui de onde continuar (ultima data,
// ultimo id externo, ultima pagina) em vez de reprocessar tudo a cada ciclo.

// Garante que a linha exista e devolve o estado atual da capacidade
export async function obterEstado(client, integrationId, capacidade) {
  const escopo = String(capacidade).toUpperCase();
  await client.query(
    `INSERT INTO integration_sync_state (integration_id, scope)
     VALUES ($1, $2)
     ON CONFLICT (integration_id, scope) DO NOTHING`,
    [integrationId, escopo]
  );
  const resultado = await client.query(
    "SELECT * FROM integration_sync_state WHERE integration_id = $1 AND scope = $2 LIMIT 1",
    [integrationId, escopo]
  );
  return resultado.rows[0] || null;
}

export async function registrarTentativa(client, integrationId, capacidade) {
  await client.query(
    `UPDATE integration_sync_state
     SET last_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND scope = $2`,
    [integrationId, String(capacidade).toUpperCase()]
  );
}

// Avanca o cursor apos uma execucao bem-sucedida. Campos nao informados ficam como estavam.
export async function registrarSucesso(
  client,
  integrationId,
  capacidade,
  { ultimoIdExterno = null, ultimaPagina = null, cursor = null, inicioSobreposicao = null, estatisticas = null } = {}
) {
  await client.query(
    `UPDATE integration_sync_state
     SET last_success_at = CURRENT_TIMESTAMP,
         last_movement_id = COALESCE($3, last_movement_id),
         last_page = COALESCE($4, last_page),
         last_cursor = COALESCE($5, last_cursor),
         overlap_start_at = COALESCE($6, overlap_start_at),
         stats = COALESCE($7::jsonb, stats),
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND scope = $2`,
    [
      integrationId,
      String(capacidade).toUpperCase(),
      ultimoIdExterno,
      ultimaPagina,
      cursor,
      inicioSobreposicao,
      estatisticas ? JSON.stringify(estatisticas) : null
    ]
  );
}

export async function registrarErro(client, integrationId, capacidade, mensagem) {
  await client.query(
    `UPDATE integration_sync_state
     SET last_error = $3, updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND scope = $2`,
    [integrationId, String(capacidade).toUpperCase(), String(mensagem || "").slice(0, 1000)]
  );
}

export async function listarEstados(client, integrationId = null) {
  const resultado = integrationId
    ? await client.query("SELECT * FROM integration_sync_state WHERE integration_id = $1 ORDER BY scope", [
        integrationId
      ])
    : await client.query("SELECT * FROM integration_sync_state ORDER BY integration_id, scope");
  return resultado.rows;
}

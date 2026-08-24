// Reconciliacao: compara o espelho local com o que a OMIE devolveu por ultimo e registra
// as divergencias para revisao humana.
//
// Nao corrige nada automaticamente, de proposito. Corrigir saldo sozinho a partir de um
// numero que ja se sabe divergente e como esconder o problema: a divergencia vira registro
// em stock_reconciliation_items e alguem decide o que fazer.

const TIPOS = Object.freeze({
  SALDO_DESATUALIZADO: "SALDO_DESATUALIZADO",
  RESERVA_MAIOR_QUE_SALDO: "RESERVA_MAIOR_QUE_SALDO",
  SALDO_NEGATIVO: "SALDO_NEGATIVO"
});

// Quanto tempo sem sincronizar ja conta como saldo velho
const HORAS_ATE_DESATUALIZAR = 6;

export async function reconciliarEstoque(contexto) {
  const { client, integracao } = contexto;

  const execucao = await client.query(
    `INSERT INTO stock_reconciliations (integration_id, status, started_at)
     VALUES ($1, 'PROCESSANDO', CURRENT_TIMESTAMP)
     RETURNING id`,
    [integracao.id]
  );
  const reconciliacaoId = execucao.rows[0].id;

  // Uma consulta so devolve as tres situacoes, cada linha ja classificada. Rodar tres
  // varreduras separadas em estoque_pdv (42 mil linhas nesta instalacao) custaria caro.
  const divergencias = await client.query(
    `SELECT e.pdv_id,
            e.sku_produto,
            m.omie_location_id,
            e.quantidade AS saldo_local,
            COALESCE(e.saldo_omie, 0) AS saldo_omie,
            COALESCE(e.quantidade_reservada_acpark, 0) AS reservado,
            e.ultima_sincronizacao,
            CASE
              WHEN COALESCE(e.saldo_omie, 0) < 0 THEN $2
              WHEN COALESCE(e.quantidade_reservada_acpark, 0) > COALESCE(e.saldo_omie, 0) THEN $3
              ELSE $4
            END AS tipo
     FROM estoque_pdv e
     JOIN pdv_stock_location_mappings m
       ON m.pdv_acpark_id = e.pdv_id AND m.integration_id = $1 AND m.active = TRUE
     WHERE e.permitido = TRUE
       AND (
         COALESCE(e.saldo_omie, 0) < 0
         OR COALESCE(e.quantidade_reservada_acpark, 0) > COALESCE(e.saldo_omie, 0)
         OR e.ultima_sincronizacao IS NULL
         OR e.ultima_sincronizacao < CURRENT_TIMESTAMP - ($5::int * INTERVAL '1 hour')
       )
     LIMIT 5000`,
    [
      integracao.id,
      TIPOS.SALDO_NEGATIVO,
      TIPOS.RESERVA_MAIOR_QUE_SALDO,
      TIPOS.SALDO_DESATUALIZADO,
      HORAS_ATE_DESATUALIZAR
    ]
  );

  const resumo = {
    divergencias: divergencias.rowCount,
    por_tipo: {},
    reconciliacao_id: reconciliacaoId
  };

  for (const linha of divergencias.rows) {
    resumo.por_tipo[linha.tipo] = (resumo.por_tipo[linha.tipo] || 0) + 1;
    await client.query(
      `INSERT INTO stock_reconciliation_items
         (reconciliation_id, integration_id, pdv_id, sku_produto, omie_location_id,
          difference_type, status, saldo_local, saldo_omie, diferenca, details)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDENTE', $7, $8, $9, $10::jsonb)`,
      [
        reconciliacaoId,
        integracao.id,
        linha.pdv_id,
        linha.sku_produto,
        linha.omie_location_id,
        linha.tipo,
        linha.saldo_local,
        linha.saldo_omie,
        Number(linha.saldo_local || 0) - Number(linha.saldo_omie || 0),
        JSON.stringify({
          reservado: linha.reservado,
          ultima_sincronizacao: linha.ultima_sincronizacao
        })
      ]
    );
  }

  await client.query(
    `UPDATE stock_reconciliations
     SET status = 'CONCLUIDO', finished_at = CURRENT_TIMESTAMP,
         differences_count = $2, summary = $3::jsonb
     WHERE id = $1`,
    [reconciliacaoId, resumo.divergencias, JSON.stringify(resumo)]
  );

  if (resumo.divergencias) {
    resumo.alerta = `${resumo.divergencias} divergencias de estoque aguardando revisao.`;
  }

  resumo.cursor = { estatisticas: { ...resumo } };
  return resumo;
}

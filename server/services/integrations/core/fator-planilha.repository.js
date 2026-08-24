import { normalizarNome, reconciliarAbas, sugerirVinculos } from "./fator-planilha.js";

// Acesso a tabela da planilha de controle de fardos.
//
// A linha existe por NOME DE OPERACAO, e pode viver sem produto vinculado -- e esse o estado
// normal logo depois da importacao. Vincular e ato humano.

// Grava a planilha reconciliada. Atualiza por nome, nunca duplica.
//
// O vinculo ja confirmado por uma pessoa e PRESERVADO na reimportacao: a planilha muda de
// periodo, mas quem ja disse "esta linha e este produto" nao precisa dizer de novo.
export async function importarPlanilha(client, integrationId, linhasPorAba) {
  const linhas = reconciliarAbas(linhasPorAba);

  const resumo = {
    linhas_lidas: linhas.length,
    com_fator: 0,
    divergentes: 0,
    sem_fator: 0
  };

  for (const linha of linhas) {
    if (linha.divergente) resumo.divergentes += 1;
    else if (linha.fator) resumo.com_fator += 1;
    else resumo.sem_fator += 1;

    await client.query(
      `INSERT INTO integration_factor_sheet
         (integration_id, nome_operacao, fator, divergente, valores_por_aba, secao)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (integration_id, nome_operacao) DO UPDATE
         SET fator = EXCLUDED.fator,
             divergente = EXCLUDED.divergente,
             valores_por_aba = EXCLUDED.valores_por_aba,
             secao = EXCLUDED.secao,
             atualizado_em = CURRENT_TIMESTAMP`,
      [
        integrationId,
        linha.nome_operacao,
        linha.fator,
        linha.divergente,
        JSON.stringify(linha.valores_por_aba || {}),
        linha.secao || null
      ]
    );
  }

  return resumo;
}

// Todas as linhas da planilha, com o produto vinculado quando houver
export async function listarLinhasDaPlanilha(client, integrationId) {
  const resultado = await client.query(
    `SELECT s.nome_operacao, s.fator, s.divergente, s.valores_por_aba, s.secao,
            s.external_product_id, s.vinculado_por, s.vinculado_em,
            m.sku_produto, p.nome AS nome_produto
     FROM integration_factor_sheet s
     LEFT JOIN product_integration_mappings m
       ON m.integration_id = s.integration_id
      AND m.external_product_id = s.external_product_id
     LEFT JOIN produtos p ON p.sku = m.sku_produto
     WHERE s.integration_id = $1
     ORDER BY s.nome_operacao`,
    [integrationId]
  );
  return resultado.rows;
}

// Fila de vinculo: linhas com fator que ainda nao apontam para produto nenhum.
//
// Cada uma vem com ate tres candidatos ordenados por semelhanca de nome. Os candidatos sao
// SUGESTAO: medido, o primeiro colocado de "AGUA MINERAL GASOSA 500ML" foi "AGUA MINERAL SEM
// GAS 500ML", o produto oposto. Quem vincula e uma pessoa.
export async function listarPendenciasDeVinculo(client, integrationId) {
  const pendentes = await client.query(
    `SELECT nome_operacao, fator, divergente, valores_por_aba, secao
     FROM integration_factor_sheet
     WHERE integration_id = $1 AND external_product_id IS NULL
     ORDER BY (fator IS NULL), nome_operacao`,
    [integrationId]
  );
  if (!pendentes.rows.length) return [];

  const produtos = await client.query(
    `SELECT m.external_product_id, m.sku_produto, p.nome
     FROM product_integration_mappings m
     LEFT JOIN produtos p ON p.sku = m.sku_produto
     WHERE m.integration_id = $1 AND m.active = TRUE AND m.external_product_id IS NOT NULL`,
    [integrationId]
  );

  return pendentes.rows.map((linha) => ({
    ...linha,
    candidatos: sugerirVinculos(linha.nome_operacao, produtos.rows)
  }));
}

// Vincula uma linha da planilha a um produto. Sempre por decisao humana.
export async function vincularLinha(client, integrationId, nomeOperacao, externalProductId, usuario) {
  const resultado = await client.query(
    `UPDATE integration_factor_sheet
     SET external_product_id = $3,
         vinculado_por = $4,
         vinculado_em = CASE WHEN $3::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
         atualizado_em = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND nome_operacao = $2`,
    [integrationId, nomeOperacao, externalProductId || null, usuario || null]
  );
  return resultado.rowCount || 0;
}

// Mapa produto -> linha da planilha, para a derivacao consultar sem uma consulta por produto
export async function mapaPorProduto(client, integrationId) {
  const resultado = await client.query(
    `SELECT external_product_id, nome_operacao, fator, divergente, valores_por_aba
     FROM integration_factor_sheet
     WHERE integration_id = $1 AND external_product_id IS NOT NULL`,
    [integrationId]
  );
  const mapa = new Map();
  for (const linha of resultado.rows) mapa.set(String(linha.external_product_id), linha);
  return mapa;
}

// Reexporta para quem monta a tela conseguir normalizar do mesmo jeito
export { normalizarNome };

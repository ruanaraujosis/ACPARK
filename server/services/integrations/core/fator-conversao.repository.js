import { converterParaUnidades, FATOR_UNITARIO, STATUS_FATOR } from "./fator-conversao.js";

// Resolve o fator de conversao de um produto e converte a quantidade pedida para unidades.
//
// Fica no nucleo porque a regra e do sistema, nao de uma API: o estoque e sempre guardado na
// menor unidade. Quem preenche as colunas de fator e a integracao; quem as consome e o pedido.

export const UNIDADES_DE_MEDIDA = Object.freeze({
  UNIDADE: "UNIDADE",
  EMBALAGEM: "EMBALAGEM"
});

// Le o fator de um SKU. Produto sem vinculo com o ERP, ou ainda nao lido, e tratado como
// unitario -- assim o pedido em unidade continua funcionando enquanto a varredura nao chega.
export async function obterFatorDoSku(client, sku) {
  const resultado = await client.query(
    `SELECT fator_conversao, fator_status, fator_conteudo_bruto, embalagem
     FROM product_integration_mappings
     WHERE sku_produto = $1 AND active = TRUE
     ORDER BY fator_lido_em DESC NULLS LAST
     LIMIT 1`,
    [sku]
  );

  const linha = resultado.rows[0];
  if (!linha || !linha.fator_status) {
    return { fator: FATOR_UNITARIO, status: STATUS_FATOR.UNITARIO, embalagem: null, conteudo: null };
  }

  return {
    fator: linha.fator_conversao ?? null,
    status: linha.fator_status,
    embalagem: linha.embalagem || null,
    conteudo: linha.fator_conteudo_bruto || null
  };
}

// Converte a quantidade de um item de pedido para unidades.
//
// A multiplicacao acontece AQUI, na criacao do item, e nunca depois: se o numero gravado em
// pedidos.quantidade_solicitada fosse as vezes embalagem e as vezes unidade, nenhuma tela,
// relatorio ou transferencia saberia qual dos dois esta lendo.
export async function converterQuantidadeDoPedido(client, { sku, quantidade, unidadeMedida }) {
  const emEmbalagem = String(unidadeMedida || "").toUpperCase() === UNIDADES_DE_MEDIDA.EMBALAGEM;
  const info = await obterFatorDoSku(client, sku);

  // Pedido em unidade nao depende de fator nenhum
  if (!emEmbalagem) {
    return {
      unidades: quantidade,
      fator: info.fator ?? FATOR_UNITARIO,
      embalagem: info.embalagem,
      unidadeMedida: UNIDADES_DE_MEDIDA.UNIDADE,
      quantidadeInformada: quantidade
    };
  }

  // Pedir por embalagem exige fator confiavel. Com fator invalido, recusar e melhor que
  // multiplicar por um numero adivinhado -- o erro apareceria so quando o estoque nao fechasse.
  if (info.status === STATUS_FATOR.INVALIDO || !info.fator) {
    const erro = new Error(
      `O produto ${sku} está sem fator de conversão válido no cadastro${info.conteudo ? ` (conteúdo atual: "${info.conteudo}")` : ""}. Corrija no ERP ou peça em unidades.`
    );
    erro.statusCode = 400;
    throw erro;
  }

  return {
    unidades: converterParaUnidades(quantidade, info.fator),
    fator: info.fator,
    embalagem: info.embalagem,
    unidadeMedida: UNIDADES_DE_MEDIDA.EMBALAGEM,
    quantidadeInformada: quantidade
  };
}

// Produtos cujo fator ficou pendente de correcao no cadastro do ERP
export async function listarPendenciasDeFator(client, { integrationId = null, limite = 200 } = {}) {
  const resultado = await client.query(
    `SELECT m.sku_produto, m.external_product_id, m.fator_conteudo_bruto, m.fator_lido_em,
            p.nome AS produto_nome, p.ativo
     FROM product_integration_mappings m
     LEFT JOIN produtos p ON p.sku = m.sku_produto
     WHERE m.fator_status = $1
       AND m.active = TRUE
       AND ($2::bigint IS NULL OR m.integration_id = $2)
     ORDER BY p.ativo DESC NULLS LAST, m.sku_produto
     LIMIT $3`,
    [STATUS_FATOR.INVALIDO, integrationId, Math.min(Number(limite) || 200, 500)]
  );
  return resultado.rows;
}

// Resumo da cobertura do fator, para a tela mostrar o andamento da varredura
export async function resumirFatores(client, integrationId = null) {
  const resultado = await client.query(
    `SELECT COALESCE(fator_status, 'NAO_LIDO') AS status, COUNT(*)::int AS total
     FROM product_integration_mappings
     WHERE active = TRUE AND ($1::bigint IS NULL OR integration_id = $1)
     GROUP BY 1
     ORDER BY total DESC`,
    [integrationId]
  );
  return resultado.rows;
}

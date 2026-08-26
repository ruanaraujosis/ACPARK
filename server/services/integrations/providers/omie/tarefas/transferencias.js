import { CODIGOS_ERRO, IntegrationError } from "../../../core/errors.js";
import { emSimulacao, modoDeEscrita } from "../../../core/escrita.js";
import * as lancamentos from "../../../core/stock-launches.repository.js";
import { chamarOmie, ENDPOINTS } from "../omie.api.js";
import {
  montarCompensacaoTransferencia,
  montarTransferenciaEstoque,
} from "../omie.operacoes.js";

const CALL = "IncluirAjusteEstoque";
const LANCAMENTOS_POR_JOB = 25;

// Envia para a OMIE as transferencias ALMOXARIFADO -> PDV geradas pela confirmacao de retirada.
//
// Esta e a UNICA escrita que o MyEstoque faz. A matriz de responsabilidade (docs/INTEGRACOES.md)
// diz que venda, devolucao, compra, inventario e ajuste de saldo sao de outros sistemas -- e
// que o MyEstoque envia MOVIMENTO, nunca saldo absoluto, senao apagaria os lancamentos deles.
//
// Nasce em modo SIMULACAO: monta o payload, grava em auditoria e nao envia. So passa a enviar
// de verdade quando alguem coloca modo_escrita = REAL na configuracao da integracao.

// Traduz o SKU local para o id do produto na OMIE
async function idExternoDoProduto(client, integrationId, sku) {
  const resultado = await client.query(
    `SELECT external_product_id
     FROM product_integration_mappings
     WHERE integration_id = $1 AND sku_produto = $2 AND external_product_id IS NOT NULL
     LIMIT 1`,
    [integrationId, sku],
  );
  return resultado.rows[0]?.external_product_id || null;
}

// Valor simbolico usado quando nenhuma fonte de preco existe. A transferencia e um ajuste
// TRF: move quantidade entre dois locais e nao altera saldo financeiro nem custo medio,
// mas a OMIE recusa o ajuste com valor zero. Autorizado pelo usuario em 26/08/2026 para
// que a falta de preco nunca mais segure a movimentacao de estoque.
export const VALOR_SIMBOLICO = 0.01;

// Descobre o valor unitario do produto, que a OMIE exige no ajuste.
//
// Quatro fontes, nesta ordem:
//   1. price_manual -- preco informado por uma pessoa; vence tudo, por ser decisao humana
//      (a HEINEKEN, por exemplo, veio 16 do ERP e o usuario corrigiu para 20);
//   2. o preco do cadastro, que veio do proprio ERP na sincronizacao de produtos;
//   3. o preco unitario da ultima nota de compra, guardado na evidencia de fator;
//   4. VALOR_SIMBOLICO, ultimo recurso, so para o ajuste ser aceito.
//
// price_manual e coluna a parte de proposito: `price` e sobrescrito a cada sincronizacao de
// produtos (`price = EXCLUDED.price` em produtos.js), entao um preco humano gravado ali
// duraria ate a proxima rodada. price_manual fica fora daquele upsert e sobrevive.
//
// Medido: 1.334 dos 4.435 mapeamentos tem preco zero no cadastro, entao a fonte 3 nao e luxo.
async function valorUnitarioDoProduto(client, integrationId, sku) {
  const doCadastro = await client.query(
    `SELECT price, price_manual FROM product_integration_mappings
     WHERE integration_id = $1 AND sku_produto = $2 LIMIT 1`,
    [integrationId, sku],
  );
  const manual = Number(doCadastro.rows[0]?.price_manual);
  if (Number.isFinite(manual) && manual > 0)
    return { valor: manual, fonte: "MANUAL" };

  const preco = Number(doCadastro.rows[0]?.price);
  if (Number.isFinite(preco) && preco > 0)
    return { valor: preco, fonte: "CADASTRO" };

  const daNota = await client.query(
    `SELECT (e.documento->>'preco_unitario')::numeric AS preco
     FROM integration_factor_evidence e
     JOIN product_integration_mappings m
       ON m.integration_id = e.integration_id AND m.external_product_id = e.external_product_id
     WHERE e.integration_id = $1 AND m.sku_produto = $2
       AND (e.documento->>'preco_unitario') IS NOT NULL
     ORDER BY e.ultima_em DESC NULLS LAST
     LIMIT 1`,
    [integrationId, sku],
  );
  const daCompra = Number(daNota.rows[0]?.preco);
  if (Number.isFinite(daCompra) && daCompra > 0)
    return { valor: daCompra, fonte: "NOTA" };

  return { valor: VALOR_SIMBOLICO, fonte: "SIMBOLICO" };
}

// Monta o payload conforme o evento: retirada transfere do almoxarifado para o PDV,
// compensacao faz o caminho inverso
function montarPayload(lancamento, idExternoProduto, valorUnitario) {
  const comum = {
    valorUnitario,
    chaveOperacao: lancamento.idempotency_key,
    idExternoProduto,
    sku: lancamento.sku_produto,
    codigoLocalOrigem: lancamento.local_origem,
    codigoLocalDestino: lancamento.local_destino,
    quantidade: lancamento.quantidade,
    data: lancamento.created_at || new Date(),
  };

  if (lancamento.evento === lancamentos.EVENTOS.COMPENSACAO) {
    // O repositorio ja gravou origem/destino invertidos na linha de compensacao, entao aqui
    // basta montar a transferencia normal -- inverter de novo desfaria o estorno
    return montarTransferenciaEstoque({
      ...comum,
      observacao: `Estorno da retirada do pedido ${lancamento.codigo_pedido} (reabertura no MyEstoque).`,
    });
  }

  return montarTransferenciaEstoque({
    ...comum,
    observacao: `Retirada do pedido ${lancamento.codigo_pedido} no MyEstoque.`,
  });
}

export async function enviarTransferencias(contexto) {
  const { client, integracao, segredos, configuracao, payload, fetchImpl } =
    contexto;
  const simulacao = emSimulacao(configuracao);

  // Um lancamento so: a virada para real comeca com um envio conferido no ERP
  const abertos = await lancamentos.listarAbertos(client, {
    integrationId: integracao.id,
    limite: Number(payload.limite) || LANCAMENTOS_POR_JOB,
    apenas: payload.apenas ? Number(payload.apenas) : null,
  });

  const resumo = {
    modo: modoDeEscrita(configuracao),
    pendentes: abertos.length,
    simulados: 0,
    enviados: 0,
    falhas: 0,
    sem_vinculo_de_produto: 0,
    com_valor_simbolico: 0,
    por_evento: {},
  };

  if (!abertos.length) return resumo;

  for (const lancamento of abertos) {
    resumo.por_evento[lancamento.evento] =
      (resumo.por_evento[lancamento.evento] || 0) + 1;

    try {
      const idExterno = await idExternoDoProduto(
        client,
        integracao.id,
        lancamento.sku_produto,
      );
      if (!idExterno) {
        resumo.sem_vinculo_de_produto += 1;
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.ERRO,
          erro: `Produto ${lancamento.sku_produto} nao tem vinculo com a OMIE. Rode a sincronizacao de produtos.`,
        });
        continue;
      }

      // Sempre ha valor: a ultima fonte e o valor simbolico. Falta de preco nao segura
      // mais a movimentacao de estoque -- so fica contada, para aparecer no resumo.
      const { valor: valorUnitario, fonte: fonteDoValor } =
        await valorUnitarioDoProduto(
          client,
          integracao.id,
          lancamento.sku_produto,
        );
      if (fonteDoValor === "SIMBOLICO") resumo.com_valor_simbolico += 1;

      const corpo = montarPayload(lancamento, idExterno, valorUnitario);

      // O que fica gravado leva uma anotacao a mais que NAO vai na chamada: `corpo` e
      // enviado cru como params da API, e um campo desconhecido ali faz a OMIE recusar.
      // fonte_valor existe so para auditar depois quais lancamentos sairam com valor
      // simbolico e quais tinham preco de verdade.
      const corpoGravado = { ...corpo, fonte_valor: fonteDoValor };

      // MODO SIMULACAO: o payload e gravado para conferencia e nada sai daqui.
      if (simulacao) {
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.SIMULADO,
          payload: corpoGravado,
          resposta: {
            simulado: true,
            observacao: "Nada foi enviado a OMIE (modo simulacao).",
          },
        });
        resumo.simulados += 1;
        continue;
      }

      const resposta = await chamarOmie({
        integracao,
        segredos,
        endpoint: ENDPOINTS.AJUSTE,
        call: CALL,
        params: corpo,
        fetchImpl,
      });

      await lancamentos.registrarResultado(client, lancamento.id, {
        status: lancamentos.STATUS.ENVIADO,
        payload: corpoGravado,
        resposta: resposta.dados,
        // A resposta real do IncluirAjusteEstoque traz id_ajuste e id_movest -- nao
        // codigo_lancamento nem nCodAjuste, que era o que o codigo procurava. Conferido no
        // primeiro envio real: o external_id ficava nulo e o lancamento perdia a
        // rastreabilidade do lado da OMIE.
        externalId:
          String(
            resposta.dados?.id_ajuste ||
              resposta.dados?.id_movest ||
              resposta.dados?.codigo_lancamento ||
              resposta.dados?.nCodAjuste ||
              "",
          ) || null,
      });
      resumo.enviados += 1;
    } catch (erro) {
      resumo.falhas += 1;
      await lancamentos.registrarResultado(client, lancamento.id, {
        status: lancamentos.STATUS.ERRO,
        erro: erro?.message || String(erro),
      });
    }
  }

  if (resumo.falhas) {
    resumo.alerta = `${resumo.falhas} lancamento(s) falharam. Veja o erro de cada um na fila de lancamentos.`;
  } else if (simulacao && resumo.simulados) {
    resumo.alerta = `${resumo.simulados} lancamento(s) apenas simulados. Nada foi enviado a OMIE.`;
  }

  return resumo;
}

// Impede que a capacidade rode com o local do almoxarifado ausente: sem ele nao da para
// saber de onde a mercadoria sai
export function validarConfiguracaoTransferencia(configuracao) {
  if (!String(configuracao?.local_almoxarifado || "").trim()) {
    throw new IntegrationError(
      "Configure o local do almoxarifado antes de enviar transferencias.",
      {
        codigo: CODIGOS_ERRO.CONFIGURACAO,
        status: 400,
      },
    );
  }
}

import { CODIGOS_ERRO, IntegrationError } from "../../../core/errors.js";
import { emSimulacao, modoDeEscrita } from "../../../core/escrita.js";
import * as lancamentos from "../../../core/stock-launches.repository.js";
import { chamarOmie, ENDPOINTS } from "../omie.api.js";
import { montarCompensacaoTransferencia, montarTransferenciaEstoque } from "../omie.operacoes.js";

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
    [integrationId, sku]
  );
  return resultado.rows[0]?.external_product_id || null;
}

// Monta o payload conforme o evento: retirada transfere do almoxarifado para o PDV,
// compensacao faz o caminho inverso
function montarPayload(lancamento, idExternoProduto) {
  const comum = {
    chaveOperacao: lancamento.idempotency_key,
    idExternoProduto,
    sku: lancamento.sku_produto,
    codigoLocalOrigem: lancamento.local_origem,
    codigoLocalDestino: lancamento.local_destino,
    quantidade: lancamento.quantidade,
    data: lancamento.created_at || new Date()
  };

  if (lancamento.evento === lancamentos.EVENTOS.COMPENSACAO) {
    // O repositorio ja gravou origem/destino invertidos na linha de compensacao, entao aqui
    // basta montar a transferencia normal -- inverter de novo desfaria o estorno
    return montarTransferenciaEstoque({
      ...comum,
      observacao: `Estorno da retirada do pedido ${lancamento.codigo_pedido} (reabertura no MyEstoque).`
    });
  }

  return montarTransferenciaEstoque({
    ...comum,
    observacao: `Retirada do pedido ${lancamento.codigo_pedido} no MyEstoque.`
  });
}

export async function enviarTransferencias(contexto) {
  const { client, integracao, segredos, configuracao, payload, fetchImpl } = contexto;
  const simulacao = emSimulacao(configuracao);

  const abertos = await lancamentos.listarAbertos(client, {
    integrationId: integracao.id,
    limite: Number(payload.limite) || LANCAMENTOS_POR_JOB
  });

  const resumo = {
    modo: modoDeEscrita(configuracao),
    pendentes: abertos.length,
    simulados: 0,
    enviados: 0,
    falhas: 0,
    sem_vinculo_de_produto: 0,
    por_evento: {}
  };

  if (!abertos.length) return resumo;

  for (const lancamento of abertos) {
    resumo.por_evento[lancamento.evento] = (resumo.por_evento[lancamento.evento] || 0) + 1;

    try {
      const idExterno = await idExternoDoProduto(client, integracao.id, lancamento.sku_produto);
      if (!idExterno) {
        resumo.sem_vinculo_de_produto += 1;
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.ERRO,
          erro: `Produto ${lancamento.sku_produto} nao tem vinculo com a OMIE. Rode a sincronizacao de produtos.`
        });
        continue;
      }

      const corpo = montarPayload(lancamento, idExterno);

      // MODO SIMULACAO: o payload e gravado para conferencia e nada sai daqui.
      if (simulacao) {
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.SIMULADO,
          payload: corpo,
          resposta: { simulado: true, observacao: "Nada foi enviado a OMIE (modo simulacao)." }
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
        fetchImpl
      });

      await lancamentos.registrarResultado(client, lancamento.id, {
        status: lancamentos.STATUS.ENVIADO,
        payload: corpo,
        resposta: resposta.dados,
        externalId: String(resposta.dados?.codigo_lancamento || resposta.dados?.nCodAjuste || "") || null
      });
      resumo.enviados += 1;
    } catch (erro) {
      resumo.falhas += 1;
      await lancamentos.registrarResultado(client, lancamento.id, {
        status: lancamentos.STATUS.ERRO,
        erro: erro?.message || String(erro)
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
    throw new IntegrationError("Configure o local do almoxarifado antes de enviar transferencias.", {
      codigo: CODIGOS_ERRO.CONFIGURACAO,
      status: 400
    });
  }
}

import { emSimulacao, modoDeEscrita } from "../../../core/escrita.js";
import * as lancamentos from "../../../core/stock-launches.repository.js";
import { ehLimiteDeTaxa, pausarIntegracao, segundosDeEspera } from "../../../core/pausa-integracao.js";
import { chamarOmie, ENDPOINTS } from "../omie.api.js";
import { montarAjusteInventario } from "../omie.operacoes.js";

const CALL = "IncluirAjusteEstoque";
const LANCAMENTOS_POR_JOB = 25;

// Envia para a OMIE os ajustes gerados pela assinatura de um inventario.
//
// EXCECAO da matriz de responsabilidade: e a unica escrita do MyEstoque que usa SALDO
// ABSOLUTO (tipo SLD, motivo INV). Todas as outras enviam movimento. O motivo esta em
// docs/INTEGRACOES.md: no inventario a contagem fisica passa a ser a verdade, que e
// exatamente o que o ajuste de saldo faz.
//
// Nasce em SIMULACAO como qualquer capacidade de escrita: monta o payload, grava para
// conferencia e nao envia.

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

// Valor unitario do cadastro, quando existir.
//
// Diferente da transferencia, aqui NAO existe valor simbolico de ultimo recurso. A
// transferencia precisa de valor porque a OMIE recusa TRF com valor zero; para o ajuste de
// saldo isso ainda nao foi confirmado, e inventar 0,01 num ajuste de inventario mexeria no
// custo do estoque sem que ninguem tivesse pedido. Sem preco, o campo simplesmente nao vai.
// Se o primeiro envio real for recusado por falta de valor, e aqui que a fonte entra.
async function valorUnitarioDoProduto(client, integrationId, sku) {
  const resultado = await client.query(
    `SELECT price, price_manual FROM product_integration_mappings
     WHERE integration_id = $1 AND sku_produto = $2 LIMIT 1`,
    [integrationId, sku]
  );
  const manual = Number(resultado.rows[0]?.price_manual);
  if (Number.isFinite(manual) && manual > 0) return manual;
  const preco = Number(resultado.rows[0]?.price);
  return Number.isFinite(preco) && preco > 0 ? preco : null;
}

export async function enviarAjustesDeInventario(contexto) {
  const { client, integracao, segredos, configuracao, payload = {}, fetchImpl } = contexto;
  const simulacao = emSimulacao(configuracao);

  // So os ajustes de inventario: a fila e compartilhada com a transferencia, que monta
  // outro payload e exige local de destino
  const abertos = await lancamentos.listarAbertos(client, {
    integrationId: integracao.id,
    limite: Number(payload.limite) || LANCAMENTOS_POR_JOB,
    apenas: payload.apenas ? Number(payload.apenas) : null,
    eventos: [lancamentos.EVENTOS.AJUSTE_INVENTARIO]
  });

  const resumo = {
    modo: modoDeEscrita(configuracao),
    pendentes: abertos.length,
    simulados: 0,
    enviados: 0,
    falhas: 0,
    sem_vinculo_de_produto: 0,
    zerados: 0
  };

  if (!abertos.length) return resumo;

  for (const lancamento of abertos) {
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

      if (Number(lancamento.quantidade) === 0) resumo.zerados += 1;

      const corpo = montarAjusteInventario({
        chaveOperacao: lancamento.idempotency_key,
        idExternoProduto: idExterno,
        sku: lancamento.sku_produto,
        codigoLocal: lancamento.local_origem,
        quantidade: lancamento.quantidade,
        valorUnitario: await valorUnitarioDoProduto(client, integracao.id, lancamento.sku_produto),
        data: lancamento.created_at || new Date(),
        observacao: `Ajuste por inventario ${lancamento.codigo_pedido} (MyEstoque).`
      });

      // MODO SIMULACAO: o payload e gravado para conferencia e nada sai daqui
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
        // id_ajuste / id_movest sao os campos que o IncluirAjusteEstoque devolve de verdade;
        // isso foi conferido no primeiro envio real da transferencia
        externalId: String(resposta.dados?.id_ajuste || resposta.dados?.id_movest || "") || null
      });
      resumo.enviados += 1;
    } catch (erro) {
      // Bloqueio por consumo: para o lote AQUI. Continuar queimaria as chamadas restantes
      // contra uma porta fechada e renovaria a punicao -- foi exatamente isso que manteve o
      // laco vivo no incidente de 29/08/2026 (50 chamadas bloqueadas a cada 5 minutos).
      if (ehLimiteDeTaxa(erro)) {
        const espera = segundosDeEspera(erro);
        const pausa = await pausarIntegracao(client, integracao.id, {
          segundos: espera,
          motivo: erro.message
        });
        resumo.falhas += 1;
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.ERRO,
          erro: erro?.message || String(erro)
        });
        resumo.bloqueado_por_limite = true;
        resumo.pausado_ate = pausa?.pausadaAte || null;
        resumo.alerta = espera
          ? `A API pediu para esperar ${espera}s. O restante da fila continua na proxima janela.`
          : "A API bloqueou o acesso por consumo. O restante da fila continua depois.";
        return resumo;
      }
      resumo.falhas += 1;
      await lancamentos.registrarResultado(client, lancamento.id, {
        status: lancamentos.STATUS.ERRO,
        erro: erro?.message || String(erro)
      });
    }
  }

  if (resumo.falhas) {
    resumo.alerta = `${resumo.falhas} ajuste(s) de inventario falharam. Veja o erro de cada um na fila de lancamentos.`;
  } else if (simulacao && resumo.simulados) {
    resumo.alerta = `${resumo.simulados} ajuste(s) apenas simulados. Nada foi enviado a OMIE.`;
  }

  return resumo;
}

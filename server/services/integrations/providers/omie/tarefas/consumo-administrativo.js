import { emSimulacao, modoDeEscrita } from "../../../core/escrita.js";
import * as lancamentos from "../../../core/stock-launches.repository.js";
import { ehLimiteDeTaxa, pausarIntegracao, segundosDeEspera } from "../../../core/pausa-integracao.js";
import {
  chamarOmie,
  ehAjusteJaExistente,
  ENDPOINTS,
  idDoAjusteJaExistente,
} from "../omie.api.js";
import { montarSaidaConsumoAdministrativo } from "../omie.operacoes.js";
import {
  idExternoDoProduto,
  valorUnitarioDoProduto,
} from "./transferencias.js";

const CALL = "IncluirAjusteEstoque";
const LANCAMENTOS_POR_JOB = 25;

// Texto fixo pedido pelo usuario (01/09/2026): motivo "PDV" nao diz por si so que a saida e de
// consumo administrativo, entao a observacao de cada lancamento deixa isso explicito no
// proprio registro da OMIE.
const OBSERVACAO_CONSUMO_ADMINISTRATIVO =
  "SAIDA PARA USO DE SETORES COMO ESCRITORIO, ACPASS e LIMPEZA.";

// Envia para a OMIE a SAIDA por consumo interno de um PDV Administrativo.
//
// "PDV Administrativo" nao e ponto de venda: e um setor interno (escritorio, limpeza,
// marketing, manutencao) que consome estoque sem vender. O que ele retira SAI do estoque --
// por isso o movimento e "SAI" e nunca "TRF": transferencia diria que a mercadoria continua
// na empresa, so que em outro local.
//
// Motivo confirmado pelo usuario em 01/09/2026 (MOTIVO_CONSUMO_ADMINISTRATIVO = "PDV" em
// omie.operacoes.js) -- a partir daqui esta tarefa segue a mesma trava generica das outras
// (core/escrita.js: so envia de verdade com modo_escrita = REAL), sem trava propria adicional.
export async function enviarConsumoAdministrativo(contexto) {
  const { client, integracao, segredos, configuracao, payload, fetchImpl } = contexto;
  const simulacao = emSimulacao(configuracao);

  const abertos = await lancamentos.listarAbertos(client, {
    integrationId: integracao.id,
    limite: Number(payload?.limite) || LANCAMENTOS_POR_JOB,
    apenas: payload?.apenas ? Number(payload.apenas) : null,
    // Filtro obrigatorio: sem ele esta tarefa leria transferencias e ajustes de inventario
    // e os marcaria como ERRO ao tentar montar uma saida em cima deles.
    eventos: [lancamentos.EVENTOS.CONSUMO_ADMINISTRATIVO],
  });

  const resumo = {
    modo: modoDeEscrita(configuracao),
    pendentes: abertos.length,
    simulados: 0,
    enviados: 0,
    falhas: 0,
    sem_vinculo_de_produto: 0,
  };

  if (!abertos.length) return resumo;

  for (const lancamento of abertos) {
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

      const { valor: valorUnitario, fonte: fonteDoValor } =
        await valorUnitarioDoProduto(
          client,
          integracao.id,
          lancamento.sku_produto,
        );

      const corpo = montarSaidaConsumoAdministrativo({
        chaveOperacao: lancamento.idempotency_key,
        idExternoProduto: idExterno,
        sku: lancamento.sku_produto,
        codigoLocalOrigem: lancamento.local_origem,
        quantidade: lancamento.quantidade,
        valorUnitario,
        observacao: `Consumo interno do pedido ${lancamento.codigo_pedido} (PDV Administrativo) no MyEstoque. ${OBSERVACAO_CONSUMO_ADMINISTRATIVO}`,
      });

      // fonte_valor e anotacao de auditoria e NAO vai na chamada: campo desconhecido faz a
      // OMIE recusar o payload inteiro.
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
        // Mesmo formato de resposta da transferencia (mesmo endpoint IncluirAjusteEstoque):
        // id_ajuste/id_movest, nao codigo_lancamento nem nCodAjuste.
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
      // Mesma trava da transferencia: bloqueio por limite de taxa para o lote inteiro aqui,
      // em vez de continuar queimando chamadas contra uma porta fechada.
      if (ehLimiteDeTaxa(erro)) {
        const espera = segundosDeEspera(erro);
        const pausa = await pausarIntegracao(client, integracao.id, {
          segundos: espera,
          motivo: erro.message,
        });
        resumo.falhas += 1;
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.ERRO,
          erro: erro?.message || String(erro),
        });
        resumo.bloqueado_por_limite = true;
        resumo.pausado_ate = pausa?.pausadaAte || null;
        resumo.alerta = espera
          ? `A API pediu para esperar ${espera}s. O restante da fila continua na proxima janela.`
          : "A API bloqueou o acesso por consumo. O restante da fila continua depois.";
        return resumo;
      }
      // Ajuste que ja existe na OMIE com a mesma chave: idempotencia funcionando, nao
      // falha. Sem este ramo o lancamento ficava em ERRO e era retentado para sempre.
      if (ehAjusteJaExistente(erro)) {
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.ENVIADO,
          externalId: idDoAjusteJaExistente(erro),
          erro: null
        });
        resumo.enviados = (resumo.enviados || 0) + 1;
        resumo.ja_existiam = (resumo.ja_existiam || 0) + 1;
        continue;
      }

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

import { emSimulacao, modoDeEscrita } from "../../../core/escrita.js";
import * as lancamentos from "../../../core/stock-launches.repository.js";
import {
  MOTIVO_CONSUMO_ADMINISTRATIVO_PENDENTE,
  montarSaidaConsumoAdministrativo,
} from "../omie.operacoes.js";
import {
  idExternoDoProduto,
  valorUnitarioDoProduto,
} from "./transferencias.js";

const LANCAMENTOS_POR_JOB = 25;

// Envia para a OMIE a SAIDA por consumo interno de um PDV Administrativo.
//
// "PDV Administrativo" nao e ponto de venda: e um setor interno (escritorio, limpeza,
// marketing, manutencao) que consome estoque sem vender. O que ele retira SAI do estoque --
// por isso o movimento e "SAI" e nunca "TRF": transferencia diria que a mercadoria continua
// na empresa, so que em outro local.
//
// ESTA TAREFA NAO ENVIA NADA HOJE. O motivo do ajuste ainda nao foi escolhido (ver
// MOTIVO_CONSUMO_ADMINISTRATIVO_PENDENTE em omie.operacoes.js: o dominio de "SAI" na OMIE nao
// tem um codigo para consumo interno). Enquanto o motivo for o sentinela, a tarefa se recusa a
// sair da simulacao -- mesmo com modo_escrita = REAL. Sao duas travas em serie, e nao uma:
// a generica do nucleo (modo REAL) e esta, especifica do motivo.
export async function enviarConsumoAdministrativo(contexto) {
  const { client, integracao, configuracao, payload } = contexto;

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
    bloqueado_por_motivo_pendente: false,
  };

  if (!abertos.length) return resumo;

  // Trava especifica: sem um motivo real escolhido, nada sai daqui em hipotese nenhuma.
  const motivoIndefinido =
    MOTIVO_CONSUMO_ADMINISTRATIVO_PENDENTE.startsWith("__");
  const simulacao = emSimulacao(configuracao) || motivoIndefinido;
  if (motivoIndefinido) {
    resumo.bloqueado_por_motivo_pendente = true;
    resumo.alerta =
      "Saída por consumo administrativo montada mas NÃO enviada: o código de motivo da OMIE para consumo interno ainda não foi escolhido.";
  }

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
        observacao: `Consumo interno do pedido ${lancamento.codigo_pedido} (PDV Administrativo) no MyEstoque.`,
      });

      // fonte_valor e anotacao de auditoria e NAO vai na chamada: campo desconhecido faz a
      // OMIE recusar o payload inteiro.
      const corpoGravado = { ...corpo, fonte_valor: fonteDoValor };

      if (simulacao) {
        await lancamentos.registrarResultado(client, lancamento.id, {
          status: lancamentos.STATUS.SIMULADO,
          payload: corpoGravado,
          resposta: {
            simulado: true,
            observacao: motivoIndefinido
              ? "Nada foi enviado a OMIE: o motivo do ajuste para consumo interno ainda nao foi escolhido."
              : "Nada foi enviado a OMIE (modo simulacao).",
          },
        });
        resumo.simulados += 1;
        continue;
      }

      // Inalcancavel enquanto o motivo for o sentinela. Fica explicito para o dia em que o
      // motivo real for escolhido: a partir dali, so a trava do nucleo (modo REAL) decide.
      throw new Error(
        "Envio real de consumo administrativo ainda nao liberado.",
      );
    } catch (erro) {
      resumo.falhas += 1;
      await lancamentos.registrarResultado(client, lancamento.id, {
        status: lancamentos.STATUS.ERRO,
        erro: erro?.message || String(erro),
      });
    }
  }

  return resumo;
}

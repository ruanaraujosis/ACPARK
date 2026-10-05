import { listarIntegracoesAtivas } from "./integration.repository.js";
import * as fila from "./job.queue.js";
import { obterProvider } from "./provider-registry.js";
import * as lancamentos from "./stock-launches.repository.js";
import { modoDeEscrita } from "./escrita.js";

// Ponte entre o fluxo de pedidos e a Central de Integracoes.
//
// Regra que manda aqui: NUNCA bloquear a operacao do usuario. A retirada conclui no MyEstoque
// independentemente da OMIE -- sem internet, sem integracao configurada, com a API fora do ar,
// o pedido finaliza igual e o lancamento fica pendente na fila. Por isso toda funcao deste
// arquivo engole o proprio erro: falhar em registrar um lancamento nao pode derrubar a
// transacao do pedido.

// Descobre a integracao ativa que tem capacidade de escrita de transferencia.
// Generico: procura pela capacidade declarada, nao por "OMIE".
async function integracaoDeEscrita(client) {
  const ativas = await listarIntegracoesAtivas(client);
  for (const integracao of ativas) {
    const provider = obterProvider(integracao.provedor);
    const capacidade = provider?.capacidades?.find((item) => item.escrita === true);
    if (capacidade) return { integracao, capacidade };
  }
  return null;
}

// Local externo vinculado a um PDV, quando existe
async function localDoPdv(client, integrationId, pdvId) {
  const resultado = await client.query(
    `SELECT omie_location_id FROM pdv_stock_location_mappings
     WHERE integration_id = $1 AND pdv_acpark_id = $2 AND active = TRUE
     LIMIT 1`,
    [integrationId, pdvId]
  );
  return resultado.rows[0]?.omie_location_id || null;
}

// Local externo de onde a mercadoria SAI: o do almoxarifado (origem NULL) ou o do PDV de
// origem numa transferencia entre PDVs. Sem vinculo devolve null -- quem chama ignora e avisa,
// nunca adivinha, porque um lancamento no local errado move estoque de verdade.
async function localDeOrigem(client, integracao, origemPdvId) {
  if (origemPdvId === null || origemPdvId === undefined) {
    return String(integracao.configuracao?.local_almoxarifado || "").trim() || null;
  }
  return localDoPdv(client, integracao.id, origemPdvId);
}

// Registra os lancamentos de transferencia de uma retirada confirmada e enfileira o envio.
//
// Devolve um resumo para a rota informar a tela, mas nunca lanca: se qualquer coisa der
// errado aqui, a retirada ja aconteceu e nao pode ser desfeita por causa da integracao.
export async function registrarTransferenciasDaRetirada(client, { codigoPedido, itens = [] }) {
  const resumo = { registrados: 0, ignorados: 0, motivo: null };

  try {
    const alvo = await integracaoDeEscrita(client);
    if (!alvo) {
      resumo.motivo = "Nenhuma integracao ativa com escrita habilitada.";
      return resumo;
    }

    const { integracao, capacidade } = alvo;

    for (const item of itens) {
      const quantidade = Number(item.quantidade) || 0;
      if (quantidade <= 0) {
        resumo.ignorados += 1;
        continue;
      }

      const localOrigem = await localDeOrigem(client, integracao, item.origemPdvId);
      if (!localOrigem) {
        resumo.ignorados += 1;
        resumo.motivo = item.origemPdvId
          ? "Ha PDV de origem sem local de estoque vinculado; a transferencia dele nao foi enfileirada."
          : "Local do almoxarifado nao configurado; nada foi enfileirado.";
        continue;
      }

      const localDestino = await localDoPdv(client, integracao.id, item.pdvId);
      if (!localDestino) {
        // Sem vinculo nao da para saber para qual local externo a mercadoria foi.
        // Ignorar e melhor que adivinhar: um lancamento no local errado move estoque de verdade.
        resumo.ignorados += 1;
        resumo.motivo = "Ha PDV sem local de estoque vinculado; a transferencia dele nao foi enfileirada.";
        continue;
      }

      await lancamentos.registrarLancamento(client, {
        integrationId: integracao.id,
        codigoPedido,
        pedidoItemId: item.pedidoItemId,
        sku: item.sku,
        pdvId: item.pdvId,
        quantidade,
        localOrigem,
        localDestino,
        evento: lancamentos.EVENTOS.RETIRADA,
        modo: modoDeEscrita(integracao.configuracao)
      });
      resumo.registrados += 1;
    }

    if (resumo.registrados) {
      // Enfileira o envio. Sem internet o job falha e volta sozinho: sincronizacao oportunista.
      await fila.enfileirar(client, {
        integrationId: integracao.id,
        capacidade: capacidade.id,
        prioridade: "ALTA"
      });
    }
  } catch (erro) {
    // A retirada ja concluiu; a falha aqui vira aviso, nunca excecao
    resumo.motivo = `Falha ao registrar a transferencia: ${erro?.message || erro}`;
  }

  return resumo;
}

// Compensacao: reabrir um pedido finalizado devolve o estoque ao almoxarifado no MyEstoque,
// entao a OMIE precisa receber o movimento inverso -- senao ela segue achando que a
// mercadoria esta no PDV e os dois sistemas divergem em silencio.
//
// A compensacao so e enfileirada quando o lancamento original REALMENTE foi enviado. Se ele
// ainda estava pendente ou apenas simulado, nada saiu da OMIE e o certo e cancelar o
// lancamento original em vez de mandar um estorno de algo que nunca entrou.
export async function registrarCompensacaoDaReabertura(client, { codigoPedido, itens = [] }) {
  const resumo = { compensados: 0, cancelados: 0, motivo: null };

  try {
    const alvo = await integracaoDeEscrita(client);
    if (!alvo) {
      // Sem motivo escrito, este retorno era mudo: devolvia zero em tudo e parecia "nada a
      // compensar", quando na verdade a integracao de escrita nao foi encontrada. Custou uma
      // investigacao inteira -- a causa era o registro de providers nao carregado.
      resumo.motivo = "Nenhuma integracao ativa com escrita habilitada.";
      return resumo;
    }
    const { integracao, capacidade } = alvo;

    for (const item of itens) {
      const quantidade = Number(item.quantidade) || 0;
      if (quantidade <= 0) continue;

      const enviado = await lancamentos.foiEnviado(client, {
        codigoPedido,
        pedidoItemId: item.pedidoItemId
      });

      if (!enviado) {
        // Nada foi para a OMIE: cancela o pendente em vez de compensar
        const cancelados = await client.query(
          `UPDATE integration_stock_launches
           SET status = 'CANCELADO',
               erro = 'Pedido reaberto antes do envio.',
               updated_at = CURRENT_TIMESTAMP
           WHERE codigo_pedido = $1
             AND pedido_item_id IS NOT DISTINCT FROM $2
             AND evento = 'RETIRADA'
             AND status IN ('PENDENTE', 'ERRO', 'SIMULADO')`,
          [codigoPedido, item.pedidoItemId]
        );
        resumo.cancelados += cancelados.rowCount || 0;
        continue;
      }

      const localDestino = await localDoPdv(client, integracao.id, item.pdvId);
      // Volta para o MESMO local de onde saiu: almoxarifado ou o PDV de origem
      const localRetorno = await localDeOrigem(client, integracao, item.origemPdvId);
      if (!localDestino || !localRetorno) continue;

      // Locais invertidos: volta do PDV para o local de origem
      await lancamentos.registrarLancamento(client, {
        integrationId: integracao.id,
        codigoPedido,
        pedidoItemId: item.pedidoItemId,
        sku: item.sku,
        pdvId: item.pdvId,
        quantidade,
        localOrigem: localDestino,
        localDestino: localRetorno,
        evento: lancamentos.EVENTOS.COMPENSACAO,
        modo: modoDeEscrita(integracao.configuracao)
      });
      resumo.compensados += 1;
    }

    if (resumo.compensados) {
      await fila.enfileirar(client, {
        integrationId: integracao.id,
        capacidade: capacidade.id,
        prioridade: "ALTA"
      });
    }
  } catch (erro) {
    resumo.motivo = `Falha ao registrar a compensacao: ${erro?.message || erro}`;
  }

  return resumo;
}

// ===== Consumo administrativo =====

// Procura a integracao ativa que declara uma capacidade especifica de escrita.
// Continua generica: recebe o id da capacidade, nao o nome de um provider.
async function integracaoDeEscritaPorCapacidade(client, capacidadeId) {
  const ativas = await listarIntegracoesAtivas(client);
  for (const integracao of ativas) {
    const provider = obterProvider(integracao.provedor);
    const capacidade = provider?.capacidades?.find(
      (item) => item.escrita === true && item.id === capacidadeId
    );
    if (capacidade) return { integracao, capacidade };
  }
  return null;
}

// Registra a SAIDA por consumo interno de um PDV Administrativo e enfileira o envio.
//
// Diferente da transferencia em dois pontos que importam:
//   1. Nao ha local de destino -- a mercadoria sai do estoque, nao muda de lugar. Por isso a
//      falta de vinculo do PDV NAO impede o lancamento: o que importa e o local de origem
//      (almoxarifado), e esse vem da configuracao da integracao.
//   2. O evento e CONSUMO_ADMIN, para a tarefa de transferencias nunca ler estas linhas e
//      montar TRF em cima delas.
//
// Como toda funcao deste arquivo, engole o proprio erro: a retirada ja aconteceu.
export async function registrarConsumoAdministrativo(client, { codigoPedido, itens = [] }) {
  const resumo = { registrados: 0, ignorados: 0, motivo: null };
  if (!itens.length) return resumo;

  try {
    const alvo = await integracaoDeEscritaPorCapacidade(client, "CONSUMO_ADMINISTRATIVO");
    if (!alvo) {
      resumo.motivo = "Nenhuma integracao ativa declara a saida por consumo administrativo.";
      return resumo;
    }

    const { integracao, capacidade } = alvo;

    for (const item of itens) {
      const quantidade = Number(item.quantidade) || 0;
      if (quantidade <= 0) {
        resumo.ignorados += 1;
        continue;
      }
      // Consumo sai do local de onde a mercadoria saiu (almoxarifado ou PDV de origem)
      const localOrigem = await localDeOrigem(client, integracao, item.origemPdvId);
      if (!localOrigem) {
        resumo.ignorados += 1;
        resumo.motivo = "Local de origem sem vinculo externo; a saida dele nao foi enfileirada.";
        continue;
      }
      await lancamentos.registrarLancamento(client, {
        integrationId: integracao.id,
        codigoPedido,
        pedidoItemId: item.pedidoItemId,
        sku: item.sku,
        pdvId: item.pdvId,
        quantidade,
        localOrigem,
        // Sem destino de proposito: consumo nao e mudanca de lugar.
        localDestino: null,
        evento: lancamentos.EVENTOS.CONSUMO_ADMINISTRATIVO,
        modo: modoDeEscrita(integracao.configuracao)
      });
      resumo.registrados += 1;
    }

    if (resumo.registrados) {
      await fila.enfileirar(client, {
        integrationId: integracao.id,
        capacidade: capacidade.id,
        prioridade: "ALTA"
      });
    }
  } catch (erro) {
    resumo.motivo = `Falha ao registrar o consumo administrativo: ${erro?.message || erro}`;
  }

  return resumo;
}

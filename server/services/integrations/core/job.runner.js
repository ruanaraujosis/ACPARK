import { comoIntegrationError } from "./errors.js";
import { emSimulacao, modoDeEscrita, validarEscritaPermitida } from "./escrita.js";
import { publishIntegrationEvent } from "./integration.events.js";
import {
  carregarComSegredos,
  registrarFalha,
  registrarSucesso as registrarSucessoIntegracao,
  validarConfiguracaoDaCapacidade,
  validarCredenciaisObrigatorias
} from "./integration.repository.js";
import * as fila from "./job.queue.js";
import { exigirCapacidade, exigirProvider } from "./provider-registry.js";
import * as estadoSync from "./sync-state.js";

// Executor de jobs: pega um job da fila, resolve o provider e a capacidade pelo registro,
// monta o contexto e chama o handler declarado pelo provider. Este arquivo nao sabe o que
// e OMIE nem o que a capacidade faz — so orquestra.

// Contexto entregue ao handler da capacidade. Tudo que o provider precisa vem daqui,
// para o handler ficar testavel sem banco e sem rede reais.
function montarContexto({ client, integracao, segredos, job, fetchImpl, estado, capacidade }) {
  return {
    client,
    integracao,
    segredos,
    // Ajustes nao-secretos da integracao, ja separados para a tarefa nao ter de
    // saber que eles moram numa coluna jsonb
    configuracao: integracao.configuracao || {},
    // Modo de escrita ja resolvido, para a tarefa nao ter de reimplementar o padrao seguro
    escrita: capacidade?.escrita === true,
    simulacao: emSimulacao(integracao.configuracao || {}),
    modoEscrita: modoDeEscrita(integracao.configuracao || {}),
    job,
    payload: job.payload || {},
    estado,
    fetchImpl,
    // Permite que uma capacidade agende outra (ex: produtos pedindo a proxima pagina,
    // ou um movimento novo pedindo a atualizacao de saldo daquele item)
    enfileirar: (capacidade, payload = {}, opcoes = {}) =>
      fila.enfileirar(client, {
        integrationId: integracao.id,
        capacidade,
        payload,
        prioridade: opcoes.prioridade || "NORMAL",
        agendadoPara: opcoes.agendadoPara || null
      })
  };
}

// Executa um job ja reservado (status PROCESSANDO). Devolve o job atualizado.
export async function executarJob(client, job, { fetchImpl } = {}) {
  try {
    // A tentativa e registrada ANTES de qualquer validacao, e nao depois.
    //
    // O agendador decide se uma capacidade venceu olhando last_success_at ou last_attempt_at.
    // Enquanto a validacao de configuracao lancava antes deste registro, uma integracao sem
    // o local do almoxarifado configurado nunca marcava tentativa: o tick a considerava
    // vencida de novo a cada 5 segundos, criava um job novo (o anterior ja estava num status
    // final, entao nao havia deduplicacao) e, por ser prioridade ALTA, ainda tomava a vez de
    // PRODUTOS na fila. Medido em producao: 227 falhas em 20 minutos e o catalogo nunca
    // importado. Registrando aqui, qualquer falha -- inclusive de configuracao -- respeita
    // o intervalo da capacidade.
    const estado = await estadoSync.obterEstado(client, job.integration_id, job.job_type);
    await estadoSync.registrarTentativa(client, job.integration_id, job.job_type);

    const { integracao, segredos } = await carregarComSegredos(client, job.integration_id);
    const provider = exigirProvider(integracao.provedor);
    const capacidade = exigirCapacidade(integracao.provedor, job.job_type);
    validarCredenciaisObrigatorias(provider, segredos);
    validarConfiguracaoDaCapacidade(provider, integracao.configuracao, capacidade);
    // Capacidade que altera dado no sistema externo tem trava propria
    validarEscritaPermitida(capacidade, integracao);

    const contexto = montarContexto({
      client,
      integracao,
      segredos,
      job,
      fetchImpl,
      estado,
      capacidade
    });
    const resultado = (await capacidade.executar(contexto)) || {};

    await estadoSync.registrarSucesso(client, integracao.id, capacidade.id, resultado.cursor || {});
    await registrarSucessoIntegracao(client, integracao.id);
    const concluido = await fila.concluir(client, job.id, resultado);

    publishIntegrationEvent("integration.job.updated", {
      id: job.id,
      integration_id: job.integration_id,
      job_type: job.job_type,
      status: concluido?.status
    });
    return concluido;
  } catch (erroBruto) {
    const { job: falhado, erro } = await fila.falhar(client, job, erroBruto);
    await estadoSync.registrarErro(client, job.integration_id, job.job_type, erro.message).catch(() => {});
    await registrarFalha(client, job.integration_id, erro).catch(() => {});
    publishIntegrationEvent("integration.job.updated", {
      id: job.id,
      integration_id: job.integration_id,
      job_type: job.job_type,
      status: falhado?.status,
      erro: erro.message
    });
    return falhado;
  }
}

// Pega o proximo job elegivel da fila e executa. Devolve null quando a fila esta vazia.
export async function executarProximoJob(client, opcoes = {}) {
  const job = await fila.reservarProximo(client);
  if (!job) return null;
  return executarJob(client, job, opcoes);
}

// Executa um job especifico pelo id (botao "Processar" da tela)
export async function executarJobPorId(client, id, opcoes = {}) {
  const job = await fila.reservarPorId(client, id);
  if (!job) return null;
  return executarJob(client, job, opcoes);
}

// Testa a conexao com a API externa usando o testarConexao declarado pelo provider.
// Nao passa pela fila: e uma chamada direta, sincrona, para o operador ver o resultado na hora.
export async function testarConexao(client, integrationId, { fetchImpl } = {}) {
  const { integracao, segredos } = await carregarComSegredos(client, integrationId);
  const provider = exigirProvider(integracao.provedor);
  if (typeof provider.testarConexao !== "function") {
    return {
      ok: true,
      mensagem: "Este provider nao oferece teste de conexao.",
      duracaoMs: 0
    };
  }
  validarCredenciaisObrigatorias(provider, segredos);
  const iniciadoEm = Date.now();
  try {
    const detalhe = await provider.testarConexao({
      integracao,
      segredos,
      fetchImpl,
      client
    });
    return {
      ok: true,
      duracaoMs: detalhe?.duracaoMs ?? Date.now() - iniciadoEm,
      detalhe
    };
  } catch (erroBruto) {
    const erro = comoIntegrationError(erroBruto);
    erro.duracaoMs = Date.now() - iniciadoEm;
    throw erro;
  }
}

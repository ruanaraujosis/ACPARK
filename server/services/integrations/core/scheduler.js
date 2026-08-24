import { tx } from "../../../db.js";
import { listarIntegracoesAtivas } from "./integration.repository.js";
import * as fila from "./job.queue.js";
import { executarProximoJob } from "./job.runner.js";
import { obterProvider } from "./provider-registry.js";
import { listarEstados } from "./sync-state.js";

// Agendador de todas as integracoes registradas.
//
// Diferenca central para a versao anterior: aqui o intervalo de cada capacidade e respeitado.
// Antes o tick enfileirava os tres tipos de job a cada 15 segundos, ignorando os intervalos
// declarados — foi assim que a tabela chegou a 102 mil linhas em 25 dias sem importar nada.

const TICK_PADRAO_MS = 15_000;
const INTERVALO_PODA_MS = 60 * 60_000;

let temporizador = null;
let executando = false;
let ultimaPodaEm = 0;

// Lê a habilitação do agendador. Aceita o nome novo e mantém OMIE_SCHEDULER_ENABLED
// funcionando, que é o que está no .env.local desta instalação.
export function agendadorHabilitado(env = process.env) {
  const valor = env.INTEGRATIONS_SCHEDULER_ENABLED ?? env.OMIE_SCHEDULER_ENABLED;
  return String(valor || "false").toLowerCase() === "true";
}

export function intervaloTickMs(env = process.env) {
  const bruto = Number(env.INTEGRATIONS_SCHEDULER_TICK_MS || env.OMIE_SCHEDULER_TICK_MS || 0);
  return Number.isFinite(bruto) && bruto >= 1000 ? bruto : TICK_PADRAO_MS;
}

// Intervalo efetivo de uma capacidade: o override salvo em integrations.sync_intervals vence
// o padrao declarado pelo provider. Chave do override = id da capacidade.
export function intervaloDaCapacidade(integracao, capacidade) {
  const overrides = integracao?.sync_intervals || {};
  const bruto = Number(overrides[capacidade.id] ?? overrides[String(capacidade.id).toLowerCase()]);
  if (Number.isFinite(bruto) && bruto > 0) return bruto;
  return Number(capacidade.intervaloPadraoMs) || 0;
}

// Decide se uma capacidade esta vencida com base no ultimo sucesso registrado
export function capacidadeVencida({ integracao, capacidade, estado, agora = Date.now() }) {
  if (capacidade.automatica === false) return false;
  const intervalo = intervaloDaCapacidade(integracao, capacidade);
  if (!intervalo) return false;
  const referencia = estado?.last_success_at || estado?.last_attempt_at;
  if (!referencia) return true;
  const ultimo = new Date(referencia).getTime();
  if (!Number.isFinite(ultimo)) return true;
  return agora - ultimo >= intervalo;
}

// Enfileira somente as capacidades vencidas de cada integracao ativa
export async function enfileirarCapacidadesVencidas(client, { agora = Date.now() } = {}) {
  const integracoes = await listarIntegracoesAtivas(client);
  const estados = await listarEstados(client);
  const enfileirados = [];

  for (const integracao of integracoes) {
    const provider = obterProvider(integracao.provedor);
    // Integracao apontando para um provider que nao existe mais no codigo: ignora em vez de
    // quebrar o tick inteiro das outras
    if (!provider) continue;

    for (const capacidade of provider.capacidades) {
      const estado = estados.find(
        (item) => String(item.integration_id) === String(integracao.id) && item.scope === capacidade.id
      );
      if (!capacidadeVencida({ integracao, capacidade, estado, agora })) continue;
      const job = await fila.enfileirar(client, {
        integrationId: integracao.id,
        capacidade: capacidade.id,
        prioridade: capacidade.prioridade || "NORMAL"
      });
      enfileirados.push(job);
    }
  }
  return enfileirados;
}

// Um ciclo do agendador: enfileira o que venceu e executa um job.
// A trava "executando" evita que um tick lento se sobreponha ao proximo.
export async function executarTick({ fetchImpl } = {}) {
  if (executando) return { ignorado: true };
  executando = true;
  try {
    const enfileirados = await tx((client) => enfileirarCapacidadesVencidas(client));
    // O job roda na propria transacao para que uma falha nele nao desfaca o enfileiramento
    const job = await tx((client) => executarProximoJob(client, { fetchImpl }));

    let podados = 0;
    if (Date.now() - ultimaPodaEm > INTERVALO_PODA_MS) {
      ultimaPodaEm = Date.now();
      podados = await tx((client) => fila.podarJobsAntigos(client)).catch(() => 0);
    }
    return { enfileirados: enfileirados.length, job, podados };
  } finally {
    executando = false;
  }
}

export function iniciarAgendador(env = process.env) {
  if (temporizador || !agendadorHabilitado(env)) return temporizador;
  temporizador = setInterval(() => {
    executarTick().catch((erro) => {
      console.error("Falha no tick de integracoes:", erro?.message || erro);
    });
  }, intervaloTickMs(env));
  // Nao segura o processo aberto se for o unico timer restante
  temporizador.unref?.();
  return temporizador;
}

export function pararAgendador() {
  if (!temporizador) return;
  clearInterval(temporizador);
  temporizador = null;
}

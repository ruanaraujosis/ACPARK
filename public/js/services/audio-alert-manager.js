import { toast } from "../ui/notifications.js";

// Chave no localStorage que lembra se o usuário já autorizou áudio neste navegador
const activationKey = "acparkOrderAlertsAudioEnabled";
// Limites de segurança para modos de repetição contínua (evita alerta tocando para sempre)
const maxContinuousRuns = 30;
const maxContinuousMs = 5 * 60 * 1000;

// Sequências de notas (frequência em Hz + duração em segundos) para cada toque disponível
const soundProfiles = {
  default: [{ frequency: 880, duration: 0.16 }, { frequency: 1175, duration: 0.2 }],
  bell: [{ frequency: 1046, duration: 0.28 }],
  soft: [{ frequency: 660, duration: 0.18 }, { frequency: 784, duration: 0.2 }],
  chime: [{ frequency: 523, duration: 0.12 }, { frequency: 659, duration: 0.12 }, { frequency: 784, duration: 0.22 }],
  double: [{ frequency: 900, duration: 0.12 }, { frequency: 0, duration: 0.08 }, { frequency: 900, duration: 0.16 }],
  "repetitive-alert": [{ frequency: 784, duration: 0.12 }, { frequency: 988, duration: 0.12 }, { frequency: 1175, duration: 0.2 }],
  "repetitive-bell": [{ frequency: 1175, duration: 0.12 }, { frequency: 0, duration: 0.05 }, { frequency: 1175, duration: 0.16 }],
  urgent: [{ frequency: 988, duration: 0.09 }, { frequency: 1318, duration: 0.09 }, { frequency: 988, duration: 0.09 }, { frequency: 1568, duration: 0.16 }],
  waiting: [{ frequency: 659, duration: 0.18 }, { frequency: 784, duration: 0.18 }, { frequency: 659, duration: 0.24 }],
  "soft-continuous": [{ frequency: 587, duration: 0.2 }, { frequency: 740, duration: 0.24 }]
};

// Mapeia cada modo de repetição escolhido pelo usuário para nº de repetições ou duração-limite
const repeatModeConfig = {
  once: { repetitions: 1 },
  two_times: { repetitions: 2 },
  three_times: { repetitions: 3 },
  thirty_seconds: { durationMs: 30000 },
  until_viewed: { untilStopped: true },
  until_service_start: { untilStopped: true }
};

// Estado do gerenciador de alertas: fila de pedidos aguardando som, alerta tocando no momento
// e o contexto de áudio compartilhado (Web Audio API)
const alertState = {
  queue: [],
  activeOrderIds: new Set(),
  current: null,
  timer: null,
  timerResolve: null,
  isPlaying: false,
  audioContext: null,
  cancelled: false,
  activeNodes: new Set(),
  audioUnlocked: localStorage.getItem(activationKey) === "true",
  blockedToastShown: false
};

// Espera "ms" milissegundos, mas de um jeito que pode ser interrompido por clearAlertTimer()
function delay(ms) {
  return new Promise((resolve) => {
    alertState.timerResolve = resolve;
    alertState.timer = setTimeout(() => {
      clearAlertTimer();
      alertState.timerResolve = null;
      resolve();
    }, ms);
  });
}

// Cancela o timer de espera atual e resolve a Promise pendente imediatamente (usado ao parar o alerta)
function clearAlertTimer() {
  if (alertState.timer) clearTimeout(alertState.timer);
  alertState.timer = null;
  const resolve = alertState.timerResolve;
  alertState.timerResolve = null;
  resolve?.();
}

// Cria (uma vez) e reaproveita o AudioContext do navegador para tocar os toques
function ensureAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  alertState.audioContext ||= new AudioCtx();
  return alertState.audioContext;
}

// Registra um nó de áudio ativo para que possa ser interrompido caso o alerta seja cancelado
function trackAudioNode(node) {
  alertState.activeNodes.add(node);
  node.addEventListener("ended", () => {
    alertState.activeNodes.delete(node);
    try {
      node.disconnect();
    } catch {
      // O nó pode já ter sido desconectado ao cancelar o alerta.
    }
  }, { once: true });
}

// Interrompe imediatamente todos os osciladores/nós de áudio tocando no momento
function stopActiveAudioNodes() {
  for (const node of alertState.activeNodes) {
    try {
      node.stop(0);
    } catch {
      // Alguns navegadores lançam erro quando o nó já foi encerrado.
    }
    try {
      node.disconnect();
    } catch {}
  }
  alertState.activeNodes.clear();
}

// Indica se o usuário já desbloqueou o áudio de alerta neste navegador
export function audioIsActivated() {
  return localStorage.getItem(activationKey) === "true";
}

// Desbloqueia o áudio (necessário por política dos navegadores: exige interação do usuário)
// tocando um pulso inaudível; em caso de sucesso, libera a fila de alertas pendentes
export async function activateAudioAlerts() {
  const ctx = ensureAudioContext();
  if (!ctx) {
    toast("Este navegador não permite áudio interno.", "error");
    return false;
  }
  try {
    localStorage.setItem(activationKey, "true");
    if (ctx.state === "suspended") await ctx.resume();
    await playUnlockPulse(ctx);
    alertState.audioUnlocked = true;
    alertState.blockedToastShown = false;
    drainQueue();
    return true;
  } catch (error) {
    console.error("Falha ao ativar audio de alerta", {
      name: error?.name,
      message: error?.message
    });
    toast("O navegador bloqueou o áudio. Clique para ativar.", "error");
    return false;
  }
}

// Toca um som muito curto e quase silencioso apenas para "destravar" o áudio no navegador
async function playUnlockPulse(ctx) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = ctx.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(440, start);
  gain.gain.setValueAtTime(0.0001, start);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.03);
  await new Promise((resolve) => {
    oscillator.addEventListener("ended", resolve, { once: true });
  });
}

// Aplica valores padrão e limites válidos às preferências de alerta sonoro do usuário
function normalizePreferences(preferences = {}) {
  return {
    enabled: preferences.enabled !== false,
    soundId: preferences.soundId || "repetitive-alert",
    volume: Math.max(0, Math.min(100, Number(preferences.volume ?? 70))),
    repeatMode: preferences.repeatMode || "three_times",
    repeatIntervalSeconds: [3, 5, 10, 15, 30].includes(Number(preferences.repeatIntervalSeconds))
      ? Number(preferences.repeatIntervalSeconds)
      : 5,
    stopOnView: preferences.stopOnView !== false,
    stopOnServiceStart: preferences.stopOnServiceStart !== false
  };
}

// Toca uma sequência de notas (perfil de som) usando osciladores Web Audio; retorna false se
// o áudio não estiver ativado ou não for suportado
async function playTone(soundId, volume) {
  if (!audioIsActivated()) return false;
  const ctx = ensureAudioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") await ctx.resume();
  const profile = soundProfiles[soundId] || soundProfiles.default;
  let start = ctx.currentTime;
  for (const note of profile) {
    if (alertState.cancelled) break;
    const duration = Math.max(0.05, Number(note.duration || 0.12));
    if (Number(note.frequency) > 0) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      trackAudioNode(oscillator);
      oscillator.type = soundId === "urgent" ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(Number(note.frequency), start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, Number(volume) / 100 * 0.2), start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    }
    start += duration;
  }
  await delay(Math.max(250, (start - ctx.currentTime) * 1000 + 80));
  return true;
}

// Pausa a fila de alertas e avisa o usuário que precisa clicar para ativar o áudio no navegador
function pauseUntilAudioActivation() {
  clearAlertTimer();
  alertState.current = null;
  alertState.isPlaying = false;
  alertState.cancelled = false;
  if (!alertState.blockedToastShown) {
    toast("O navegador bloqueou o som. Clique em Ativar áudio neste navegador.", "error");
    alertState.blockedToastShown = true;
  }
}

// Converte o modo de repetição das preferências em nº de repetições e duração máxima efetivos
function repeatLimit(preferences) {
  const config = repeatModeConfig[preferences.repeatMode] || repeatModeConfig.three_times;
  if (config.repetitions) return { repetitions: config.repetitions, durationMs: null };
  return {
    repetitions: maxContinuousRuns,
    durationMs: Math.min(config.durationMs || maxContinuousMs, maxContinuousMs)
  };
}

// Processa a fila de alertas um de cada vez: toca o próximo pedido, repetindo conforme as
// preferências, e ao terminar chama a si mesma recursivamente para seguir a fila
async function drainQueue() {
  if (alertState.isPlaying) return;
  if (!audioIsActivated()) {
    if (alertState.queue.length) pauseUntilAudioActivation();
    return;
  }
  const next = alertState.queue.shift();
  if (!next) return;
  alertState.current = next;
  alertState.isPlaying = true;
  alertState.cancelled = false;
  const preferences = normalizePreferences(next.preferences);
  const { repetitions, durationMs } = repeatLimit(preferences);
  const startedAt = Date.now();

  try {
    for (let index = 0; index < repetitions; index += 1) {
      if (alertState.cancelled || next.shouldStop?.()) break;
      if (durationMs && Date.now() - startedAt >= durationMs) break;
      const played = await playTone(preferences.soundId, preferences.volume);
      if (!played) {
        alertState.queue.unshift(next);
        pauseUntilAudioActivation();
        return;
      }
      if (index < repetitions - 1 && !alertState.cancelled && !next.shouldStop?.()) {
        await delay(preferences.repeatIntervalSeconds * 1000);
      }
    }
  } catch (error) {
    console.error("Erro ao reproduzir alerta sonoro", {
      name: error?.name,
      message: error?.message
    });
    alertState.queue.unshift(next);
    pauseUntilAudioActivation();
    return;
    toast("Não foi possível reproduzir o alerta sonoro.", "error");
  } finally {
    if (alertState.current === next) {
      alertState.activeOrderIds.delete(next.orderId);
      alertState.current = null;
      alertState.isPlaying = false;
      alertState.timer = null;
      alertState.cancelled = false;
      drainQueue();
    }
  }
}

// Adiciona um pedido à fila de alertas sonoros (ignora se já estiver na fila/tocando)
export function enqueueOrderAlert({ orderId, preferences, shouldStop }) {
  if (!orderId || alertState.activeOrderIds.has(orderId)) return;
  const normalized = normalizePreferences(preferences);
  if (!normalized.enabled || normalized.volume <= 0) return;
  alertState.activeOrderIds.add(orderId);
  alertState.queue.push({ orderId, preferences: normalized, shouldStop });
  drainQueue();
}

// Toca o alerta imediatamente com as preferências informadas, usado no botão "Testar alerta"
export async function testOrderAlert(preferences = {}) {
  stopCurrentOrderAlert();
  const normalized = normalizePreferences(preferences);
  alertState.current = { orderId: "test", preferences: normalized };
  alertState.isPlaying = true;
  alertState.cancelled = false;
  const { repetitions, durationMs } = repeatLimit(normalized);
  const startedAt = Date.now();
  try {
    for (let index = 0; index < repetitions; index += 1) {
      if (alertState.cancelled) break;
      if (durationMs && Date.now() - startedAt >= durationMs) break;
      const played = await playTone(normalized.soundId, normalized.volume);
      if (!played) {
        pauseUntilAudioActivation();
        break;
      }
      if (index < repetitions - 1 && !alertState.cancelled) {
        await delay(normalized.repeatIntervalSeconds * 1000);
      }
    }
  } finally {
    alertState.current = null;
    alertState.isPlaying = false;
    alertState.timer = null;
    alertState.cancelled = false;
  }
}

// Interrompe o alerta de um pedido específico (ou de todos, se orderId for omitido)
export function stopCurrentOrderAlert(orderId = null) {
  if (orderId) {
    alertState.queue = alertState.queue.filter((item) => item.orderId !== orderId);
    alertState.activeOrderIds.delete(orderId);
    if (alertState.current?.orderId && alertState.current.orderId !== orderId) return;
    alertState.cancelled = true;
    stopActiveAudioNodes();
    clearAlertTimer();
    if (!alertState.current) {
      alertState.isPlaying = false;
      drainQueue();
    }
  } else {
    alertState.cancelled = true;
    stopActiveAudioNodes();
    clearAlertTimer();
    alertState.queue = [];
    alertState.activeOrderIds.clear();
  }
}

// Interrompe e limpa todos os alertas sonoros pendentes/tocando
export function stopAllOrderAlerts() {
  stopCurrentOrderAlert();
}

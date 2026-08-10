import { request } from "../api/api-client.js";
import { runAutoRefreshNow } from "../ui/auto-refresh.js";
import { state } from "../state/app-state.js";
import { toast } from "../ui/notifications.js";
import { esc } from "../ui.js";
import { uuid } from "../utils/uuid.js";
import {
  activateAudioAlerts,
  audioIsActivated,
  enqueueOrderAlert,
  stopAllOrderAlerts,
  stopCurrentOrderAlert,
  testOrderAlert
} from "./audio-alert-manager.js";

// Chaves de armazenamento (sessão/local) usadas para persistir estado dos alertas entre navegações e abas
const storageKey = "acparkNotifiedOrderEvents";
const viewedStorageKey = "acparkViewedOrderAlerts";
const silencedStorageKey = "acparkSilencedOrderAlerts";
const activeStorageKey = "acparkActiveOrderAlerts";
const focusOrderKey = "acparkFocusReleaseOrder";
const tabLockPrefix = "acparkOrderAlertLock:";
// Nome do BroadcastChannel usado para sincronizar o estado dos alertas entre abas abertas
const channelName = "acpark-order-alerts";
// Preferências padrão de alerta sonoro/visual, usadas antes do usuário salvar as próprias
const defaultPreferences = {
  enabled: true,
  soundId: "repetitive-alert",
  volume: 70,
  visualNotifications: true,
  repeatMode: "three_times",
  repeatIntervalSeconds: 5,
  stopOnView: true,
  stopOnServiceStart: true
};

// Conexão SSE com o servidor (canal preferencial de notificação em tempo real)
let eventSource = null;
// Timer do polling usado como alternativa quando SSE não está disponível/falha
let fallbackTimer = null;
let preferences = { ...defaultPreferences };
let sounds = [];
let routeCallback = null;
let refreshReleaseCallback = null;
let lastPendingBaseline = null;
let lastPendingIds = new Set();
// IDs de eventos já processados nesta sessão, para não notificar o mesmo pedido duas vezes
const notifiedEventIds = new Set(readStoredEvents());
// IDs de pedidos/eventos já vistos ou silenciados pelo usuário (não devem tocar/aparecer de novo)
const viewedAlertIds = new Set(readStoredList(viewedStorageKey));
const silencedAlertIds = new Set(readStoredList(silencedStorageKey));
// Alertas visuais atualmente exibidos na tela, indexados por orderId
const activeAlerts = new Map(readStoredActiveAlerts().map((alert) => [alert.orderId, alert]));
// Identificador único desta aba, usado para coordenar qual aba toca o som quando há várias abertas
const tabId = uuid();
const broadcast = "BroadcastChannel" in window ? new BroadcastChannel(channelName) : null;

function readStoredEvents() {
  return readStoredList(storageKey);
}

// Lê uma lista JSON salva no sessionStorage, retornando array vazio em caso de erro/ausência
function readStoredList(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

// Adiciona um valor a um Set e persiste no sessionStorage, mantendo só os 160 mais recentes
function rememberListValue(key, set, value) {
  if (!value) return;
  set.add(String(value));
  const values = [...set].slice(-160);
  sessionStorage.setItem(key, JSON.stringify(values));
}

// Recupera os alertas visuais ativos salvos, descartando os com mais de 6 horas
function readStoredActiveAlerts() {
  try {
    const alerts = JSON.parse(sessionStorage.getItem(activeStorageKey) || "[]");
    if (!Array.isArray(alerts)) return [];
    const now = Date.now();
    return alerts.filter((alert) => alert?.orderId && now - Number(alert.savedAt || now) < 6 * 60 * 60 * 1000);
  } catch {
    return [];
  }
}

// Salva os alertas visuais ativos no sessionStorage (mantém só os 20 mais recentes)
function persistActiveAlerts() {
  const alerts = [...activeAlerts.values()].slice(-20).map((alert) => ({
    ...alert,
    savedAt: alert.savedAt || Date.now()
  }));
  sessionStorage.setItem(activeStorageKey, JSON.stringify(alerts));
}

function rememberEvent(eventId) {
  if (!eventId) return;
  rememberListValue(storageKey, notifiedEventIds, eventId);
}

// Um pedido/evento é considerado dispensado se já foi visualizado ou silenciado pelo usuário
function isDismissed(orderId, eventId) {
  return viewedAlertIds.has(String(orderId)) || silencedAlertIds.has(String(orderId))
    || viewedAlertIds.has(String(eventId)) || silencedAlertIds.has(String(eventId));
}

// Usa um lock no localStorage para garantir que, com várias abas abertas, só uma delas toque
// o som do mesmo evento (lock expira em 15s para não travar caso a aba feche)
function canThisTabPlay(eventId) {
  if (!eventId) return true;
  const key = `${tabLockPrefix}${eventId}`;
  const now = Date.now();
  try {
    const current = JSON.parse(localStorage.getItem(key) || "null");
    if (current?.tabId && current.tabId !== tabId && now - Number(current.at || 0) < 15000) return false;
    localStorage.setItem(key, JSON.stringify({ tabId, at: now }));
    return true;
  } catch {
    return true;
  }
}

// Aplica valores padrão e limites válidos às preferências recebidas do servidor/formulário
function normalizePreferences(next = {}) {
  return {
    ...defaultPreferences,
    ...next,
    volume: Math.max(0, Math.min(100, Number(next.volume ?? defaultPreferences.volume))),
    repeatIntervalSeconds: [3, 5, 10, 15, 30].includes(Number(next.repeatIntervalSeconds))
      ? Number(next.repeatIntervalSeconds)
      : defaultPreferences.repeatIntervalSeconds
  };
}

// Extrai um identificador de pedido a partir de diferentes formatos de evento
function orderIdFromEvent(event = {}) {
  return String(event.orderId || event.orderNumber || event.eventId || "");
}

// Cria (uma vez) o container fixo onde os cartões de alerta visual de pedido são exibidos
function ensureOrderAlertContainer() {
  let root = document.querySelector("#order-alert-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "order-alert-root";
    root.className = "order-alert-container";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "false");
    document.body.appendChild(root);
  }
  return root;
}

// Mostra/esconde o botão "Ativar áudio" conforme o perfil do usuário e se o áudio já foi liberado
function updateActivationButton() {
  const button = document.querySelector("#order-alert-activate");
  if (!button) return;
  const shouldShow = state.user?.role === "admin" && preferences.enabled && !audioIsActivated();
  button.classList.toggle("hidden", !shouldShow);
}

// Desbloqueia o áudio de alertas neste navegador/aba e retoma alertas ativos que estavam pausados
export async function activateOrderAlertAudio() {
  const ok = await activateAudioAlerts();
  updateActivationButton();
  if (ok) {
    requeueActiveAudioAlerts();
    toast("Alertas sonoros ativados.");
  }
  return ok;
}

// Recoloca na fila de som os alertas visuais que já estavam ativos (ex: após ativar o áudio)
function requeueActiveAudioAlerts() {
  activeAlerts.forEach((alert) => {
    if (isDismissed(alert.orderId, alert.eventId) || !canThisTabPlay(alert.eventId)) return;
    enqueueOrderAlert({
      orderId: alert.orderId,
      preferences,
      shouldStop: () => shouldStopByStatus(alert.orderId)
    });
  });
}

// Remove o cartão de alerta visual da tela e do estado ativo
function removeAlertCard(orderId) {
  document.querySelector(`[data-order-alert-card="${CSS.escape(String(orderId))}"]`)?.remove();
  activeAlerts.delete(String(orderId));
  persistActiveAlerts();
}

// Marca um alerta como encerrado (visualizado, silenciado ou atendimento iniciado), interrompe
// o som, remove o cartão e avisa as outras abas via BroadcastChannel
function markAlertStopped(orderId, eventId, reason) {
  const key = reason === "VIEWED" ? viewedStorageKey : silencedStorageKey;
  const set = reason === "VIEWED" ? viewedAlertIds : silencedAlertIds;
  rememberListValue(key, set, orderId);
  rememberListValue(key, set, eventId);
  stopAllOrderAlerts();
  removeAlertCard(orderId);
  broadcast?.postMessage({ type: "ORDER_ALERT_STOPPED", orderId, eventId, reason });
}

// Ação do botão "Visualizar": para o alerta e navega até a tela de Liberação focando o pedido
function openReleaseAndStop(orderId, eventId, button = null) {
  if (button) {
    button.disabled = true;
    button.textContent = "Abrindo pedido...";
  }
  stopAllOrderAlerts();
  markAlertStopped(orderId, eventId, "VIEWED");
  sessionStorage.setItem(focusOrderKey, String(orderId));
  routeCallback?.("release");
}

// Ação do botão "Silenciar": marca o alerta como silenciado sem abrir o pedido
function silenceOrder(orderId, eventId, button = null) {
  if (button) {
    button.disabled = true;
    button.textContent = "Silenciando...";
  }
  markAlertStopped(orderId, eventId, "SILENCED");
}

// Cria e exibe o cartão de notificação visual de um novo pedido, com ações "Visualizar"/"Silenciar"
function showOrderToast(event) {
  if (!preferences.visualNotifications) return;
  const orderId = orderIdFromEvent(event);
  const eventId = event.eventId || orderId;
  if (!orderId || isDismissed(orderId, eventId)) return;
  if (document.querySelector(`[data-order-alert-card="${CSS.escape(orderId)}"]`)) return;
  const root = ensureOrderAlertContainer();
  const itemCount = Number(event.itemCount || 0);
  const node = document.createElement("div");
  node.className = "toast ok order-alert-toast";
  node.dataset.orderAlertCard = orderId;
  node.setAttribute("role", "status");
  node.innerHTML = `
    <div class="order-alert-toast-title">Novo pedido recebido</div>
    <div class="order-alert-toast-meta">
      <strong>${esc(event.orderNumber || "Pedido")}</strong>
      <span>${esc(event.pointName || "PDV")}</span>
      <span>${itemCount ? `${itemCount} produto(s)` : "Aguardando itens"}</span>
    </div>
    <div class="order-alert-toast-actions">
      <button type="button" class="toast-action-btn" data-order-alert-view>Visualizar</button>
      <button type="button" class="toast-action-btn secondary" data-order-alert-silence>Silenciar alerta</button>
    </div>
  `;
  node.querySelector("[data-order-alert-view]")?.addEventListener("click", (clickEvent) => {
    openReleaseAndStop(orderId, eventId, clickEvent.currentTarget);
  });
  node.querySelector("[data-order-alert-silence]")?.addEventListener("click", (clickEvent) => {
    silenceOrder(orderId, eventId, clickEvent.currentTarget);
  });
  root.appendChild(node);
  activeAlerts.set(orderId, {
    eventId,
    orderId,
    orderNumber: event.orderNumber || "Pedido",
    pointName: event.pointName || "PDV",
    itemCount,
    createdAt: event.createdAt || new Date().toISOString(),
    status: "ALERTING",
    savedAt: Date.now()
  });
  persistActiveAlerts();
}

// Exibe alertas visuais para pedidos pendentes trazidos por um snapshot (usado no polling/fallback)
function showPendingSnapshotAlerts(snapshot = {}) {
  if (!preferences.visualNotifications || state.user?.role !== "admin") return;
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  for (const order of orders) {
    const orderId = orderIdFromEvent(order);
    const eventId = order.eventId || `pending:${orderId}`;
    if (!orderId || !snapshot.ids?.has(orderId) || isDismissed(orderId, eventId)) continue;
    showOrderToast({ ...order, eventId });
  }
}

// Busca no servidor o resumo atual de pedidos pendentes de liberação
async function fetchPendingSnapshot() {
  const summary = await request("/api/admin/order-alert-summary", { silentLoading: true });
  const ids = Array.isArray(summary.pendingOrderIds)
    ? summary.pendingOrderIds.map(String).filter(Boolean)
    : Array.isArray(summary.pendingOrders)
      ? summary.pendingOrders.map((item) => String(item.orderId || item.orderNumber)).filter(Boolean)
      : [];
  return {
    count: Number(summary.pending || 0),
    ids: new Set(ids),
    orders: Array.isArray(summary.pendingOrders) ? summary.pendingOrders : []
  };
}

// Atualiza apenas o contador/badge de pedidos pendentes (sem recarregar a tela de Liberação)
async function refreshCountersOnly() {
  if (state.user?.role !== "admin") return null;
  try {
    const snapshot = await fetchPendingSnapshot();
    state.orderAlertPendingCount = snapshot.count;
    document.querySelectorAll("[data-global-release-count]").forEach((node) => {
      node.textContent = String(state.orderAlertPendingCount || 0);
      node.classList.toggle("hidden", !state.orderAlertPendingCount);
    });
    reconcileActiveAlerts(snapshot.ids);
    return snapshot;
  } catch {
    return null;
  }
}

// Atualiza os contadores e, se a tela de Liberação estiver aberta no momento, recarrega seus dados
async function refreshReleaseIfOpen() {
  const snapshot = await refreshCountersOnly();
  if (state.currentView === "release") {
    await refreshReleaseCallback?.();
  }
  return snapshot;
}

// Condição usada pelo tocador de som para parar de repetir quando o pedido sai da lista de
// pendentes (ou seja, o atendimento já começou), respeitando a preferência stopOnServiceStart
function shouldStopByStatus(orderId) {
  if (!preferences.stopOnServiceStart || !orderId) return false;
  return !lastPendingIds.has(String(orderId));
}

// Encerra alertas de pedidos que saíram da lista de pendentes (atendimento iniciado) quando a
// preferência stopOnServiceStart está ativa
function reconcileActiveAlerts(pendingIds = new Set()) {
  for (const [orderId, alert] of activeAlerts.entries()) {
    if (!pendingIds.has(String(orderId)) && preferences.stopOnServiceStart) {
      markAlertStopped(orderId, alert.eventId, "SERVICE_STARTED");
    }
  }
}

// Processa um novo evento de pedido (vindo do SSE ou do polling de fallback): evita duplicados,
// mostra o toast visual e enfileira o som (se esta aba tiver permissão para tocar)
async function handleNewOrderEvent(event) {
  const orderId = orderIdFromEvent(event);
  const eventId = event.eventId || `${event.orderNumber || ""}:${event.createdAt || ""}`;
  if (!eventId || notifiedEventIds.has(eventId) || isDismissed(orderId, eventId)) return;
  rememberEvent(eventId);
  broadcast?.postMessage({ type: "order-alert-processed", eventId });
  showOrderToast(event);
  if (canThisTabPlay(eventId)) {
    if (orderId) lastPendingIds.add(orderId);
    enqueueOrderAlert({
      orderId: orderId || eventId,
      preferences,
      shouldStop: () => shouldStopByStatus(orderId)
    });
  }
  await refreshReleaseIfOpen();
}

// Alternativa ao SSE: consulta o servidor a cada 12s em busca de novos pedidos pendentes.
// Usada quando o navegador não suporta EventSource ou a conexão SSE falha
async function startFallbackPolling() {
  if (fallbackTimer || state.user?.role !== "admin") return;
  try {
    const snapshot = await fetchPendingSnapshot();
    lastPendingBaseline = snapshot.count;
    lastPendingIds = snapshot.ids;
    state.orderAlertPendingCount = snapshot.count;
    showPendingSnapshotAlerts(snapshot);
  } catch {
    lastPendingBaseline = 0;
    lastPendingIds = new Set();
  }
  fallbackTimer = setInterval(async () => {
    if (state.user?.role !== "admin") return;
    try {
      const snapshot = await fetchPendingSnapshot();
      showPendingSnapshotAlerts(snapshot);
      const newOrders = snapshot.orders.filter((item) => {
        const orderId = String(item.orderId || item.orderNumber || "");
        return orderId && !lastPendingIds.has(orderId);
      });
      for (const order of newOrders) {
        const eventId = `fallback:${order.orderId || order.orderNumber}`;
        if (notifiedEventIds.has(eventId)) continue;
        await handleNewOrderEvent({ ...order, eventId });
      }
      if (!newOrders.length && lastPendingBaseline !== null && snapshot.count > lastPendingBaseline) {
        const eventId = `fallback:count:${snapshot.count}:${Date.now()}`;
        toast(snapshot.count - lastPendingBaseline === 1 ? "Novo pedido recebido." : "Novos pedidos recebidos.");
        if (canThisTabPlay(eventId)) {
          enqueueOrderAlert({ orderId: eventId, preferences, shouldStop: () => false });
        }
        await refreshReleaseIfOpen();
      }
      lastPendingBaseline = snapshot.count;
      lastPendingIds = snapshot.ids;
      state.orderAlertPendingCount = snapshot.count;
    } catch {
      // Tenta de novo no proximo ciclo.
    }
  }, 12000);
}

// Inicializa o sistema de alertas de novos pedidos para o Almoxarifado: carrega preferências,
// mostra alertas já ativos, busca o snapshot inicial e abre a conexão SSE (com fallback para polling)
export async function startOrderAlerts(options = {}) {
  if (state.user?.role !== "admin") {
    stopOrderAlerts();
    return;
  }
  routeCallback = options.route || routeCallback;
  refreshReleaseCallback = options.refreshRelease || refreshReleaseCallback;
  try {
    const data = await request("/api/user/order-alert-preferences", { silentLoading: true });
    preferences = normalizePreferences(data.preferences || preferences);
    sounds = data.sounds || [];
  } catch {
    preferences = { ...defaultPreferences };
  }
  updateActivationButton();
  activeAlerts.forEach((alert) => {
    if (!isDismissed(alert.orderId, alert.eventId)) showOrderToast(alert);
  });
  const snapshot = await refreshCountersOnly();
  if (snapshot) {
    lastPendingBaseline = snapshot.count;
    lastPendingIds = snapshot.ids;
    showPendingSnapshotAlerts(snapshot);
  }
  if (eventSource) return;
  if (!window.EventSource) {
    await startFallbackPolling();
    return;
  }
  eventSource = new EventSource("/api/admin/order-alert-events");
  eventSource.addEventListener("NEW_PENDING_ORDER", (message) => {
    try {
      handleNewOrderEvent(JSON.parse(message.data || "{}"));
    } catch {
      toast("Novo pedido recebido.");
    }
  });
  // Mudança de etapa: atualiza a tela na hora, sem esperar o ciclo de 12s do fallback
  eventSource.addEventListener("ORDER_STATUS_CHANGED", (message) => {
    let evento = {};
    try {
      evento = JSON.parse(message.data || "{}");
    } catch {
      evento = {};
    }
    window.dispatchEvent(new CustomEvent("order-status-changed", { detail: evento }));
    runAutoRefreshNow();
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    startFallbackPolling();
  };
}

// Encerra completamente o sistema de alertas: fecha SSE/polling, para sons e limpa a UI
export function stopOrderAlerts() {
  eventSource?.close();
  eventSource = null;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  lastPendingBaseline = null;
  lastPendingIds = new Set();
  stopAllOrderAlerts();
  document.querySelector("#order-alert-root")?.remove();
  activeAlerts.clear();
  persistActiveAlerts();
}

// Sincroniza entre abas: replica eventos já notificados e alertas encerrados em outras abas
broadcast?.addEventListener("message", (event) => {
  if (event.data?.type === "order-alert-processed" && event.data.eventId) {
    rememberEvent(event.data.eventId);
  }
  if (event.data?.type === "order-alert-silenced") {
    stopAllOrderAlerts();
  }
  if (event.data?.type === "ORDER_ALERT_STOPPED") {
    const reason = event.data.reason === "VIEWED" ? "VIEWED" : "SILENCED";
    const key = reason === "VIEWED" ? viewedStorageKey : silencedStorageKey;
    const set = reason === "VIEWED" ? viewedAlertIds : silencedAlertIds;
    rememberListValue(key, set, event.data.orderId);
    rememberListValue(key, set, event.data.eventId);
    stopAllOrderAlerts();
    removeAlertCard(event.data.orderId);
  }
});

// Monta as <option> de toques disponíveis para o formulário de configurações de alerta
function renderSoundOptions() {
  const soundOptions = sounds.length ? sounds : [
    { id: "repetitive-alert", displayName: "Alerta repetitivo" },
    { id: "repetitive-bell", displayName: "Campainha repetitiva" },
    { id: "urgent", displayName: "Chamada urgente" },
    { id: "waiting", displayName: "Pedido aguardando" },
    { id: "soft-continuous", displayName: "Alerta continuo suave" },
    { id: "default", displayName: "Alerta padrao" }
  ];
  return soundOptions
    .map((sound) => `<option value="${esc(sound.id)}" ${sound.id === preferences.soundId ? "selected" : ""}>${esc(sound.displayName)}</option>`)
    .join("");
}

// Renderiza o formulário de configurações de alerta sonoro/visual (usado nas telas do Almoxarifado)
export function renderOrderAlertSettings() {
  preferences = normalizePreferences(preferences);
  return `
    <form id="order-alert-settings-form" class="card grid gap-4">
      <div>
        <p class="eyebrow">Alertas de novos pedidos</p>
        <h3 class="text-xl font-black">Alerta sonoro global</h3>
        <p class="text-sm text-slate-500">Funciona para o Almoxarifado em qualquer pagina interna enquanto o sistema estiver aberto.</p>
      </div>
      <label class="alert-toggle-row">
        <input name="enabled" type="checkbox" ${preferences.enabled ? "checked" : ""} />
        <span>Ativar alerta sonoro</span>
      </label>
      <div class="alert-settings-grid">
        <label class="grid gap-1 text-sm font-bold">Toque
          <select name="soundId">${renderSoundOptions()}</select>
        </label>
        <label class="grid gap-1 text-sm font-bold">Repeticao
          <select name="repeatMode">
            <option value="once" ${preferences.repeatMode === "once" ? "selected" : ""}>Tocar uma vez</option>
            <option value="two_times" ${preferences.repeatMode === "two_times" ? "selected" : ""}>Tocar 2 vezes</option>
            <option value="three_times" ${preferences.repeatMode === "three_times" ? "selected" : ""}>Tocar 3 vezes</option>
            <option value="thirty_seconds" ${preferences.repeatMode === "thirty_seconds" ? "selected" : ""}>Repetir por 30 segundos</option>
            <option value="until_viewed" ${preferences.repeatMode === "until_viewed" ? "selected" : ""}>Repetir ate visualizar</option>
            <option value="until_service_start" ${preferences.repeatMode === "until_service_start" ? "selected" : ""}>Repetir ate iniciar atendimento</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm font-bold">Intervalo
          <select name="repeatIntervalSeconds">
            ${[3, 5, 10, 15, 30].map((seconds) => `<option value="${seconds}" ${Number(preferences.repeatIntervalSeconds) === seconds ? "selected" : ""}>${seconds} segundos</option>`).join("")}
          </select>
        </label>
      </div>
      <label class="grid gap-2 text-sm font-bold">Volume
        <div class="alert-volume-row">
          <input name="volume" type="range" min="0" max="100" value="${Number(preferences.volume || 70)}" />
          <strong id="order-alert-volume-label">${Number(preferences.volume || 70)}%</strong>
        </div>
      </label>
      <div class="alert-settings-grid">
        <label class="alert-toggle-row">
          <input name="visualNotifications" type="checkbox" ${preferences.visualNotifications ? "checked" : ""} />
          <span>Exibir notificacao visual</span>
        </label>
        <label class="alert-toggle-row">
          <input name="stopOnView" type="checkbox" ${preferences.stopOnView ? "checked" : ""} />
          <span>Parar ao visualizar a Liberacao</span>
        </label>
        <label class="alert-toggle-row">
          <input name="stopOnServiceStart" type="checkbox" ${preferences.stopOnServiceStart ? "checked" : ""} />
          <span>Parar quando o atendimento iniciar</span>
        </label>
      </div>
      <div class="order-card-actions">
        <button class="btn secondary" id="test-order-alert-sound" type="button">Testar alerta</button>
        <button class="btn secondary" id="stop-order-alert-sound" type="button">Parar teste</button>
        <button class="btn secondary" id="activate-order-alert-audio" type="button">Ativar audio neste navegador</button>
        <button class="btn secondary" id="restore-order-alert-default" type="button">Restaurar padrao</button>
        <button class="btn" type="submit">Salvar configuracoes</button>
      </div>
      <p class="text-sm text-slate-500">Os toques sao gerados pelo proprio sistema, sem copiar sons externos.</p>
    </form>`;
}

// Lê os valores do formulário de configurações e monta o payload a ser enviado à API
function payloadFromForm(form) {
  return {
    enabled: form.enabled.checked,
    soundId: form.soundId.value,
    volume: Number(form.volume.value || 70),
    visualNotifications: form.visualNotifications.checked,
    repeatMode: form.repeatMode.value,
    repeatIntervalSeconds: Number(form.repeatIntervalSeconds.value || 5),
    stopOnView: form.stopOnView.checked,
    stopOnServiceStart: form.stopOnServiceStart.checked
  };
}

// Liga os eventos do formulário de configurações: preview de volume, teste de som, restaurar
// padrão e salvar as preferências no servidor
export function bindOrderAlertSettings() {
  const form = document.querySelector("#order-alert-settings-form");
  if (!form) return;
  const volume = form.querySelector('[name="volume"]');
  const enabled = form.querySelector('[name="enabled"]');
  const label = document.querySelector("#order-alert-volume-label");
  volume?.addEventListener("input", () => {
    label.textContent = Number(volume.value) === 0 ? "Silenciado" : `${volume.value}%`;
  });
  enabled?.addEventListener("change", async () => {
    if (enabled.checked) await activateOrderAlertAudio();
    updateActivationButton();
  });
  document.querySelector("#activate-order-alert-audio")?.addEventListener("click", activateOrderAlertAudio);
  document.querySelector("#test-order-alert-sound")?.addEventListener("click", async () => {
    await activateOrderAlertAudio();
    await testOrderAlert(payloadFromForm(form));
  });
  document.querySelector("#stop-order-alert-sound")?.addEventListener("click", () => stopCurrentOrderAlert());
  document.querySelector("#restore-order-alert-default")?.addEventListener("click", () => {
    form.enabled.checked = true;
    form.soundId.value = "repetitive-alert";
    form.volume.value = 70;
    form.visualNotifications.checked = true;
    form.repeatMode.value = "three_times";
    form.repeatIntervalSeconds.value = 5;
    form.stopOnView.checked = true;
    form.stopOnServiceStart.checked = true;
    label.textContent = "70%";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = payloadFromForm(form);
    if (payload.enabled) await activateOrderAlertAudio();
    const data = await request("/api/user/order-alert-preferences", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    preferences = normalizePreferences(data.preferences || payload);
    updateActivationButton();
    toast("Configuracao de alertas salva.");
  });
}

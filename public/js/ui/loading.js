// Contador de chamadas simultâneas: o indicador só some quando todas terminarem
const loadingState = {
  count: 0,
  timer: null,
  message: "Carregando..."
};

// Cria (uma única vez) o elemento visual do indicador global de carregamento
function ensureLoadingIndicator() {
  let el = document.querySelector("#global-loading");
  if (el) return el;
  el = document.createElement("div");
  el.id = "global-loading";
  el.className = "global-loading";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="loading-progress"></div>
    <div class="loading-pill">
      <span class="loading-spinner" aria-hidden="true"></span>
      <span class="loading-text">Carregando...</span>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function setLoadingMessage(message) {
  const el = ensureLoadingIndicator();
  const text = el.querySelector(".loading-text");
  if (text) text.textContent = message || "Carregando...";
}

// Marca o início de um carregamento; retorna a função para encerrá-lo (uso: const stop = beginLoading())
export function beginLoading(message = "Carregando...") {
  loadingState.count += 1;
  loadingState.message = message;
  setLoadingMessage(message);
  document.body.classList.add("is-busy");
  if (loadingState.count === 1) {
    // Atraso de 180ms evita "piscar" o indicador em requisições muito rápidas
    clearTimeout(loadingState.timer);
    loadingState.timer = setTimeout(() => {
      ensureLoadingIndicator().classList.add("is-visible");
    }, 180);
  }
  return () => endLoading();
}

// Encerra um carregamento; só esconde o indicador quando não há mais nenhum pendente
export function endLoading() {
  loadingState.count = Math.max(0, loadingState.count - 1);
  if (loadingState.count > 0) return;
  clearTimeout(loadingState.timer);
  loadingState.timer = null;
  document.body.classList.remove("is-busy");
  ensureLoadingIndicator().classList.remove("is-visible");
}

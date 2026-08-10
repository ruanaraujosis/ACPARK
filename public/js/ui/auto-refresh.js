// Estado do refresh automático atualmente ativo (uma única instância por vez)
const autoRefreshState = {
  timer: null,
  key: null,
  running: false,
  callback: null,
  ignoreEditing: false,
  guard: null
};

// Cancela o intervalo de atualização automática em execução, se houver
export function stopAutoRefresh() {
  if (autoRefreshState.timer) clearInterval(autoRefreshState.timer);
  autoRefreshState.timer = null;
  autoRefreshState.key = null;
  autoRefreshState.running = false;
  autoRefreshState.callback = null;
  autoRefreshState.ignoreEditing = false;
  autoRefreshState.guard = null;
}

// Verifica se o foco está em um campo editável, para não interromper o usuário
function userIsEditing() {
  const active = document.activeElement;
  if (!active) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.isContentEditable;
}

// Verifica se algum campo do formulário foi alterado em relação ao valor original
function formHasChanges(form) {
  return [...form.elements].some((field) => {
    if (!field || field.disabled || !field.name && field.type !== "file") return false;
    if (field.type === "file") return field.files?.length > 0;
    if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
    if (field.tagName === "SELECT") {
      return [...field.options].some((option) => option.selected !== option.defaultSelected);
    }
    return field.value !== field.defaultValue;
  });
}

// Combina as checagens acima: edição de campo, modais abertos ou formulário sujo
function userHasUnfinishedWork() {
  if (userIsEditing()) return true;
  if (document.querySelector(".system-confirm-modal, .damage-status-modal, .photo-viewer-dialog")) return true;
  if (document.querySelector("[data-autorefresh-lock='true'], .is-saving, .is-processing")) return true;
  return [...document.querySelectorAll("form")].some(formHasChanges);
}

// Inicia (ou reaproveita) um intervalo de atualização automática de tela identificado por "key".
// Pula o ciclo se a aba estiver oculta, já estiver atualizando, o usuário estiver com trabalho
// não salvo (a menos que ignoreEditing) ou se um "guard" opcional bloquear a execução.
export function startAutoRefresh(key, callback, interval = 8000, options = {}) {
  const ignoreEditing = Boolean(options.ignoreEditing);
  const guard = typeof options.guard === "function" ? options.guard : null;
  // Mesma tela já com refresh ativo: só atualiza o callback/opções, mantém o timer
  if (autoRefreshState.key === key && autoRefreshState.timer) {
    autoRefreshState.callback = callback;
    autoRefreshState.ignoreEditing = ignoreEditing;
    autoRefreshState.guard = guard;
    return;
  }
  stopAutoRefresh();
  autoRefreshState.key = key;
  autoRefreshState.callback = callback;
  autoRefreshState.ignoreEditing = ignoreEditing;
  autoRefreshState.guard = guard;
  autoRefreshState.timer = setInterval(async () => {
    if (
      document.hidden
      || autoRefreshState.running
      || (!autoRefreshState.ignoreEditing && userHasUnfinishedWork())
      || (autoRefreshState.guard && autoRefreshState.guard() === false)
    ) return;
    autoRefreshState.running = true;
    try {
      await autoRefreshState.callback?.();
    } catch (error) {
      console.warn("Falha ao atualizar automaticamente.", error);
    } finally {
      autoRefreshState.running = false;
    }
  }, interval);
}

// Roda o refresh da tela atual imediatamente, sem esperar o próximo ciclo do intervalo.
// Usado quando o servidor avisa por SSE que um pedido mudou de etapa; o intervalo continua
// ativo como fallback, então nada regride se o evento não chegar.
export async function runAutoRefreshNow() {
  if (!autoRefreshState.callback || autoRefreshState.running) return false;
  if (document.hidden) return false;
  if (!autoRefreshState.ignoreEditing && userHasUnfinishedWork()) return false;
  if (autoRefreshState.guard && autoRefreshState.guard() === false) return false;
  autoRefreshState.running = true;
  try {
    await autoRefreshState.callback();
    return true;
  } catch (error) {
    console.warn("Falha ao atualizar após evento de etapa.", error);
    return false;
  } finally {
    autoRefreshState.running = false;
  }
}

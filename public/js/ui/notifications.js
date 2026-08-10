// Exibe uma notificação temporária (toast) no canto da tela; some sozinha após 3.2s
export function toast(message, type = "ok") {
  let root = document.querySelector("#toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    root.className = "toast-container";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "true");
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = `toast ${type === "error" ? "toast-error" : "toast-ok"}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

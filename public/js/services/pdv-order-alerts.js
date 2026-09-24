import { esc } from "../ui.js";
import {
  audioIsActivated,
  enqueueOrderAlert,
  stopAllOrderAlerts
} from "./audio-alert-manager.js";

// Padrão fixo do PDV: mesmo som repetitivo do Almoxarifado, sem tela de preferências
const preferenciasDoPdv = {
  enabled: true,
  soundId: "repetitive-alert",
  volume: 70,
  repeatMode: "three_times",
  repeatIntervalSeconds: 5
};

// Pedidos já avisados nesta aba (o mesmo pedido não repete o cartão enquanto ele está na tela)
const cartoesAtivos = new Set();

// Container próprio (mesmo visual do Almoxarifado): o #order-alert-root é removido por
// stopOrderAlerts(), e o cartão do PDV não pode sumir numa troca de tela
function garantirContainer() {
  let root = document.querySelector("#pdv-order-alert-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "pdv-order-alert-root";
    root.className = "order-alert-container";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "false");
    document.body.appendChild(root);
  }
  return root;
}

// Mostra o botão "Ativar alertas sonoros" enquanto o navegador ainda não liberou o áudio
// (o navegador exige um clique do usuário antes de tocar som)
export function mostrarBotaoDeAtivacaoPdv() {
  document.querySelector("#order-alert-activate")?.classList.toggle("hidden", audioIsActivated());
}

// Remove o cartão e interrompe o som daquele pedido
function fecharCartao(codigoPedido) {
  stopAllOrderAlerts();
  document.querySelector(`[data-pdv-order-alert="${CSS.escape(codigoPedido)}"]`)?.remove();
  cartoesAtivos.delete(codigoPedido);
}

// Logout/troca de usuário: para o som e tira os cartões, que são do PDV que saiu
export function limparAlertasDoPdv() {
  stopAllOrderAlerts();
  document.querySelector("#pdv-order-alert-root")?.remove();
  cartoesAtivos.clear();
}

// Cartão "Pedido pronto para retirada", com Visualizar e Silenciar (mesmo visual do Almoxarifado)
export function mostrarPedidoProntoParaRetirada(evento, { abrirMeusPedidos } = {}) {
  const codigoPedido = String(evento?.codigoPedido || "");
  if (!codigoPedido || cartoesAtivos.has(codigoPedido)) return;
  cartoesAtivos.add(codigoPedido);

  const node = document.createElement("div");
  node.className = "toast ok order-alert-toast";
  node.dataset.pdvOrderAlert = codigoPedido;
  node.setAttribute("role", "status");
  node.innerHTML = `
    <div class="order-alert-toast-title">Pedido pronto para retirada</div>
    <div class="order-alert-toast-meta">
      <strong>${esc(codigoPedido)}</strong>
      <span>Aguardando Retirada</span>
    </div>
    <div class="order-alert-toast-actions">
      <button type="button" class="toast-action-btn" data-pdv-alert-view>Visualizar</button>
      <button type="button" class="toast-action-btn secondary" data-pdv-alert-silence>Silenciar alerta</button>
    </div>`;
  node.querySelector("[data-pdv-alert-view]")?.addEventListener("click", () => {
    fecharCartao(codigoPedido);
    abrirMeusPedidos?.();
  });
  node.querySelector("[data-pdv-alert-silence]")?.addEventListener("click", () => fecharCartao(codigoPedido));
  garantirContainer().appendChild(node);

  // O id do pedido identifica a fila de som; sem áudio liberado o botão de ativação aparece
  enqueueOrderAlert({
    orderId: codigoPedido,
    preferences: preferenciasDoPdv,
    shouldStop: () => !cartoesAtivos.has(codigoPedido)
  });
  mostrarBotaoDeAtivacaoPdv();
}

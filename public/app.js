import { downloadCsv, esc, statusPill, table } from "./js/ui.js";
import { request } from "./js/api/api-client.js";
import { initializeAuth, renderLogin } from "./js/modules/auth/auth.js";
import { app, state } from "./js/state/app-state.js";
import { startAutoRefresh, stopAutoRefresh } from "./js/ui/auto-refresh.js";
import { toast } from "./js/ui/notifications.js";
import { moneyDate, monthLabel, monthsAgo, pendingReleaseQty, today, weekAgo } from "./js/utils/formatters.js";
import { parseProductsFile, spreadsheetText } from "./js/utils/spreadsheets.js";
import { uuid } from "./js/utils/uuid.js";
import {
  activateOrderAlertAudio,
  bindOrderAlertSettings,
  renderOrderAlertSettings,
  startOrderAlerts,
  stopOrderAlerts
} from "./js/services/order-alerts.js";

let damageDraftItems = [];
let renderDamageDraftItems;
let viewDamageReturn;

// Gera uma chave única para evitar requisições duplicadas (idempotência)
function createIdempotencyKey() {
  return uuid();
}

// Monta as opções de fetch incluindo o header de idempotência
function idempotentRequestOptions(body, idempotencyKey = createIdempotencyKey()) {
  return {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...body, idempotencyKey })
  };
}

// Recupera ou cria a chave de idempotência associada a um botão
function buttonIdempotencyKey(button) {
  if (!button) return createIdempotencyKey();
  button.dataset.idempotencyKey ||= createIdempotencyKey();
  return button.dataset.idempotencyKey;
}

// Remove a chave de idempotência armazenada no botão
function clearButtonIdempotencyKey(button) {
  if (button) delete button.dataset.idempotencyKey;
}

// Formata o resultado de um job de integração para exibição
function formatIntegrationJobResult(result) {
  if (!result) return "-";
  const data = typeof result === "string"
    ? (() => {
      try {
        return JSON.parse(result);
      } catch {
        return null;
      }
    })()
    : result;
  if (!data || typeof data !== "object") return "-";
  const parts = [];
  if (Number.isFinite(Number(data.received))) parts.push(`${Number(data.received)} recebidos`);
  if (Number.isFinite(Number(data.created))) parts.push(`${Number(data.created)} criados`);
  if (Number.isFinite(Number(data.updated))) parts.push(`${Number(data.updated)} atualizados`);
  if (Number.isFinite(Number(data.pages))) parts.push(`${Number(data.pages)} página(s)`);
  return parts.length ? parts.join(" | ") : "-";
}

// Monta o layout base (shell) da aplicação com menu e conteúdo
function shell(content, actions = "") {
  const role = state.user?.role;
  const displayName = role === "admin" ? "Almoxarifado" : state.user?.name;
  const shouldShowHero = state.currentView === "dashboard";
  const items = role === "admin"
    ? [["dashboard", "Dashboard"], ["products", "Estoque central"], ["stock", "Estoque PDVs"], ["release", "Liberação"], ["damages", "Devoluções de avarias"], ["integrations", "Integrações"], ["history", "Histórico"], ["damage-history", "Histórico de Devoluções"], ["auto", "Autopedidos"], ["config", "Config"]]
    : [["order", "Novo pedido"], ["mine", "Meus pedidos"], ["my-stock", "Meu estoque"], ["damage-return", "Nova devolução de avaria"]];

  app.innerHTML = `
    <div class="app-shell min-h-screen">
      <nav class="site-topbar sticky top-0 z-30">
        <div class="app-topbar-inner flex items-center justify-between gap-3 px-4 py-2">
          <div class="flex items-center gap-3">
            <div class="brand-logo" aria-label="Aguas Correntes Park"></div>
            <div class="hidden sm:block">
              <p class="eyebrow">Sistema interno</p>
              <h1 class="text-xl font-black text-[color:var(--ac-teal-dark)]">Gest\u00e3o de Estoque</h1>
            </div>
          </div>
          <div class="menu-wrap">
            <button class="menu-toggle" id="menu-toggle" type="button" aria-label="Abrir menu" aria-expanded="false">
              <span></span>
              <span></span>
              <span></span>
            </button>
          </div>
        </div>
      </nav>
      <div class="sidebar-backdrop hidden" id="sidebar-backdrop"></div>
      <aside class="side-menu" id="nav-menu" aria-hidden="true">
        <div class="side-menu-head">
          <div>
            <p class="eyebrow">Menu</p>
            <h3 class="section-title text-xl font-black">Navegação</h3>
          </div>
          <button class="side-close" id="side-close" type="button" aria-label="Fechar menu">&times;</button>
        </div>
        <div class="side-user">
          <span>Conectado</span>
          <strong>${esc(displayName)}</strong>
        </div>
        <div class="side-menu-list">
          ${items.map(([id, label]) => `<button class="side-link nav-btn" data-view="${id}">${label}</button>`).join("")}
        </div>
        <button class="btn danger side-logout" id="logout">Sair</button>
      </aside>
      ${shouldShowHero ? `
        <section class="app-hero">
          <div class="app-hero-inner relative z-10 px-4 py-8 md:py-12">
            <p class="text-sm font-black uppercase tracking-widest text-orange-200">Almoxarifado e pontos de venda</p>
            <h2 class="mt-2 max-w-2xl text-3xl font-black leading-tight md:text-5xl">Controle o abastecimento do parque com a fluidez do AC Park.</h2>
            <p class="mt-3 max-w-2xl text-white/90">Pedidos, liberações, estoque por PDV e sincronização OMIE reunidos em uma experiência responsiva.</p>
          </div>
        </section>
      ` : ""}
      <main class="app-main ${shouldShowHero ? "" : "app-main-internal"} px-4 py-5">
        <div class="mb-4 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p class="eyebrow">Conectado como</p>
            <h2 class="section-title text-2xl font-black">${esc(displayName)}</h2>
          </div>
          <div class="page-actions no-print"><button class="btn secondary hidden" id="order-alert-activate" type="button">Ativar alertas sonoros</button>${actions}</div>
        </div>
        ${content}
      </main>
    </div>`;

  const menuToggle = document.querySelector("#menu-toggle");
  const sideClose = document.querySelector("#side-close");
  const backdrop = document.querySelector("#sidebar-backdrop");
  const navMenu = document.querySelector("#nav-menu");

  const closeMenu = () => {
    navMenu.classList.remove("is-open");
    navMenu.setAttribute("aria-hidden", "true");
    backdrop.classList.add("hidden");
    menuToggle.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    navMenu.classList.add("is-open");
    navMenu.setAttribute("aria-hidden", "false");
    backdrop.classList.remove("hidden");
    menuToggle.classList.add("is-open");
    menuToggle.setAttribute("aria-expanded", "true");
  };

  menuToggle.addEventListener("click", () => {
    const isOpen = navMenu.classList.contains("is-open");
    if (isOpen) closeMenu();
    else openMenu();
  });
  sideClose.addEventListener("click", closeMenu);
  backdrop.addEventListener("click", closeMenu);

  document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => {
    closeMenu();
    route(btn.dataset.view);
  }));
  document.querySelector("#logout").addEventListener("click", async () => {
    stopAutoRefresh();
    stopOrderAlerts();
    await request("/api/auth/logout", { method: "POST" });
    state.user = null;
    renderLogin();
  });
  document.querySelector("#order-alert-activate")?.addEventListener("click", activateOrderAlertAudio);
}

// Carrega os dados iniciais da aplicação (bootstrap)
async function loadBootstrap() {
  const data = await request("/api/bootstrap");
  state.user = data.user;
  state.pdvs = data.pdvs;
  state.products = data.products;
  state.categories = (data.categories || []).map((item) => item.nome);
  state.config = data.config || {};
}


const releaseKanbanStatuses = ["Pendente", "Em Andamento", "Aguardando Retirada"];
const orderStatuses = [...releaseKanbanStatuses, "Finalizado"];
const orderStatusCodes = {
  Pendente: "PENDENTE",
  "Em Andamento": "EM_ANDAMENTO",
  "Aguardando Retirada": "AGUARDANDO_RETIRADA",
  Finalizado: "FINALIZADO"
};
const orderStatusFromCode = {
  PENDENTE: "Pendente",
  EM_ANDAMENTO: "Em Andamento",
  AGUARDANDO_RETIRADA: "Aguardando Retirada",
  FINALIZADO: "Finalizado"
};
const orderStatusLabels = {
  Pendente: "Pendentes",
  "Em Andamento": "Em andamento",
  "Aguardando Retirada": "Aguardando Retirada",
  Finalizado: "Finalizado"
};
const releaseKanbanOperations = new Map();
const releaseKanbanKnownVersions = new Map();
const releaseKanbanRecentStatuses = new Map();
let releaseKanbanOperationSeq = 0;

const damageStatuses = [
  "Aguardando Produto",
  "Em Aprovação",
  "Aprovação Parcial",
  "Finalizado",
  "Recusado",
  "Verificação",
  "Cancelado"
];
const damageMotivos = [
  "Produto vencido",
  "Produto danificado",
  "Produto estragado",
  "Embalagem violada",
  "Quebra",
  "Contaminação",
  "Problema de armazenamento",
  "Outro motivo"
];

// Gera a chave de agrupamento de um pedido
function orderGroupKey(row) {
  return `${row.codigo_pedido || row.id || ""}::${row.status || ""}`;
}

// Obtém o timestamp mais recente de mudança de status do pedido
function orderStatusTimestamp(row = {}) {
  const status = row.status || "";
  const value = status === "Em Andamento"
    ? row.em_andamento_em || row.criado_em || row.data_hora
    : status === "Aguardando Retirada"
      ? row.pronto_retirada_em || row.liberado_em || row.criado_em || row.data_hora
      : status === "Finalizado"
        ? row.retirada_em || row.pronto_retirada_em || row.liberado_em || row.criado_em || row.data_hora
        : row.criado_em || row.data_hora;
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// Ordena grupos de pedidos do mais recente para o mais antigo
function sortOrderGroupsNewest(groups = []) {
  return [...groups].sort((left, right) => {
    const diff = orderStatusTimestamp(right[0]) - orderStatusTimestamp(left[0]);
    if (diff) return diff;
    return String(right[0]?.codigo_pedido || "").localeCompare(String(left[0]?.codigo_pedido || ""));
  });
}

// Filtra os itens do pedido a exibir conforme o status
function orderDisplayItemsForStatus(group = []) {
  return group;
}

// Filtra grupos de pedidos pelo status informado
function orderGroupsForStatus(grouped = [], status) {
  return sortOrderGroupsNewest(grouped
    .filter((group) => group[0]?.status === status)
    .filter((group) => orderDisplayItemsForStatus(group).length > 0));
}

// Retorna os itens já liberados de um grupo de pedido
function orderReleasedItems(group = []) {
  return group.filter((item) => Number(item.quantidade_liberada || 0) > 0);
}

// Calcula o valor de estoque central de um item
function centralStockValue(item = {}) {
  const value = item.estoque_central ?? item.saldo ?? item.qtd_total ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}











// Importa produtos em lotes para evitar sobrecarga da API
async function importProductsInBatches(items) {
  const batchSize = 250;
  let imported = 0;
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchNumber = Math.floor(index / batchSize) + 1;
    const totalBatches = Math.ceil(items.length / batchSize);
    const data = await request("/api/admin/products/import", {
      method: "POST",
      loadingMessage: `Importando planilha... lote ${batchNumber} de ${totalBatches}`,
      body: JSON.stringify({ items: batch })
    });
    imported += Number(data.imported || batch.length);
  }
  return imported;
}

// Monta as opções de categoria para os selects
function categoryOptions() {
  return [...new Set(state.categories.map((category) => String(category || "").trim()).filter(Boolean))].sort();
}

// Conecta aos eventos (SSE) de integração em tempo real
function connectIntegrationEvents() {
  if (!window.EventSource || state.integrationEventsConnected) return;
  state.integrationEventsConnected = true;
  const source = new EventSource("/api/admin/integrations/events");
  const recarregarIntegracoes = () => {
    if (state.currentView === "integrations") viewIntegrations().catch(() => {});
  };
  source.addEventListener("integration.job.updated", recarregarIntegracoes);
  source.addEventListener("integration.status.updated", recarregarIntegracoes);
  source.addEventListener("stock.updated", (event) => {
    recarregarIntegracoes();
    try {
      const data = JSON.parse(event.data || "{}");
      if (data?.payload?.sku_produto) toast(`Saldo atualizado: ${data.payload.sku_produto}`);
    } catch {
      toast("Saldo atualizado.");
    }
  });
  source.addEventListener("stock.movement.imported", recarregarIntegracoes);
  source.onerror = () => {
    source.close();
    state.integrationEventsConnected = false;
    setTimeout(connectIntegrationEvents, 15000);
  };
}

// Roteador principal: renderiza a view solicitada
async function route(view) {
  try {
    stopAutoRefresh();
    state.currentView = view;
    await loadBootstrap();
    if (state.user?.role === "admin") connectIntegrationEvents();
    const views = {
      order: viewOrder,
      mine: viewMine,
      "my-stock": viewMyStock,
      "damage-return": viewDamageReturn,
      dashboard: viewDashboard,
      products: viewProductsV2,
      stock: viewStock,
      release: viewRelease,
      damages: viewDamagesAdmin,
      integrations: viewIntegrations,
      history: () => viewHistory(false),
      "damage-history": viewDamageHistory,
      auto: () => viewHistory(true),
      config: viewConfigV2
    };
    if (state.user?.role === "admin") {
      await startOrderAlerts({
        route,
        refreshRelease: async () => {
          const from = document.querySelector("#release-from")?.value || weekAgo();
          const to = document.querySelector("#release-to")?.value || today();
          const pdvId = document.querySelector("#release-pdv-filter")?.value || "";
          const q = document.querySelector("#release-code-filter")?.value || "";
          await viewRelease({ from, to, pdvId, q, auto: true });
        }
      });
    }
    await views[view]();
    if (state.user?.role === "admin") {
      await startOrderAlerts({
        route,
        refreshRelease: async () => {
          const from = document.querySelector("#release-from")?.value || weekAgo();
          const to = document.querySelector("#release-to")?.value || today();
          const pdvId = document.querySelector("#release-pdv-filter")?.value || "";
          const q = document.querySelector("#release-code-filter")?.value || "";
          await viewRelease({ from, to, pdvId, q, auto: true });
        }
      });
    } else {
      stopOrderAlerts();
    }
  } catch (error) {
    console.error(`Erro ao carregar a tela ${view}:`, error);
    const friendlyMessage = view === "release"
      ? "Não foi possível carregar a aba Liberação."
      : error.message;
    toast(friendlyMessage, "error");
    if (error.message.includes("Login")) renderLogin();
  }
}

// View de criação/edição de pedidos (PDV)
async function viewOrder(options = {}) {
  const data = await request("/api/pdv/products", { silentLoading: Boolean(options.auto) });
  const draftPayload = options.skipDraftRestore
    ? { draft: null }
    : await request("/api/pdv/order-draft", { silentLoading: true }).catch(() => ({ draft: null }));
  const savedDraft = draftPayload?.draft || null;
  const savedRequester = savedDraft?.solicitante && savedDraft.solicitante !== state.user?.name
    ? savedDraft.solicitante
    : "";
  if (!state.cart.length && savedDraft?.items?.length) {
    state.cart = savedDraft.items
      .map((item) => ({
        sku: String(item.sku || ""),
        nome: String(item.nome || ""),
        quantidade: Number(item.quantidade || 0),
        // Sem isto, recarregar a tela devolvia tudo para unidade e o PDV perdia a escolha
        unidade_medida: item.unidade_medida === "EMBALAGEM" ? "EMBALAGEM" : "UNIDADE"
      }))
      .filter((item) => item.sku && item.quantidade > 0);
  }
  const productCategories = (product) => String(product.categoria || "")
    .split(",")
    .map((category) => category.trim())
    .filter(Boolean);
  const availableCategories = [...new Set(data.products.flatMap(productCategories))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const productLabel = (product) => `${product.sku} - ${product.nome}`;
  const productSearch = (product) => `${product.sku} ${product.nome} ${product.categoria || ""}`.toLowerCase();
  shell(`
    <section class="order-screen">
      <section class="card order-main-card">
        <div class="mb-3">
          <p class="eyebrow">Solicitação</p>
          <h3 class="section-title text-xl font-black">Novo pedido</h3>
        </div>

        <div class="order-top-grid">
          <div class="order-form-area">
            <div class="order-info-grid">
              <label class="grid gap-1 text-sm font-bold">Solicitante <input name="solicitante" id="solicitante" required value="${esc(savedRequester)}" placeholder="Informe o nome do responsável" /></label>
              <label class="grid gap-1 text-sm font-bold">Observação <textarea name="observacao" id="observacao" rows="3">${esc(savedDraft?.observacao || "")}</textarea></label>
            </div>

            <section class="category-settings order-add-panel">
              <div>
                <p class="eyebrow">Adicionar produto</p>
                <h4>Adicionar ao pedido</h4>
              </div>
              <div class="category-product-tools order-product-tools">
                <div class="category-product-picker">
                  <label class="category-add-label" for="order-product-search">Produto</label>
                  <input id="order-product-search" class="category-add-product-search" type="search" placeholder="Digite o nome ou SKU do produto" autocomplete="off" />
                  <input id="order-product-sku" type="hidden" />
                  <div class="category-product-suggestions hidden" id="order-product-suggestions">
                    ${data.products.map((product) => `
                      <button class="category-product-suggestion order-product-suggestion" type="button" data-sku="${esc(product.sku)}" data-label="${esc(productLabel(product))}" data-search="${esc(productSearch(product))}">
                        <strong>${esc(product.nome)}</strong>
                        <span>${esc(product.sku)} | ${esc(product.categoria || "-")} | atual ${product.quantidade} | max ${product.estoque_maximo}</span>
                      </button>`).join("") || `<p class="text-sm text-slate-500">Nenhum produto liberado para este PDV.</p>`}
                  </div>
                </div>
                <input id="order-product-quantity" type="number" min="1" value="1" aria-label="Quantidade" />
                <button class="btn secondary" id="add-order-product" type="button">Adicionar</button>
              </div>
            </section>

            <div class="category-product-list order-cart-list">
              <div class="category-product-list-head">
                <strong>Carrinho</strong>
                ${savedDraft?.atualizado_em ? `<span class="text-sm text-slate-500">Rascunho salvo em ${moneyDate(savedDraft.atualizado_em)}</span>` : ""}
              </div>
              <div id="cart"></div>
              <div class="order-draft-actions">
                <button class="btn secondary" id="save-order-draft" type="button">Salvar rascunho</button>
                <button class="btn secondary" id="clear-order-draft" type="button">Limpar rascunho</button>
              </div>
              <button class="btn mt-3 w-full" id="send-order" type="button">Enviar pedido</button>
            </div>
          </div>
        </div>
      </section>

      <section class="card category-product-list order-available-card">
        <div class="category-product-list-head">
          <strong>Produtos disponíveis</strong>
          <div class="order-available-filters">
            <input class="category-product-search" id="available-product-search" type="search" placeholder="Pesquisar produto" />
            <select id="available-category-filter" aria-label="Filtrar por categoria">
              <option value="">Todas as categorias</option>
              ${availableCategories.map((category) => `<option value="${esc(category.toLowerCase())}">${esc(category)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="category-product-table" id="available-products"></div>
      </section>
    </section>`);

  const addProductToCart = (sku, quantidade = 1) => {
    const product = data.products.find((item) => item.sku === sku);
    const qty = Number(quantidade);
    if (!product || !Number.isFinite(qty) || qty <= 0) return;
    const existing = state.cart.find((item) => item.sku === sku);
    if (existing) existing.quantidade += qty;
    else state.cart.push({ sku, nome: product.nome, quantidade: qty, unidade_medida: unidadePadraoDoProduto(sku) });
  };
  const currentDraftPayload = () => ({
    solicitante: document.querySelector("#solicitante")?.value || "",
    observacao: document.querySelector("#observacao")?.value || "",
    items: state.cart.map((item) => ({ ...item }))
  });
  const clearStoredOrderDrafts = () => {
    const userKeys = [
      state.user?.id,
      state.user?.pdvId,
      state.user?.name
    ].filter(Boolean).map(String);
    const fixedKeys = new Set([
      "pdvOrderDraft",
      "pedidoDraft",
      "orderDraft",
      "pdv:orderDraft",
      "acparkOrderDraft",
      ...userKeys.map((key) => `pdvOrderDraft:${key}`),
      ...userKeys.map((key) => `pedidoDraft:${key}`),
      ...userKeys.map((key) => `orderDraft:${key}`)
    ]);
    [localStorage, sessionStorage].forEach((storage) => {
      for (const key of fixedKeys) storage.removeItem(key);
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (/pedido.*draft|draft.*pedido|order.*draft|draft.*order|rascunho/i.test(key || "")) {
          storage.removeItem(key);
        }
      }
    });
  };
  const limparRascunhoPedido = () => {
    const requester = "";
    const productSearchField = document.querySelector("#order-product-search");
    const productSkuField = document.querySelector("#order-product-sku");
    const quantityField = document.querySelector("#order-product-quantity");
    const suggestions = document.querySelector("#order-product-suggestions");
    const observationField = document.querySelector("#observacao");
    const requesterField = document.querySelector("#solicitante");
    state.cart = [];
    state.orderIdempotencyKey = null;
    if (observationField) observationField.value = "";
    if (productSearchField) {
      productSearchField.value = "";
      productSearchField.dataset.selectedLabel = "";
    }
    if (productSkuField) productSkuField.value = "";
    if (quantityField) quantityField.value = 1;
    suggestions?.classList.add("hidden");
    if (requesterField) requesterField.value = requester;
    clearStoredOrderDrafts();
    renderCart();
  };
  const handleClearOrderDraft = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    if (button.disabled) return;
    const confirmed = await confirmSystem({
      title: "Limpar rascunho?",
      message: "Todos os produtos, quantidades e observações deste rascunho serão removidos.",
      confirmLabel: "Limpar rascunho",
      danger: true
    });
    if (!confirmed) return;
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "Limpando rascunho...";
    try {
      limparRascunhoPedido();
      await request("/api/pdv/order-draft", { method: "DELETE" });
      toast("Rascunho removido com sucesso.");
      await viewOrder({ skipDraftRestore: true });
    } catch (error) {
      toast(error.message || "Não foi possível limpar o rascunho.", "error");
      limparRascunhoPedido();
    } finally {
      button.disabled = false;
      button.textContent = previousText;
    }
  };
  const renderAvailableProducts = () => {
    document.querySelector("#available-products").innerHTML = data.products.length
      ? table(["SKU", "Produto", "Categoria", "Embalagem", "Estoque central", "Atual", "Máx.", "Ação"], data.products.map((product) => `
        <tr class="available-product-row" data-search="${esc(productSearch(product))}" data-categories="${esc(productCategories(product).map((category) => category.toLowerCase()).join("|"))}">
          <td>${esc(product.sku)}</td>
          <td>${esc(product.nome)}</td>
          <td>${esc(product.categoria || "-")}</td>
          <td>${Number(product.fator_conversao) > 1 ? esc(`${product.embalagem || "Embalagem"} c/ ${product.fator_conversao}`) : "Unidade"}</td>
          <td class="release-number-cell">${centralStockValue(product)}</td>
          <td>${product.quantidade}</td>
          <td>${product.estoque_maximo}</td>
          <td><button class="icon-action add-available-product" type="button" data-sku="${esc(product.sku)}" title="Adicionar produto" aria-label="Adicionar produto">+</button></td>
        </tr>`))
      : `<p class="text-sm text-slate-500">Nenhum produto disponível para este PDV.</p>`;
    document.querySelectorAll(".add-available-product").forEach((button) => button.addEventListener("click", () => {
      addProductToCart(button.dataset.sku, 1);
      renderCart();
    }));
  };
  // Dados de conversão do produto, vindos do cadastro do ERP
  const fatorDoProduto = (sku) => {
    const produto = data.products.find((p) => String(p.sku) === String(sku));
    const fator = Number(produto?.fator_conversao);
    return {
      fator: Number.isSafeInteger(fator) && fator > 1 ? fator : 1,
      embalagem: produto?.embalagem || "",
      invalido: produto?.fator_status === "INVALIDO"
    };
  };

  // Embalagem é o padrão: é assim que o PDV pede no dia a dia. Cai para unidade só quando o
  // produto não tem fator confiável no cadastro — ali pedir por embalagem seria multiplicar por
  // um número adivinhado, e o backend recusa o pedido (fator-conversao.repository.js).
  const unidadePadraoDoProduto = (sku) => {
    const { fator, invalido } = fatorDoProduto(sku);
    return !invalido && fator > 1 ? "EMBALAGEM" : "UNIDADE";
  };

  // "2 fardos = 30 un" — o PDV vê a embalagem que escolheu e o total que vai receber
  const textoDaConversao = (item) => {
    const { fator, embalagem, invalido } = fatorDoProduto(item.sku);
    if (invalido) return `<span class="conversao-alerta">Cadastro sem fator válido — peça em unidades</span>`;
    if (item.unidade_medida !== "EMBALAGEM" || fator < 2) return `<span class="conversao-info">${esc(item.quantidade)} un</span>`;
    const nome = embalagem ? `${embalagem.toLowerCase()}${item.quantidade > 1 ? "s" : ""}` : "embalagem(ns)";
    return `<span class="conversao-info destaque">${esc(item.quantidade)} ${esc(nome)} = <strong>${item.quantidade * fator} un</strong></span>`;
  };

  const renderCart = () => {
    document.querySelector("#cart").innerHTML = state.cart.length
      ? table(["Produto", "Qtd", "Unidade", "Total", "Ação"], state.cart.map((item, index) => {
        const { fator, embalagem, invalido } = fatorDoProduto(item.sku);
        const temEmbalagem = fator > 1 && !invalido;
        return `
        <tr class="order-cart-row">
          <td>${esc(item.nome)}</td>
          <td><input class="order-cart-qty" type="number" min="1" value="${item.quantidade}" data-index="${index}" /></td>
          <td>
            ${temEmbalagem
              ? `<select class="order-cart-unidade" data-index="${index}">
                   <option value="UNIDADE" ${item.unidade_medida !== "EMBALAGEM" ? "selected" : ""}>Unidade</option>
                   <option value="EMBALAGEM" ${item.unidade_medida === "EMBALAGEM" ? "selected" : ""}>${esc(embalagem || "Embalagem")} (${fator} un)</option>
                 </select>`
              : `<span class="conversao-info">Unidade</span>`}
          </td>
          <td>${textoDaConversao(item)}</td>
          <td><button class="icon-action danger remove" type="button" data-index="${index}" title="Remover produto" aria-label="Remover produto">&times;</button></td>
        </tr>`;
      }))
      : `<p class="text-sm text-slate-500">Nenhum produto adicionado ainda.</p>`;
    document.querySelectorAll(".order-cart-qty").forEach((input) => input.addEventListener("input", () => {
      const qty = Number(input.value);
      if (Number.isFinite(qty) && qty > 0) {
        state.cart[Number(input.dataset.index)].quantidade = qty;
        renderCart();
      }
    }));
    // Trocar de unidade redesenha para o total acompanhar na hora
    document.querySelectorAll(".order-cart-unidade").forEach((select) => select.addEventListener("change", () => {
      state.cart[Number(select.dataset.index)].unidade_medida = select.value;
      renderCart();
    }));
    document.querySelectorAll(".remove").forEach((btn) => btn.addEventListener("click", () => {
      state.cart.splice(Number(btn.dataset.index), 1);
      renderCart();
    }));
  };
  renderAvailableProducts();
  renderCart();
  document.querySelector("#clear-order-draft").onclick = handleClearOrderDraft;

  const applyAvailableFilters = () => {
    const term = String(document.querySelector("#available-product-search")?.value || "").trim().toLowerCase();
    const category = String(document.querySelector("#available-category-filter")?.value || "").trim().toLowerCase();
    document.querySelectorAll(".available-product-row").forEach((row) => {
      const matchesSearch = !term || row.dataset.search.includes(term);
      const rowCategories = String(row.dataset.categories || "").split("|").filter(Boolean);
      const matchesCategory = !category || rowCategories.includes(category);
      row.classList.toggle("hidden", !matchesSearch || !matchesCategory);
    });
  };
  document.querySelector("#available-product-search").addEventListener("input", applyAvailableFilters);
  document.querySelector("#available-category-filter").addEventListener("change", applyAvailableFilters);

  const orderProductSearch = document.querySelector("#order-product-search");
  const orderProductSku = document.querySelector("#order-product-sku");
  const orderSuggestions = document.querySelector("#order-product-suggestions");
  const filterOrderSuggestions = () => {
    const term = String(orderProductSearch.value || "").trim().toLowerCase();
    let visible = 0;
    if (orderProductSearch.dataset.selectedLabel !== orderProductSearch.value) {
      orderProductSku.value = "";
    }
    document.querySelectorAll(".order-product-suggestion").forEach((item) => {
      const show = term.length > 0 && item.dataset.search.includes(term);
      item.classList.toggle("hidden", !show);
      if (show) visible += 1;
    });
    orderSuggestions.classList.toggle("hidden", term.length === 0 || visible === 0);
    if (!term) orderProductSku.value = "";
  };
  orderProductSearch.addEventListener("input", filterOrderSuggestions);
  document.querySelectorAll(".order-product-suggestion").forEach((item) => item.addEventListener("click", () => {
    orderProductSearch.value = item.dataset.label || "";
    orderProductSearch.dataset.selectedLabel = orderProductSearch.value;
    orderProductSku.value = item.dataset.sku || "";
    orderSuggestions.classList.add("hidden");
  }));
  document.querySelector("#add-order-product").addEventListener("click", () => {
    addProductToCart(orderProductSku.value, document.querySelector("#order-product-quantity").value);
    orderProductSearch.value = "";
    orderProductSearch.dataset.selectedLabel = "";
    orderProductSku.value = "";
    document.querySelector("#order-product-quantity").value = 1;
    orderSuggestions.classList.add("hidden");
    renderCart();
  });

  document.querySelector("#save-order-draft").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    if (!state.cart.length) {
      toast("Adicione produtos ao carrinho para salvar o rascunho.", "error");
      return;
    }
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "Salvando...";
    try {
      await request("/api/pdv/order-draft", {
        method: "POST",
        body: JSON.stringify(currentDraftPayload())
      });
      toast("Rascunho salvo. Você pode continuar este pedido depois.");
    } catch (error) {
      toast(error.message || "Não foi possível salvar o rascunho.", "error");
    } finally {
      button.disabled = false;
      button.textContent = previousText;
    }
  });

  document.querySelector("#send-order").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    if (!state.cart.length) {
      toast("Adicione pelo menos um produto ao pedido.", "error");
      return;
    }
    const solicitante = document.querySelector("#solicitante").value.trim();
    if (!solicitante) {
      toast("Informe o solicitante do pedido.", "error");
      return;
    }
    state.orderIdempotencyKey ||= uuid();
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "Enviando pedido...";
    try {
      const cartSnapshot = state.cart.map((item) => ({ ...item }));
      const observacao = document.querySelector("#observacao").value;
      const response = await request("/api/pdv/order", {
        method: "POST",
        headers: { "Idempotency-Key": state.orderIdempotencyKey },
        body: JSON.stringify({
          idempotencyKey: state.orderIdempotencyKey,
          solicitante,
          observacao,
          items: cartSnapshot
        })
      });
      state.cart = [];
      state.orderIdempotencyKey = null;
      await request("/api/pdv/order-draft", { method: "DELETE", silentLoading: true }).catch(() => {});
      toast("Pedido enviado para o Almoxarifado.");
      route("mine");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = previousText;
    }
  });

  startAutoRefresh("order", async () => {
    if (state.cart.length) return;
    if (document.querySelector("#order-product-search")?.value) return;
    if (document.querySelector("#available-product-search")?.value) return;
    await viewOrder({ auto: true });
  }, 10000);
}

// View "Meus Pedidos": lista pedidos do usuário logado
async function viewMine(filters = {}) {
  const from = filters.from || weekAgo();
  const to = filters.to || today();
  const activeStatus = filters.status || document.querySelector(".release-tabs .config-tab.is-active")?.dataset.mineStatus || "Pendente";
  const statuses = orderStatuses;
  const statusLabels = orderStatusLabels;
  const data = await request(`/api/pdv/orders?from=${from}&to=${to}`, { silentLoading: Boolean(filters.auto) });
  const readyOrders = data.orders.filter((order) => order.status === "Aguardando Retirada");
  const grouped = Object.values(data.orders.reduce((acc, row) => {
    const key = orderGroupKey(row);
    acc[key] ||= [];
    acc[key].push(row);
    return acc;
  }, {}));
  const byStatus = statuses.reduce((acc, status) => {
    acc[status] = orderGroupsForStatus(grouped, status);
    return acc;
  }, {});
  const visibleGroups = byStatus[activeStatus] || [];
  if (filters.auto) {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    updateMineCounters(byStatus);
    syncMineOrderList(visibleGroups, activeStatus);
    window.scrollTo(scrollX, scrollY);
    return;
  }
  shell(`
    ${readyOrders.length ? `
      <section class="release-alert card">
        <p class="eyebrow">Aguardando retirada</p>
        <h3 class="section-title text-xl font-black">Seu pedido está separado e aguardando retirada no almoxarifado.</h3>
        <p class="text-sm text-slate-500">Último: pedido ${esc(readyOrders[0].codigo_pedido)} em ${moneyDate(readyOrders[0].pronto_retirada_em || readyOrders[0].liberado_em || readyOrders[0].data_hora)}.</p>
      </section>` : ""}
    <section class="release-screen">
      <section class="card release-filter-card mine-filter-card">
        <form id="mine-filter" class="filter-panel mine-filter">
          <div class="filter-copy">
            <p class="eyebrow">Filtro</p>
            <h3 class="section-title text-xl font-black">Meus pedidos</h3>
            <p>Acompanhe seus pedidos por período sem perder a visualização aberta.</p>
          </div>
          <label class="field-date">De
            <input name="from" type="date" value="${esc(from)}" />
          </label>
          <label class="field-date">Até
            <input name="to" type="date" value="${esc(to)}" />
          </label>
          <div class="filter-actions">
            <button class="btn" type="submit">Filtrar</button>
          </div>
        </form>
      </section>
      <div class="config-tabs release-tabs" role="tablist" aria-label="Status dos meus pedidos">
        ${statuses.map((status) => `
          <button class="config-tab ${status === activeStatus ? "is-active" : ""}" type="button" data-mine-status="${esc(status)}" role="tab" aria-selected="${status === activeStatus ? "true" : "false"}">
            ${esc(statusLabels[status] || status)} <span>${byStatus[status].length}</span>
          </button>`).join("")}
      </div>
      <section class="grid gap-4" id="mine-orders-list">
        ${visibleGroups.map((group) => pdvOrderCard(group)).join("") || `<div class="card">Não há pedidos ${esc(activeStatus.toLowerCase())} no período.</div>`}
      </section>
    </section>`);
  document.querySelector("#mine-filter").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await viewMine({ ...form, status: activeStatus });
  });
  document.querySelectorAll("[data-mine-status]").forEach((button) => button.addEventListener("click", async () => {
    await viewMine({ from, to, status: button.dataset.mineStatus });
  }));
  bindOrderToggles();
  document.querySelectorAll(".view-order-withdrawal").forEach((btn) => btn.addEventListener("click", () => {
    const card = btn.closest("[data-order]");
    openOrderWithdrawalReceipt({
      orderCode: btn.dataset.order || card?.dataset.order,
      pdv: btn.dataset.pdv,
      responsible: btn.dataset.responsible,
      date: btn.dataset.date,
      user: btn.dataset.user,
      signature: btn.dataset.signature,
      items: orderWithdrawalItemsFromButton(btn, card)
    });
  }));
  if (readyOrders.length && !filters.auto) toast(`Pedido ${readyOrders[0].codigo_pedido} aguardando retirada no almoxarifado.`);
  startAutoRefresh("mine", async () => {
    const currentStatus = document.querySelector("[data-mine-status].is-active")?.dataset.mineStatus || activeStatus;
    await viewMine({ from, to, status: currentStatus, auto: true });
  }, 7000);
}

// Atualiza os contadores por status na view Meus Pedidos
function updateMineCounters(byStatus) {
  Object.entries(byStatus).forEach(([status, groups]) => {
    const el = document.querySelector(`[data-mine-status="${CSS.escape(status)}"] span`);
    if (el) el.textContent = groups.length;
  });
}

// Verifica se um campo do formulário foi alterado
function fieldChanged(field) {
  if (!field || field.disabled || (!field.name && field.type !== "file")) return false;
  if (field.type === "file") return Boolean(field.files?.length);
  if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
  if (field.tagName === "SELECT") {
    return [...field.options].some((option) => option.selected !== option.defaultSelected);
  }
  return field.value !== field.defaultValue;
}

// Verifica se o card de pedido tem alterações não salvas
function orderCardHasUnsavedWork(card) {
  if (!card) return false;
  if (card.classList?.contains("is-open")) return true;
  const active = document.activeElement;
  if (active && card.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return true;
  if (card.querySelector("[data-autorefresh-lock='true'], .is-saving, .is-processing")) return true;
  return [...card.querySelectorAll("input, textarea, select")].some(fieldChanged);
}

// Sincroniza a lista de pedidos exibida sem perder edições em andamento
function syncMineOrderList(visibleGroups, activeStatus) {
  const list = document.querySelector("#mine-orders-list");
  if (!list) return;
  const protectedOrders = new Set([...list.querySelectorAll(".order-accordion")]
    .filter(orderCardHasUnsavedWork)
    .map((card) => card.dataset.orderKey || card.dataset.order));
  const nextCodes = new Set(visibleGroups.map((group) => orderGroupKey(group[0] || {})).filter(Boolean));
  list.querySelectorAll(".order-accordion").forEach((card) => {
    const code = card.dataset.orderKey || card.dataset.order;
    if (!nextCodes.has(code) && !protectedOrders.has(code)) card.remove();
  });
  if (visibleGroups.length) {
    [...list.children].forEach((child) => {
      if (!child.matches(".order-accordion")) child.remove();
    });
  }
  for (const group of visibleGroups) {
    const code = orderGroupKey(group[0] || {});
    if (!code) continue;
    const existing = list.querySelector(`[data-order-key="${CSS.escape(code)}"]`);
    if (orderCardHasUnsavedWork(existing)) continue;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = pdvOrderCard(group);
      const next = wrapper.firstElementChild;
    if (existing) {
      const wasOpen = existing.classList.contains("is-open")
        || existing.querySelector("[data-toggle-order]")?.getAttribute("aria-expanded") === "true";
      existing.replaceWith(next);
      if (wasOpen) {
        next.classList.add("is-open");
        next.querySelector("[data-toggle-order]")?.setAttribute("aria-expanded", "true");
        next.querySelector(".order-accordion-body")?.classList.remove("hidden");
      }
    }
    else list.appendChild(next);
    bindOrderToggles(next);
    next.querySelectorAll(".view-order-withdrawal").forEach((btn) => btn.addEventListener("click", () => {
      const card = btn.closest("[data-order]");
      openOrderWithdrawalReceipt({
        orderCode: btn.dataset.order || card?.dataset.order,
        pdv: btn.dataset.pdv,
        responsible: btn.dataset.responsible,
        date: btn.dataset.date,
        user: btn.dataset.user,
        signature: btn.dataset.signature,
        items: orderWithdrawalItemsFromButton(btn, card)
      });
    }));
  }
  if (!list.querySelector(".order-accordion")) {
    list.innerHTML = `<div class="card">Não há pedidos ${esc(activeStatus.toLowerCase())} no período.</div>`;
  }
}

// Monta o HTML do card de pedido no PDV
function pdvOrderCard(group) {
  const first = group[0];
  const visibleItems = orderDisplayItemsForStatus(group);
  const isWithdrawalStatus = first.status === "Aguardando Retirada";
  const statusTime = first.status === "Pendente"
    ? `Pendente desde ${moneyDate(first.data_hora)}`
    : first.status === "Em Andamento"
      ? `Em andamento desde ${moneyDate(first.em_andamento_em || first.data_hora)}`
      : isWithdrawalStatus
        ? `${first.status} desde ${moneyDate(first.pronto_retirada_em || first.liberado_em || first.data_hora)}`
        : `Finalizado em ${moneyDate(first.retirada_em || first.liberado_em || first.data_hora)}`;
  const orderItemsPayload = group.map((item) => ({
    id: item.id,
    version: item.version || 1,
    quantidade_solicitada: item.quantidade_solicitada || 0,
    quantidade_liberada: item.quantidade_liberada || 0
  }));
  return `<article class="card order-accordion" data-order="${esc(first.codigo_pedido)}" data-order-status="${esc(first.status)}" data-order-key="${esc(orderGroupKey(first))}" data-order-items='${esc(JSON.stringify(orderItemsPayload))}'>
    <button class="order-accordion-head" type="button" data-toggle-order aria-expanded="false">
      <span class="order-arrow">&#9662;</span>
      <span>
        <strong>Pedido ${esc(first.codigo_pedido)}</strong>
        <small>${esc(statusTime)}</small>
      </span>
      <span class="order-head-status">
        ${statusPill(first.status)}
        ${orderEditedBadge(first)}
      </span>
    </button>
    <div class="order-accordion-body hidden">
      ${first.observacao ? `<p class="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">${esc(first.observacao)}</p>` : ""}
      ${isWithdrawalStatus ? `<div class="release-alert card"><strong>Pedido pronto para retirada.</strong><p>Compareça ao almoxarifado para conferência e assinatura no dispositivo do almoxarifado.</p></div>` : ""}
      ${first.status === "Finalizado" && first.retirada_assinatura ? `<div class="order-card-actions no-print"><button class="btn secondary view-order-withdrawal" type="button" data-order="${esc(first.codigo_pedido)}" data-signature="${esc(first.retirada_assinatura)}" data-responsible="${esc(first.retirada_responsavel || "")}" data-date="${esc(first.retirada_em ? moneyDate(first.retirada_em) : "")}" data-user="${esc(first.retirada_usuario_almoxarifado || "")}" data-pdv="${esc(state.user?.name || "")}" data-items='${withdrawalItemsAttribute(orderReleasedItems(group))}'>Visualizar comprovante de retirada</button></div>` : ""}
      ${["Aguardando Retirada", "Finalizado"].includes(first.status)
        ? table(["Produto", "Estoque central", "Quantidade solicitada", "Quantidade liberada"], visibleItems.map((o) => `
        <tr>
          <td>${esc(o.produto)} ${o.item_origem === "ALMOX" ? `<span class="order-source-badge">Almox</span>` : ""}</td>
          <td class="release-number-cell">${centralStockValue(o)}</td>
          <td>${o.quantidade_solicitada}</td>
          <td>${o.quantidade_liberada}</td>
        </tr>`))
        : table(["Produto", "Estoque central", "Solicitado", "Liberado", "Falta enviar"], visibleItems.map((o) => `
        <tr>
          <td>${esc(o.produto)} ${o.item_origem === "ALMOX" ? `<span class="order-source-badge">Almox</span>` : ""}</td>
          <td class="release-number-cell">${centralStockValue(o)}</td>
          <td>${o.quantidade_solicitada}</td>
          <td>${o.quantidade_liberada}</td>
          <td>${pendingReleaseQty(o)}</td>
        </tr>`))}
    </div>
  </article>`;
}

// View de estoque do próprio PDV
async function viewMyStock(options = {}) {
  const data = await request("/api/pdv/products", { silentLoading: Boolean(options.auto) });
  shell(`<section class="card"><h3 class="text-xl font-black">Meu estoque</h3><div id="my-stock-content">${myStockContent(data.products)}</div></section>`);
  startAutoRefresh("my-stock", syncMyStockContent, 10000);
}

// Monta o conteúdo HTML da lista de estoque do PDV
function myStockContent(products = []) {
  const stockedProducts = products.filter((product) => Number(product.quantidade || 0) > 0);
  return stockedProducts.length
    ? table(["Produto", "Qtd manual", "Saldo OMIE", "Reservado", "Disponível", "Atualizado"], stockedProducts.map((p) => `<tr><td>${esc(p.nome)}</td><td>${p.quantidade}</td><td>${Number(p.saldo_omie ?? p.quantidade ?? 0)}</td><td>${Number(p.quantidade_reservada_acpark || 0)}</td><td>${Number(p.saldo_disponivel_acpark ?? p.quantidade ?? 0)}</td><td>${p.ultima_sincronizacao ? moneyDate(p.ultima_sincronizacao) : esc(p.sincronizacao_status || "Manual")}</td></tr>`))
    : `<p class="mt-3 text-sm text-slate-500">Nenhum produto com quantidade em estoque.</p>`;
}

// Recarrega e sincroniza o conteúdo do estoque do PDV
async function syncMyStockContent() {
  const target = document.querySelector("#my-stock-content");
  if (!target) return;
  const data = await request("/api/pdv/products", { silentLoading: true });
  target.innerHTML = myStockContent(data.products || []);
}

// Converte a lista de fotos de avaria em texto
function damagePhotosText(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || "[]");
    return parsed.filter(Boolean).join(", ");
  } catch {
    return String(value || "");
  }
}

// Normaliza o valor de fotos de avaria em array
function damagePhotosArray(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || "[]");
    return parsed
      .map((photo) => typeof photo === "string" ? photo : (photo?.url || photo?.thumbnail_url || photo?.data || ""))
      .filter(Boolean);
  } catch {
    return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
}

// Obtém as fotos de avaria associadas a um item
function damagePhotosForItem(damageItem, parentItem, totalItems = 0) {
  const itemPhotos = damagePhotosArray(damageItem?.fotos);
  if (itemPhotos.length) return itemPhotos;
  return totalItems <= 1 ? damagePhotosArray(parentItem?.fotos) : [];
}

// Monta o selo (badge) indicando item verificado
function verifiedBadge(item) {
  if (!item.verificado) return "";
  const details = [
    item.estornado_em ? `Verificação em ${moneyDate(item.estornado_em)}` : "",
    item.motivo_estorno ? `Motivo: ${item.motivo_estorno}` : "",
    item.estornado_por ? `Usuário: ${item.estornado_por}` : ""
  ].filter(Boolean).join(" | ");
  return `<span class="verified-badge" title="${esc(details || "Devolução passou por verificação.")}">Editado</span>`;
}

// Monta o selo indicando que o pedido foi editado
function orderEditedBadge(item) {
  if (!item?.pedido_reaberto_finalizado) return "";
  const details = [
    item.pedido_editado_em ? `Editado em ${moneyDate(item.pedido_editado_em)}` : "",
    item.pedido_editado_por ? `Usuário: ${item.pedido_editado_por}` : ""
  ].filter(Boolean).join(" | ");
  return `<span class="verified-badge order-edited-badge" title="${esc(details || "Pedido finalizado foi reaberto para edição.")}">Editado</span>`;
}

// Formata uma data para o formato aceito por input datetime-local
function localDateTimeInput(value = null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

// Exibe um modal de confirmação genérico do sistema
function confirmSystem({
  title = "Confirmar ação",
  message = "Deseja continuar?",
  consequence = "",
  detailsHtml = "",
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false
} = {}) {
  return new Promise((resolve) => {
    document.querySelector(".system-confirm-modal")?.remove();
    const modal = document.createElement("div");
    modal.className = "system-confirm-modal";
    modal.innerHTML = `
      <div class="system-confirm-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="system-confirm-head">
          <div>
            <p class="eyebrow">Confirmação</p>
            <h3>${esc(title)}</h3>
          </div>
          <button class="icon-action system-confirm-cancel" type="button" aria-label="Fechar">&times;</button>
        </div>
        <p>${esc(message)}</p>
        ${detailsHtml ? `<div class="system-confirm-details">${detailsHtml}</div>` : ""}
        ${consequence ? `<p class="system-confirm-note">${esc(consequence)}</p>` : ""}
        <div class="order-card-actions">
          <button class="btn secondary system-confirm-cancel" type="button">${esc(cancelLabel)}</button>
          <button class="btn ${danger ? "danger" : ""} system-confirm-ok" type="button">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const close = (value) => {
      modal.remove();
      resolve(value);
    };
    modal.querySelectorAll(".system-confirm-cancel").forEach((button) => button.addEventListener("click", () => close(false)));
    modal.querySelector(".system-confirm-ok").addEventListener("click", () => close(true));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close(false);
    });
    document.body.appendChild(modal);
    modal.querySelector(".system-confirm-ok").focus();
  });
}

// Exibe o modal de confirmação para exclusão de pedido
function confirmOrderDeleteSystem(orderCode = "") {
  return new Promise((resolve) => {
    const code = String(orderCode || "").trim();
    document.querySelector(".system-confirm-modal")?.remove();
    const modal = document.createElement("div");
    modal.className = "system-confirm-modal";
    modal.innerHTML = `
      <div class="system-confirm-dialog" role="dialog" aria-modal="true" aria-label="Excluir pedido">
        <div class="system-confirm-head">
          <div>
            <p class="eyebrow">Confirmação</p>
            <h3>Excluir pedido</h3>
          </div>
          <button class="icon-action system-confirm-cancel" type="button" aria-label="Fechar">&times;</button>
        </div>
        <p>Esta ação excluirá definitivamente o pedido <strong>${esc(code)}</strong>, somente se ele ainda não tiver movimentação, assinatura ou retirada.</p>
        <p class="system-confirm-note">Digite o código do pedido e informe uma justificativa para confirmar.</p>
        <label class="system-confirm-field">Código do pedido
          <input class="system-confirm-input" name="confirmation_code" autocomplete="off" placeholder="${esc(code)}" />
        </label>
        <label class="system-confirm-field">Justificativa
          <textarea class="system-confirm-input" name="justificativa" rows="3" placeholder="Informe o motivo da exclusão"></textarea>
        </label>
        <div class="order-card-actions">
          <button class="btn secondary system-confirm-cancel" type="button">Cancelar</button>
          <button class="btn danger system-confirm-delete" type="button" disabled>Excluir pedido</button>
        </div>
      </div>`;
    const codeInput = modal.querySelector("[name='confirmation_code']");
    const reasonInput = modal.querySelector("[name='justificativa']");
    const confirmBtn = modal.querySelector(".system-confirm-delete");
    const close = () => {
      modal.remove();
      resolve({ confirmed: false, justification: "" });
    };
    const update = () => {
      const typedCode = String(codeInput.value || "").trim();
      const reason = String(reasonInput.value || "").trim();
      confirmBtn.disabled = typedCode !== code || reason.length < 3;
    };
    codeInput.addEventListener("input", update);
    reasonInput.addEventListener("input", update);
    modal.querySelectorAll(".system-confirm-cancel").forEach((button) => button.addEventListener("click", close));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    modal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    confirmBtn.addEventListener("click", () => {
      if (confirmBtn.disabled) return;
      const justification = String(reasonInput.value || "").trim();
      modal.remove();
      resolve({ confirmed: true, justification });
    });
    document.body.appendChild(modal);
    codeInput.focus();
  });
}

// Monta as abas de status da tela de avarias
function damageStatusTabs(activeStatus, byStatus, attr = "damage-status") {
  return damageStatuses.map((status) => `
    <button class="config-tab ${status === activeStatus ? "is-active" : ""}" type="button" data-${attr}="${esc(status)}" role="tab" aria-selected="${status === activeStatus ? "true" : "false"}">
      ${esc(status)} <span>${byStatus[status]?.length || 0}</span>
    </button>`).join("");
}

// Monta a tabela de devoluções de avaria
function damageReturnTable(devolucoes = []) {
  if (!devolucoes.length) {
    return `<div class="damage-followup-empty">Nenhuma devolução encontrada para o filtro aplicado.</div>`;
  }
  return `<div class="damage-followup-list">${devolucoes.map((item) => {
    const items = damageItemsArray(item.itens);
    const refusedItems = items.filter((damageItem) => ["Recusado", "Aguardando retirada pelo ponto"].includes(itemVisibleStatus(damageItem)));
    const visibleStatus = pdvDamageVisibleStatus(item);
    const displayItems = items.length ? items : [item];
    const totalQuantity = displayItems.reduce((sum, damageItem) => sum + Number(damageItem.quantidade || item.quantidade || 0), 0);
    const refusedNames = refusedItems
      .map((damageItem) => `${damageItem.produto || damageItem.sku_produto} (${Number(damageItem.quantidade_recusada || damageItem.quantidade || 0)} ${damageItem.unidade_medida || item.unidade_medida || "un."})`)
      .filter(Boolean);
    const hasRefusedInfo = visibleStatus === "Recusado" || refusedItems.length > 0;
    const refusedMessage = refusedNames.length
      ? `Produto(s) aguardando retirada no Almoxarifado: ${refusedNames.join(", ")}.`
      : "Há produto recusado aguardando retirada no Almoxarifado.";
    const productRows = displayItems.map((damageItem) => {
      const photos = damagePhotosForItem(damageItem, item, displayItems.length);
      const productName = damageItem.produto || item.produto || damageItem.sku_produto || item.sku_produto || "-";
      return `
        <div class="damage-followup-product">
          <div>
            <strong>${esc(productName)}</strong>
            <span>Código ${esc(damageItem.sku_produto || item.sku_produto || "-")} | ${Number(damageItem.quantidade || item.quantidade || 0)} ${esc(damageItem.unidade_medida || item.unidade_medida || "UN")}</span>
          </div>
          <div>
            <span class="damage-reason-badge">${esc(damageItem.motivo || item.motivo || "-")}</span>
            ${statusPill(itemVisibleStatus(damageItem))}
          </div>
          <div class="damage-followup-product-meta">
            ${damageItem.data_validade || item.data_validade ? `<span>Validade: ${esc(damageItem.data_validade || item.data_validade)}</span>` : ""}
            ${damageItem.lote || item.lote ? `<span>Lote: ${esc(damageItem.lote || item.lote)}</span>` : ""}
            ${photos.length ? `<button class="btn secondary view-damage-photos" type="button" data-damage-photos='${esc(JSON.stringify(photos))}' data-damage-product="${esc(productName)}">Visualizar foto(s)</button>` : `<span>Sem foto visível</span>`}
          </div>
        </div>`;
    }).join("");
    return `
      <article class="damage-followup-card">
        <header class="damage-followup-head">
          <div>
            <p class="eyebrow">Solicitação</p>
            <h4>${esc(item.codigo_devolucao)}</h4>
            <span>${moneyDate(item.criado_em)} | ${displayItems.length} produto(s) | ${totalQuantity} unidade(s)</span>
          </div>
          <div class="damage-followup-status">
            ${statusPill(visibleStatus)}
            <span class="damage-omie-chip">Integração externa: ${esc(item.omie_status || "Integração desativada")}</span>
          </div>
        </header>
        ${hasRefusedInfo ? `<div class="damage-pdv-return-alert">${esc(refusedMessage)}</div>` : ""}
        <details class="damage-followup-details" ${visibleStatus === "Aguardando Produto" ? "open" : ""}>
          <summary>Ver produtos da solicitação</summary>
          <div class="damage-followup-products">${productRows}</div>
        </details>
        <footer class="damage-followup-actions">
          ${visibleStatus === "Aguardando Produto" ? `<button class="btn danger cancel-damage" type="button" data-id="${item.id}">Cancelar devolução</button>` : ""}
        </footer>
      </article>`;
  }).join("")}</div>`;
}

// Normaliza o valor de itens de avaria em array
function damageItemsArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Monta o HTML de pré-visualização das fotos de avaria
function damagePhotoPreviewHtml(photos = [], names = []) {
  return photos.length
    ? photos.map((_, index) => `
      <span class="damage-photo-preview-item">
        <span>${esc(names[index] || `Foto ${index + 1}`)}</span>
        <button class="btn secondary preview-damage-photo" type="button" data-index="${index}">Visualizar</button>
        <button class="icon-action danger remove-damage-photo" type="button" data-index="${index}" title="Excluir foto" aria-label="Excluir foto ${index + 1}">&times;</button>
      </span>`).join("")
    : `<span>Nenhuma foto anexada.</span>`;
}

// Faz o parse do payload de foto recebido
function parsePhotoPayload(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Normaliza o rótulo de status de avaria para exibição
function normalizeDamageStatusLabel(status) {
  if (["Cancelado", "Cancelada"].includes(status)) return "Cancelado";
  if (["Pendente", "Enviada ao almoxarifado", "Enviar para o Almoxarifado", "Aguardando recebimento físico", "Aguardando entrega física", "Aguardando Entrega Física"].includes(status)) return "Aguardando Produto";
  if (["Em recebimento", "Recebida e assinada", "Em conferência", "Recebida", "Aprovada", "Aguardando integração com o OMIE"].includes(status)) return "Em Aprovação";
  if (["Aprovação Parcial", "Aprovada parcialmente"].includes(status)) return "Aprovação Parcial";
  if (status === "Recusada") return "Recusado";
  if (status === "Finalizada") return "Finalizado";
  if (!damageStatuses.includes(status)) return status || "-";
  return status || "-";
}

// Determina o status visível de um item
function itemVisibleStatus(item) {
  if (Number(item.quantidade_recusada || 0) > 0 && item.retirada_confirmada) return "Retirado";
  if (item.status_item === "Aguardando retirada pelo ponto") return "Aguardando retirada pelo ponto";
  if (item.status_item === "Pendente") return "Pendente";
  if (["Aprovado", "Parcial"].includes(item.status_item)) return "Aprovado";
  if (["Recusado", "Recusada"].includes(item.status_item)) return "Recusado";
  return normalizeDamageStatusLabel(item.status_item);
}

// Determina o status de avaria visível no PDV
function pdvDamageVisibleStatus(item) {
  const visibleStatus = normalizeDamageStatusLabel(item.status);
  const items = damageItemsArray(item.itens);
  const displayItems = items.length ? items : [item];
  const refusedItems = displayItems.filter((damageItem) => Number(damageItem.quantidade_recusada || 0) > 0);
  if (visibleStatus === "Recusado" && refusedItems.length && refusedItems.every((damageItem) => Boolean(damageItem.retirada_confirmada))) {
    return "Retirado";
  }
  return visibleStatus;
}

// Lista os próximos status possíveis para uma avaria
function damageNextStatuses(status) {
  const current = normalizeDamageStatusLabel(status);
  if (current === "Finalizado" || current === "Recusado") return ["Verificação"];
  if (current === "Verificação") return ["Finalizado", "Recusado"];
  return [];
}

// Calcula o estado de devolução recusada do item
function damageRefusedReturnState(item) {
  const items = damageItemsArray(item.itens);
  const displayItems = items.length ? items : [item];
  const refusedItems = displayItems.filter((damageItem) => Number(damageItem.quantidade_recusada || 0) > 0);
  if (!refusedItems.length) return "sem_recusa";
  return refusedItems.every((damageItem) => Boolean(damageItem.retirada_confirmada)) ? "devolvido" : "aguardando";
}

// Verifica se a transição de status exige aprovação do admin
function damageStatusNeedsAdmin(currentStatus, nextStatus) {
  return ["Finalizado", "Recusado", "Verificação"].includes(currentStatus) || nextStatus === "Verificação";
}

// Verifica se a transição de status exige justificativa
function damageStatusNeedsReason(currentStatus, nextStatus) {
  return nextStatus === "Recusado" || nextStatus === "Verificação" || currentStatus === "Verificação";
}

// Abre o modal de alteração de status da avaria
function openDamageStatusModal({ id, status, code, refresh }) {
  const currentStatus = normalizeDamageStatusLabel(status);
  const nextStatuses = damageNextStatuses(currentStatus);
  const existing = document.querySelector(".damage-status-modal");
  if (existing) existing.remove();
  if (!nextStatuses.length) {
    toast("Este status não permite alteração manual neste momento.", "error");
    return;
  }
  const modal = document.createElement("div");
  modal.className = "damage-status-modal";
  modal.innerHTML = `
    <div class="damage-status-dialog" role="dialog" aria-modal="true" aria-label="Alterar status da devolução">
      <div class="damage-status-dialog-head">
        <div>
          <p class="eyebrow">Alterar status</p>
          <h3>${esc(code || "Devolução de avaria")}</h3>
          <p>Status atual: <strong>${esc(currentStatus)}</strong></p>
        </div>
        <button class="icon-action close-damage-status-modal" type="button" aria-label="Fechar">&times;</button>
      </div>
      <label>Próximo status
        <select name="status">
          ${nextStatuses.map((next) => `<option value="${esc(next)}">${esc(next)}</option>`).join("")}
        </select>
      </label>
      <label class="damage-status-reason">Justificativa
        <textarea name="motivo" rows="3" placeholder="Explique o motivo da alteração"></textarea>
      </label>
      <label class="damage-status-password hidden">Senha do administrador
        <input name="adminPassword" type="password" autocomplete="current-password" placeholder="Obrigatória para esta ação" />
      </label>
      <p class="damage-status-warning"></p>
      <div class="order-card-actions">
        <button class="btn secondary close-damage-status-modal" type="button">Cancelar</button>
        <button class="btn confirm-damage-status-change" type="button">Confirmar alteração</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const select = modal.querySelector("[name='status']");
  const reasonWrap = modal.querySelector(".damage-status-reason");
  const passwordWrap = modal.querySelector(".damage-status-password");
  const warning = modal.querySelector(".damage-status-warning");
  const updateRequirements = () => {
    const nextStatus = select.value;
    const needsReason = damageStatusNeedsReason(currentStatus, nextStatus);
    const needsAdmin = damageStatusNeedsAdmin(currentStatus, nextStatus);
    reasonWrap.classList.toggle("hidden", !needsReason);
    passwordWrap.classList.toggle("hidden", !needsAdmin);
    warning.textContent = nextStatus === "Finalizado"
      ? "Ao finalizar, o sistema baixa somente as quantidades aprovadas e evita duplicidade."
      : nextStatus === "Recusado"
        ? "Ao recusar, nenhuma baixa definitiva será executada."
        : "A verificação reabre uma devolução concluída e exige autorização do administrador.";
  };
  updateRequirements();
  select.addEventListener("change", updateRequirements);
  modal.querySelectorAll(".close-damage-status-modal").forEach((button) => button.addEventListener("click", () => modal.remove()));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.remove();
  });
  modal.querySelector(".confirm-damage-status-change").addEventListener("click", async () => {
    const nextStatus = select.value;
    const reason = modal.querySelector("[name='motivo']")?.value.trim() || "";
    const adminPassword = modal.querySelector("[name='adminPassword']")?.value || "";
    if (damageStatusNeedsReason(currentStatus, nextStatus) && !reason) {
      toast("Informe a justificativa para continuar.", "error");
      return;
    }
    if (damageStatusNeedsAdmin(currentStatus, nextStatus) && !adminPassword) {
      toast("Informe a senha do administrador para esta alteração.", "error");
      return;
    }
    const payload = {
      id,
      action: nextStatus === "Finalizado" ? "finalize" : "change_status",
      status: nextStatus,
      motivo_estorno: reason,
      motivo_divergencia: reason,
      observacao_interna: reason,
      adminPassword
    };
    const idempotencyKey = buttonIdempotencyKey(modal.querySelector(".confirm-damage-status-change"));
    await request("/api/admin/avarias/flow", idempotentRequestOptions(payload, idempotencyKey));
    clearButtonIdempotencyKey(modal.querySelector(".confirm-damage-status-change"));
    toast("Status da devolução atualizado.");
    modal.remove();
    await refresh(nextStatus);
  });
}

// Abre o visualizador de assinatura da avaria
function openDamageSignatureViewer({ image, code, responsible, date, pdv, user }) {
  const modal = document.createElement("div");
  modal.className = "photo-viewer";
  const close = () => modal.remove();
  modal.innerHTML = `
    <div class="photo-viewer-dialog damage-signature-viewer" role="dialog" aria-modal="true" aria-label="Visualizador de assinatura">
      <div class="photo-viewer-head">
        <div>
          <p class="eyebrow">Assinatura do responsável</p>
          <h3>${esc(code || "Devolução de avaria")}</h3>
          <p>${esc(responsible || "Responsável não informado")} ${pdv ? `| ${esc(pdv)}` : ""} ${date ? `| ${esc(date)}` : ""}</p>
          ${user ? `<p>Recebido por: ${esc(user)}</p>` : ""}
        </div>
        <button class="icon-action close-photo-viewer" type="button" aria-label="Fechar">&times;</button>
      </div>
      <div class="photo-viewer-body signature-viewer-body">
        ${image ? `<img src="${esc(image)}" alt="Assinatura do responsável pelo ponto" />` : `<p class="empty-state">Assinatura não registrada.</p>`}
      </div>
    </div>`;
  modal.querySelector(".close-photo-viewer").addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.body.appendChild(modal);
}

renderDamageDraftItems = function renderDamageDraftItemsNew() {
  const target = document.querySelector("#damage-draft-items");
  const counter = document.querySelector("#damage-draft-count");
  if (!target) return;
  const submitButton = document.querySelector("#send-damage-return");
  if (submitButton) submitButton.disabled = damageDraftItems.length === 0;
  if (counter) {
    counter.textContent = damageDraftItems.length
      ? `${damageDraftItems.length} produto(s) adicionado(s) à devolução.`
      : "Nenhum produto adicionado ainda.";
  }
  target.innerHTML = damageDraftItems.length
    ? `<div class="damage-draft-list">
        ${damageDraftItems.map((item, index) => `
          <article class="damage-draft-card">
            <div class="damage-draft-thumb">
              ${(item.fotos || [])[0] ? `<img src="${esc(item.fotos[0]?.data || item.fotos[0])}" alt="Foto principal de ${esc(item.produto || item.nome || "produto")}" />` : `<span>Sem foto</span>`}
            </div>
            <div>
              <strong>${esc(item.produto || item.nome || item.label || item.sku)}</strong>
              <span>Código ${esc(item.sku || item.codigo || "-")} | ${item.quantidade} ${esc(item.unidade_medida || item.unidadeMedida || "UN")} <span class="damage-reason-badge">${esc(item.motivo || "-")}</span></span>
              <small>${item.lote ? `Lote ${esc(item.lote)} | ` : ""}${item.data_validade || item.validade ? `Validade ${esc(item.data_validade || item.validade)} | ` : ""}${(item.fotos || []).length} foto(s)${item.observacao ? ` | ${esc(item.observacao)}` : ""}</small>
            </div>
            <div class="inline-actions damage-item-actions">
              ${(item.fotos || []).length ? `<button class="btn secondary view-damage-draft-photos" type="button" data-index="${index}">Visualizar fotos</button>` : ""}
              <button class="icon-action edit-damage-draft" type="button" data-index="${index}" title="Editar item" aria-label="Editar item">?</button>
              <button class="icon-action danger remove-damage-draft" type="button" data-index="${index}" title="Remover item" aria-label="Remover item">&times;</button>
            </div>
          </article>`).join("")}
      </div>`
    : `<div class="damage-empty-state"><strong>Nenhum produto adicionado ainda.</strong><span>Preencha um produto por vez e clique em adicionar para montar a devolução.</span></div>`;
  target.querySelectorAll(".remove-damage-draft").forEach((button) => button.addEventListener("click", async () => {
    const confirmed = await confirmSystem({
      title: "Remover produto",
      message: "Remover este produto da devolução?",
      consequence: "Os demais produtos adicionados serão mantidos.",
      confirmLabel: "Remover",
      danger: true
    });
    if (!confirmed) return;
    damageDraftItems = damageDraftItems.filter((_, index) => index !== Number(button.dataset.index));
    renderDamageDraftItems();
    window.__saveDamageDraft?.();
  }));
  target.querySelectorAll(".view-damage-draft-photos").forEach((button) => button.addEventListener("click", () => {
    const item = damageDraftItems[Number(button.dataset.index)];
    if (item) openDamagePhotoViewer((item.fotos || []).map((photo) => typeof photo === "string" ? photo : photo?.data).filter(Boolean), 0, item.produto || "Produto anexado");
  }));
  target.querySelectorAll(".edit-damage-draft").forEach((button) => button.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("damage-draft-edit-requested", { detail: { index: Number(button.dataset.index) } }));
  }));
  window.__renderDamageSummary?.();
};

viewDamageReturn = async function viewDamageReturnNew(filters = {}) {
  const damageFrom = filters.damageFrom || filters.from || document.querySelector("[name='damageFrom']")?.value || "";
  const damageTo = filters.damageTo || filters.to || document.querySelector("[name='damageTo']")?.value || "";
  const damageStatus = filters.damageStatus || document.querySelector("[name='damageStatus']")?.value || "";
  const damageParams = new URLSearchParams();
  if (damageFrom) damageParams.set("from", damageFrom);
  if (damageTo) damageParams.set("to", damageTo);
  if (damageStatus) damageParams.set("status", damageStatus);
  const [productsData, damagesData] = await Promise.all([
    request("/api/pdv/products", { silentLoading: Boolean(filters.auto) }),
    request(`/api/pdv/avarias?${damageParams.toString()}`, { silentLoading: Boolean(filters.auto) })
  ]);
  const availableProducts = (productsData.products || []).filter((product) => Number(product.quantidade || 0) > 0);
  const normalizeSearch = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const labelForProduct = (product) => `${product.nome} (${product.sku})`;
  const todayValue = today();
  const responsibleValue = state.user?.responsavel || state.user?.responsavel_pdv || state.user?.name || "";

  shell(`
    <section class="damage-return-page">
      <section class="card damage-return-head">
        <div>
          <p class="eyebrow">Devolução de avaria</p>
          <h3 class="section-title text-2xl font-black">Nova Devolução de Avarias</h3>
          <p class="text-sm text-slate-500">Monte a devolução em duas etapas: adicione os produtos e depois envie a solicitação completa ao almoxarifado.</p>
        </div>
        <div class="damage-return-head-actions">
          <div class="damage-draft-status" id="damage-draft-status">Rascunho vazio</div>
        </div>
      </section>
      <div class="config-tabs damage-return-tabs" role="tablist" aria-label="Devolução de avarias">
        <button class="config-tab is-active" id="damage-tab-form" type="button" data-damage-panel="form" role="tab" aria-selected="true" aria-controls="damage-form">Nova devolução</button>
        <button class="config-tab" id="damage-tab-followup" type="button" data-damage-panel="followup" role="tab" aria-selected="false" aria-controls="damage-return-followup">Acompanhamento <span>${(damagesData.devolucoes || []).length}</span></button>
      </div>
      <section class="damage-return-layout">
      <form id="damage-form" class="card damage-return-form" novalidate>
        <section class="damage-section damage-info-card">
          <div class="damage-section-head">
            <span class="damage-section-icon" aria-hidden="true">?</span>
            <div>
              <p class="eyebrow">Informações da devolução</p>
              <h4>Dados gerais</h4>
              <p>Confira a origem e identifique quem está solicitando a devolução.</p>
            </div>
          </div>
          <div class="damage-info-grid">
            <label class="damage-field damage-readonly-field">Ponto de origem
              <input value="${esc(state.user?.name || "")}" readonly aria-readonly="true" />
            </label>
            <label class="damage-field"><span><span class="required-mark">*</span>Pessoa responsável pelo PDV</span>
              <input name="usuario_solicitante" value="${esc(responsibleValue)}" placeholder="Nome da pessoa responsável" required />
              <small class="field-error" data-damage-error="usuario_solicitante"></small>
            </label>
            <div class="damage-info-chip">
              <small>Data da solicitação</small>
              <strong>${moneyDate(new Date().toISOString())}</strong>
            </div>
            <div class="damage-info-chip">
              <small>Identificação</small>
              <strong>Rascunho de devolução</strong>
            </div>
          </div>
        </section>
        <div class="damage-return-columns">
          <section class="damage-section damage-product-card">
            <div class="damage-section-head">
              <span class="damage-section-icon" aria-hidden="true">+</span>
              <div>
                <p class="eyebrow">Adicionar produto</p>
                <h4>Adicionar produto à devolução</h4>
                <p>Preencha os dados do produto avariado e adicione-o à lista antes de enviar.</p>
              </div>
            </div>
            <div class="damage-field-group">
              <p class="damage-group-title">Produto</p>
              <label class="damage-field damage-product-search-field"><span><span class="required-mark">*</span>Produto</span>
          <span class="field-hint">Pesquisar produto no estoque do ponto</span>
          <div class="category-product-picker">
            <input id="damage-product-search" class="category-add-product-search" type="search" placeholder="Digite o nome ou SKU do produto" autocomplete="off" />
            <input id="damage-product-sku" name="sku" type="hidden" />
            <div class="category-product-suggestions hidden" id="damage-product-suggestions"></div>
          </div>
          <small class="field-error" data-damage-error="produto"></small>
          <small class="field-hint" id="damage-selected-stock"></small>
            </label>
            </div>
            <div class="damage-field-group">
              <p class="damage-group-title">Quantidade e motivo</p>
              <div class="damage-three-cols">
          <label class="damage-field"><span><span class="required-mark">*</span>Quantidade</span>
            <input name="quantidade" type="text" inputmode="decimal" value="1" />
            <small class="field-error" data-damage-error="quantidade"></small>
          </label>
          <label class="damage-field"><span><span class="required-mark">*</span>Unidade de medida</span>
            <input name="unidade_medida" value="UN" placeholder="UN, CX, KG..." readonly aria-readonly="true" />
            <small class="field-error" data-damage-error="unidade_medida"></small>
          </label>
          <label class="damage-field"><span><span class="required-mark">*</span>Motivo</span>
          <select name="motivo" id="damage-motivo">
            <option value="">Selecione o motivo</option>
            ${damageMotivos.map((motivo) => `<option value="${esc(motivo)}">${esc(motivo)}</option>`).join("")}
          </select>
          <small class="field-error" data-damage-error="motivo"></small>
          </label>
              </div>
            </div>
        <label class="damage-field hidden" id="damage-other-wrap"><span><span class="required-mark">*</span>Justificativa de outro motivo</span>
          <input name="outro_motivo" placeholder="Descreva o motivo" />
          <small class="field-error" data-damage-error="outro_motivo"></small>
        </label>
            <div class="damage-field-group">
              <p class="damage-group-title">Datas e lote</p>
              <div class="damage-three-cols">
        <label class="damage-field"><span><span class="required-mark">*</span>Data da identificação</span>
          <input name="data_identificacao" class="locked-date-input" type="date" value="${todayValue}" min="${todayValue}" max="${todayValue}" readonly aria-readonly="true" />
          <small class="field-error" data-damage-error="data_identificacao"></small>
        </label>
        <label class="damage-field">Lote
          <input name="lote" placeholder="Opcional" />
          <small class="field-error" data-damage-error="lote"></small>
        </label>
        <label class="damage-field">Validade
          <input name="data_validade" type="date" />
          <small class="field-error" data-damage-error="data_validade"></small>
        </label>
              </div>
            </div>
            <div class="damage-field-group">
              <p class="damage-group-title">Fotos</p>
        <div class="damage-field">
          <span><span class="required-mark">*</span>Fotos do produto</span>
          <label class="btn secondary damage-photo-button">
            Anexar fotos pela câmera ou galeria
            <input id="damage-photos" type="file" accept="image/*,.heic,.heif" multiple hidden />
          </label>
          <div class="damage-dropzone" id="damage-dropzone">
            <strong>Arraste imagens aqui</strong>
            <span>JPG, PNG, WEBP, HEIC ou HEIF até 5 MB por foto.</span>
          </div>
          <input name="fotos" id="damage-photos-payload" type="hidden" />
          <div class="damage-photo-list" id="damage-photo-list"><span>Nenhuma foto anexada.</span></div>
          <small class="field-error" data-damage-error="fotos"></small>
        </div>
            </div>
            <div class="damage-field-group">
              <p class="damage-group-title">Observação</p>
        <label class="damage-field">Observação
          <textarea name="observacao" rows="3" maxlength="500" placeholder="Descreva detalhes adicionais sobre o estado do produto."></textarea>
          <small class="field-hint" id="damage-observation-count">0 de 500 caracteres</small>
        </label>
            </div>
        <input id="damage-edit-index" type="hidden" value="" />
        <button class="btn add-damage-item-btn" id="add-damage-item" type="button" disabled>+ Adicionar produto à devolução</button>
        <p class="text-sm text-slate-500" id="damage-add-feedback" aria-live="polite"></p>
          </section>
          <div class="damage-return-side">
            <section class="damage-draft-panel damage-section">
              <div class="damage-section-head">
                <span class="damage-section-icon" aria-hidden="true">=</span>
                <div>
                  <p class="eyebrow">Produtos adicionados</p>
                  <h4>Produtos da devolução</h4>
                  <p id="damage-draft-count">Nenhum produto adicionado ainda.</p>
                </div>
              </div>
              <div id="damage-draft-items"></div>
            </section>
            <section class="damage-summary-card" id="damage-summary-card"></section>
            <button class="btn send-damage-return" id="send-damage-return" type="submit" disabled>Enviar devolução ao almoxarifado</button>
          </div>
        </div>
      </form>
      <section class="card damage-return-followup hidden" id="damage-return-followup">
        <form id="damage-followup-filter" class="filter-panel damage-followup-filter">
          <div class="filter-copy">
            <p class="eyebrow">Acompanhamento</p>
            <h3 class="section-title text-xl font-black">Minhas devoluções</h3>
            <p>Consulte suas solicitações por período e status.</p>
          </div>
          <label class="field-date">Data inicial
            <input name="damageFrom" type="date" value="${esc(damageFrom)}" />
          </label>
          <label class="field-date">Data final
            <input name="damageTo" type="date" value="${esc(damageTo)}" />
          </label>
          <label class="field-select">Status
            <select name="damageStatus">
              <option value="">Todos os status</option>
              ${damageStatuses.map((status) => `<option value="${esc(status)}" ${status === damageStatus ? "selected" : ""}>${esc(status)}</option>`).join("")}
            </select>
          </label>
          <div class="filter-actions damage-followup-filter-actions">
            <button class="btn" type="submit">Filtrar</button>
            <button class="btn secondary damage-period-shortcut" type="button" data-period="today">Hoje</button>
            <button class="btn secondary damage-period-shortcut" type="button" data-period="week">Últimos 7 dias</button>
            <button class="btn secondary damage-period-clear" type="button">Limpar período</button>
          </div>
        </form>
        <div id="damage-return-list">${damageReturnTable(damagesData.devolucoes || [])}</div>
      </section>
      </section>
    </section>`);

  const form = document.querySelector("#damage-form");
  const productSearch = document.querySelector("#damage-product-search");
  const productSku = document.querySelector("#damage-product-sku");
  const suggestions = document.querySelector("#damage-product-suggestions");
  const photoInput = document.querySelector("#damage-photos");
  const photoPayload = document.querySelector("#damage-photos-payload");
  const photoList = document.querySelector("#damage-photo-list");
  const dropzone = document.querySelector("#damage-dropzone");
  const feedback = document.querySelector("#damage-add-feedback");
  const addButton = document.querySelector("#add-damage-item");
  const sendButton = document.querySelector("#send-damage-return");
  const summaryCard = document.querySelector("#damage-summary-card");
  const draftStatus = document.querySelector("#damage-draft-status");
  const selectedStock = document.querySelector("#damage-selected-stock");
  const followupPanel = document.querySelector("#damage-return-followup");
  const damageTabs = document.querySelectorAll("[data-damage-panel]");
  const observationField = form.querySelector('[name="observacao"]');
  const observationCount = document.querySelector("#damage-observation-count");
  const draftKey = `acpark:damage-return-draft:${state.user?.id || state.user?.name || "pdv"}`;
  const uploadDraftId = `damage-${state.user?.pdvId || state.user?.name || "pdv"}-${Date.now()}-${uuid()}`;
  let currentItemTempId = uuid();
  let selectedProduct = null;
  let currentPhotos = [];
  let activeSuggestion = -1;
  let validationTouched = false;
  let adding = false;
  let sending = false;

  const fields = {
    usuario_solicitante: form.querySelector('[name="usuario_solicitante"]'),
    produto: productSearch,
    quantidade: form.querySelector('[name="quantidade"]'),
    unidade_medida: form.querySelector('[name="unidade_medida"]'),
    motivo: form.querySelector('[name="motivo"]'),
    outro_motivo: form.querySelector('[name="outro_motivo"]'),
    data_identificacao: form.querySelector('[name="data_identificacao"]'),
    lote: form.querySelector('[name="lote"]'),
    data_validade: form.querySelector('[name="data_validade"]'),
    fotos: photoList
  };
  damageTabs.forEach((tab) => tab.addEventListener("click", () => {
    const panel = tab.dataset.damagePanel || "form";
    const showingFollowup = panel === "followup";
    form.classList.toggle("hidden", showingFollowup);
    followupPanel?.classList.toggle("hidden", !showingFollowup);
    damageTabs.forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }));
  const refreshDamageFollowup = async ({ keepStatus = true } = {}) => {
    const filterForm = document.querySelector("#damage-followup-filter");
    const filterData = filterForm ? Object.fromEntries(new FormData(filterForm)) : {};
    if (!keepStatus) filterData.damageStatus = "";
    const params = new URLSearchParams();
    if (filterData.damageFrom) params.set("from", filterData.damageFrom);
    if (filterData.damageTo) params.set("to", filterData.damageTo);
    if (filterData.damageStatus) params.set("status", filterData.damageStatus);
    const fresh = await request(`/api/pdv/avarias?${params.toString()}`, { silentLoading: true });
    const list = document.querySelector("#damage-return-list");
    if (!list) return;
    list.innerHTML = damageReturnTable(fresh.devolucoes || []);
    document.querySelector("#damage-tab-followup span").textContent = fresh.devolucoes?.length || 0;
    bindDamageCancelButtons();
  };
  document.querySelector("#damage-followup-filter")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await refreshDamageFollowup();
    toast("Filtro aplicado.");
  });
  document.querySelectorAll(".damage-period-shortcut").forEach((button) => button.addEventListener("click", async () => {
    const filterForm = document.querySelector("#damage-followup-filter");
    if (!filterForm) return;
    const formData = new FormData(filterForm);
    filterForm.elements.damageTo.value = today();
    filterForm.elements.damageFrom.value = button.dataset.period === "today" ? today() : weekAgo();
    filterForm.elements.damageStatus.value = formData.get("damageStatus") || "";
    await refreshDamageFollowup();
  }));
  document.querySelector(".damage-period-clear")?.addEventListener("click", async () => {
    const filterForm = document.querySelector("#damage-followup-filter");
    if (!filterForm) return;
    filterForm.elements.damageFrom.value = "";
    filterForm.elements.damageTo.value = "";
    await refreshDamageFollowup();
  });
  const errorLabels = {
    usuario_solicitante: "pessoa responsável",
    produto: "produto",
    quantidade: "quantidade",
    unidade_medida: "unidade de medida",
    motivo: "motivo",
    outro_motivo: "justificativa",
    data_identificacao: "data de identificação",
    lote: "lote",
    data_validade: "validade",
    fotos: "foto"
  };
  const setFieldError = (name, message = "") => {
    const error = form.querySelector(`[data-damage-error="${name}"]`);
    if (error) error.textContent = message;
    fields[name]?.classList?.toggle("field-invalid", Boolean(message));
    fields[name]?.setAttribute?.("aria-invalid", message ? "true" : "false");
  };
  const clearErrors = () => Object.keys(fields).forEach((name) => setFieldError(name, ""));
  const normalizePhotoSrc = (photo) => typeof photo === "string" ? photo : (photo?.url || photo?.thumbnail_url || photo?.data || "");
  const clonePhoto = (photo) => typeof photo === "string" ? photo : { ...photo };
  const asQuantity = (value) => Number(String(value || "").replace(",", "."));
  const normalizeDate = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const parts = raw.split("/");
    if (parts.length !== 3) return "";
    return `${parts[2].padStart(4, "0")}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
  };
  const productBySku = (sku) => availableProducts.find((product) => String(product.sku) === String(sku));
  const activeReturnStatuses = new Set(["Aguardando Produto", "Em Aprovação", "Aprovação Parcial", "Verificação"]);
  const sameOptionalValue = (left, right) => String(left || "") === String(right || "");
  const findActiveDuplicateReturn = (item) => {
    const sku = String(item.sku || item.codigo || "");
    const lote = item.lote || "";
    const validade = item.data_validade || item.validade || "";
    return (damagesData.devolucoes || []).find((devolucao) => {
      if (!activeReturnStatuses.has(normalizeDamageStatusLabel(devolucao.status))) return false;
      const items = damageItemsArray(devolucao.itens);
      const candidates = items.length ? items : [devolucao];
      return candidates.some((candidate) =>
        String(candidate.sku_produto || candidate.sku || devolucao.sku_produto || "") === sku
        && sameOptionalValue(candidate.lote || devolucao.lote, lote)
        && sameOptionalValue(candidate.data_validade || devolucao.data_validade, validade)
      );
    });
  };
  const duplicateReturnMessage = (devolucao) => {
    const quantity = devolucao.total_quantidade || devolucao.quantidade || 0;
    return `Já existe uma solicitação ativa para este produto. Solicitação ${devolucao.codigo_devolucao}, atualmente em ${normalizeDamageStatusLabel(devolucao.status)}, criada em ${moneyDate(devolucao.criado_em)}, quantidade ${quantity}.`;
  };
  const saveDraft = () => {
    const draft = {
      usuario_solicitante: fields.usuario_solicitante.value,
      produto_sku: productSku.value,
      produto_texto: productSearch.value,
      quantidade: fields.quantidade.value,
      unidade_medida: fields.unidade_medida.value,
      motivo: fields.motivo.value,
      outro_motivo: fields.outro_motivo.value,
      data_identificacao: fields.data_identificacao.value,
      lote: fields.lote.value,
      data_validade: fields.data_validade.value,
      observacao: observationField.value,
      fotos: currentPhotos,
      itens: damageDraftItems
    };
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
      if (draftStatus) draftStatus.textContent = damageDraftItems.length || productSearch.value || currentPhotos.length ? "Rascunho salvo" : "Rascunho vazio";
    } catch {
      if (draftStatus) draftStatus.textContent = "Rascunho mantido nesta tela";
    }
  };
  window.__saveDamageDraft = saveDraft;
  const renderSummary = () => {
    if (!summaryCard) return;
    const totalUnits = damageDraftItems.reduce((sum, item) => sum + Number(item.quantidade || 0), 0);
    const totalPhotos = damageDraftItems.reduce((sum, item) => sum + (item.fotos || []).length, 0);
    const reasons = [...new Set(damageDraftItems.map((item) => item.motivo).filter(Boolean))];
    summaryCard.innerHTML = `
      <div class="damage-section-head">
        <span class="damage-section-icon" aria-hidden="true">?</span>
        <div>
          <p class="eyebrow">Resumo e envio</p>
          <h4>Resumo da devolução</h4>
          <p>Revise os dados antes de enviar a solicitação ao almoxarifado.</p>
        </div>
      </div>
      <div class="damage-summary-grid">
        <span><small>Ponto</small><strong>${esc(state.user?.name || "-")}</strong></span>
        <span><small>Responsável</small><strong>${esc(fields.usuario_solicitante.value || "-")}</strong></span>
        <span><small>Produtos</small><strong>${damageDraftItems.length}</strong></span>
        <span><small>Total de unidades</small><strong>${totalUnits}</strong></span>
        <span><small>Fotos</small><strong>${totalPhotos}</strong></span>
        <span><small>Motivos</small><strong>${esc(reasons.join(", ") || "-")}</strong></span>
      </div>
      ${damageDraftItems.length ? "" : `<p class="damage-send-hint">Adicione pelo menos um produto para enviar a devolução.</p>`}`;
  };
  window.__renderDamageSummary = renderSummary;
  const productMatches = (value) => {
    const term = normalizeSearch(value);
    if (!term) return [];
    return availableProducts
      .map((product) => {
        const haystack = normalizeSearch(`${product.sku} ${product.nome} ${product.categoria || ""} ${labelForProduct(product)}`);
        const score = normalizeSearch(product.sku) === term ? 0
          : normalizeSearch(product.sku).startsWith(term) ? 1
          : normalizeSearch(product.nome).startsWith(term) ? 2
          : haystack.includes(term) ? 3
          : 99;
        return { product, score };
      })
      .filter((entry) => entry.score < 99)
      .sort((a, b) => a.score - b.score || String(a.product.nome).localeCompare(String(b.product.nome)))
      .slice(0, 12)
      .map((entry) => entry.product);
  };
  const findExactProduct = (value) => {
    const term = normalizeSearch(value);
    if (!term) return null;
    const skuFromLabel = String(value || "").match(/\(([^()]+)\)\s*$/)?.[1]?.trim();
    return availableProducts.find((product) => normalizeSearch(product.sku) === term)
      || availableProducts.find((product) => skuFromLabel && normalizeSearch(product.sku) === normalizeSearch(skuFromLabel))
      || availableProducts.find((product) => normalizeSearch(`${product.sku} - ${product.nome}`) === term)
      || availableProducts.find((product) => normalizeSearch(labelForProduct(product)) === term)
      || availableProducts.find((product) => normalizeSearch(product.nome) === term)
      || null;
  };
  const selectProduct = (product) => {
    selectedProduct = product ? {
      id: product.id || product.sku,
      codigo: product.sku,
      sku: product.sku,
      nome: product.nome,
      unidadeMedida: product.unidade_medida || product.unidade || "UN",
      saldoDisponivel: Number(product.quantidade || 0),
      raw: product
    } : null;
    productSearch.value = product ? labelForProduct(product) : "";
    productSearch.dataset.selectedSku = product?.sku || "";
    productSku.value = product?.sku || "";
    fields.unidade_medida.value = selectedProduct?.unidadeMedida || "UN";
    if (selectedStock) {
      selectedStock.textContent = selectedProduct ? `Saldo disponível: ${selectedProduct.saldoDisponivel} ${selectedProduct.unidadeMedida}.` : "";
    }
    suggestions.classList.add("hidden");
    suggestions.innerHTML = "";
    activeSuggestion = -1;
    updateButtons();
  };
  const renderSuggestions = (matches) => {
    if (!matches.length) {
      suggestions.innerHTML = productSearch.value.trim()
        ? `<div class="category-product-suggestion is-empty"><strong>Nenhum produto encontrado</strong><span>Digite outro nome ou SKU.</span></div>`
        : "";
      suggestions.classList.toggle("hidden", !productSearch.value.trim());
      return;
    }
    activeSuggestion = Math.max(0, Math.min(activeSuggestion, matches.length - 1));
    suggestions.innerHTML = matches.map((product, index) => `
      <button class="category-product-suggestion damage-product-suggestion ${index === activeSuggestion ? "is-active" : ""}" type="button" data-sku="${esc(product.sku)}">
        <strong>${esc(product.nome)}</strong>
        <span>${esc(product.sku)} | saldo ${Number(product.quantidade || 0)}${product.categoria ? ` | ${esc(product.categoria)}` : ""}</span>
      </button>`).join("");
    suggestions.classList.remove("hidden");
  };
  const resolveProduct = () => {
    if (selectedProduct && String(selectedProduct.sku) === String(productSku.value)) return selectedProduct;
    if (productSku.value) {
      const product = productBySku(productSku.value);
      return product ? {
        id: product.id || product.sku,
        codigo: product.sku,
        sku: product.sku,
        nome: product.nome,
        unidadeMedida: product.unidade_medida || product.unidade || "UN",
        saldoDisponivel: Number(product.quantidade || 0),
        raw: product
      } : null;
    }
    return null;
  };
  const syncPhotos = (photos) => {
    currentPhotos = photos.filter((photo) => normalizePhotoSrc(photo)).map(clonePhoto).slice(0, 12);
    photoPayload.value = JSON.stringify(currentPhotos);
    photoList.innerHTML = damagePhotoPreviewHtml(currentPhotos.map(normalizePhotoSrc), currentPhotos.map((photo, index) => photo?.name || `Foto ${index + 1}`));
    saveDraft();
  };
  const restoreDraft = async () => {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) || "null");
      if (!draft) return;
      const hasContent = (draft.itens || []).length || draft.produto_texto || (draft.fotos || []).length;
      if (!hasContent) return;
      const shouldRestore = await confirmSystem({
        title: "Restaurar rascunho",
        message: "Existe um rascunho de devolução salvo. Deseja restaurar os dados?",
        consequence: "Se cancelar, o rascunho continua salvo para uma próxima tentativa.",
        confirmLabel: "Restaurar"
      });
      if (!shouldRestore) return;
      fields.usuario_solicitante.value = draft.usuario_solicitante || fields.usuario_solicitante.value;
      damageDraftItems = Array.isArray(draft.itens) ? draft.itens : [];
      productSearch.value = draft.produto_texto || "";
      const product = draft.produto_sku ? productBySku(draft.produto_sku) : null;
      if (product) selectProduct(product);
      else productSku.value = "";
      fields.quantidade.value = draft.quantidade || "1";
      fields.unidade_medida.value = draft.unidade_medida || fields.unidade_medida.value || "UN";
      fields.motivo.value = draft.motivo || "";
      fields.outro_motivo.value = draft.outro_motivo || "";
      document.querySelector("#damage-other-wrap").classList.toggle("hidden", fields.motivo.value !== "Outro motivo");
      fields.data_identificacao.value = todayValue;
      fields.lote.value = draft.lote || "";
      fields.data_validade.value = draft.data_validade || "";
      observationField.value = draft.observacao || "";
      currentPhotos = [];
      syncPhotos(draft.fotos || []);
      renderDamageDraftItems();
      toast("Rascunho restaurado.");
    } catch {
      localStorage.removeItem(draftKey);
    }
  };
  const validateItem = ({ showErrors = false } = {}) => {
    const product = resolveProduct();
    const quantity = asQuantity(fields.quantidade.value);
    const unit = fields.unidade_medida.value.trim().toUpperCase();
    const reason = fields.motivo.value;
    const otherReason = fields.outro_motivo.value.trim();
    const identifiedAt = normalizeDate(fields.data_identificacao.value);
    const expiresAt = normalizeDate(fields.data_validade.value);
    const photos = currentPhotos.length ? [...currentPhotos] : parsePhotoPayload(photoPayload.value);
    const errors = {};
    if (!product?.id) errors.produto = "Selecione um produto da lista.";
    if (!Number.isFinite(quantity) || quantity <= 0) errors.quantidade = "Informe uma quantidade válida.";
    if (product?.id && Number.isFinite(quantity) && quantity > Number(product.saldoDisponivel || 0)) {
      errors.quantidade = `Saldo insuficiente. Disponível no ponto: ${Number(product.saldoDisponivel || 0)}.`;
    }
    if (!unit) errors.unidade_medida = "Obrigatório";
    if (!reason) errors.motivo = "Obrigatório";
    if (["Outro motivo", "Outro"].includes(reason) && !otherReason) errors.outro_motivo = "Obrigatório";
    if (!identifiedAt) errors.data_identificacao = "Obrigatório";
    if ((fields.data_validade.required || reason === "Produto vencido") && !expiresAt) errors.data_validade = "Informe a validade do produto.";
    if (!photos.length) errors.fotos = "Obrigatório";
    if (showErrors) {
      clearErrors();
      Object.entries(errors).forEach(([name, message]) => setFieldError(name, message));
    }
    return {
      valid: Object.keys(errors).length === 0,
      errors,
      item: {
        itemId: uuid(),
        produto_id: product?.id || "",
        produtoId: product?.id || "",
        sku: product?.sku || "",
        codigo: product?.codigo || product?.sku || "",
        produto: product?.nome || productSearch.value,
        nome: product?.nome || productSearch.value,
        label: product ? labelForProduct(product.raw || product) : productSearch.value,
        quantidade: quantity,
        unidade_medida: unit || "UN",
        unidadeMedida: unit || "UN",
        motivo: reason,
        outro_motivo: otherReason,
        data_identificacao: identifiedAt,
        dataIdentificacao: identifiedAt,
        data_validade: expiresAt,
        validade: expiresAt || null,
        lote: form.querySelector('[name="lote"]')?.value.trim() || null,
        observacao: observationField.value.trim(),
        fotos: photos.map(clonePhoto),
        photoIds: photos.map((photo) => Number(photo?.id || 0)).filter(Boolean),
        foto_ids: photos.map((photo) => Number(photo?.id || 0)).filter(Boolean)
      }
    };
  };
  function updateButtons() {
    fields.data_identificacao.value = todayValue;
    const result = validateItem();
    const missing = Object.keys(result.errors).map((key) => errorLabels[key] || key);
    addButton.disabled = !result.valid || adding;
    addButton.classList.toggle("is-ready", result.valid && !adding);
    addButton.title = result.valid ? "Produto pronto para adicionar." : `Pendências: ${missing.join(", ")}.`;
    if (validationTouched) {
      clearErrors();
      Object.entries(result.errors).forEach(([name, message]) => setFieldError(name, message));
    }
    if (feedback) {
      feedback.textContent = result.valid ? "Pronto para adicionar o produto." : (missing.length ? `Pendências: ${missing.join(", ")}.` : "");
      feedback.className = "text-sm text-slate-500";
    }
    sendButton.disabled = damageDraftItems.length === 0;
    if (observationCount) observationCount.textContent = `${observationField.value.length} de 500 caracteres`;
    renderSummary();
    saveDraft();
  }
  const clearItemForm = () => {
    selectedProduct = null;
    productSearch.value = "";
    productSearch.dataset.selectedSku = "";
    productSku.value = "";
    fields.quantidade.value = "1";
    fields.unidade_medida.value = "UN";
    fields.motivo.value = "";
    fields.outro_motivo.value = "";
    document.querySelector("#damage-other-wrap").classList.add("hidden");
    fields.data_identificacao.value = todayValue;
    fields.lote.value = "";
    fields.data_validade.value = "";
    observationField.value = "";
    syncPhotos([]);
    currentItemTempId = uuid();
    document.querySelector("#damage-edit-index").value = "";
    addButton.textContent = "+ Adicionar produto à devolução";
    clearErrors();
    validationTouched = false;
    updateButtons();
    productSearch.focus();
  };

  productSearch.addEventListener("input", () => {
    selectedProduct = null;
    productSku.value = "";
    activeSuggestion = 0;
    renderSuggestions(productMatches(productSearch.value));
    updateButtons();
  });
  productSearch.addEventListener("keydown", (event) => {
    const matches = productMatches(productSearch.value);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeSuggestion = matches.length ? (activeSuggestion + 1) % matches.length : -1;
      renderSuggestions(matches);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeSuggestion = matches.length ? (activeSuggestion - 1 + matches.length) % matches.length : -1;
      renderSuggestions(matches);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const product = matches[activeSuggestion] || findExactProduct(productSearch.value);
      if (product) selectProduct(product);
    }
  });
  suggestions.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const button = event.target.closest(".damage-product-suggestion");
    if (!button) return;
    const product = productBySku(button.dataset.sku);
    if (product) selectProduct(product);
  });
  productSearch.addEventListener("blur", () => {
    setTimeout(() => {
      suggestions.classList.add("hidden");
      updateButtons();
    }, 120);
  });
  document.querySelector("#damage-motivo").addEventListener("change", () => {
    const isOther = fields.motivo.value === "Outro motivo";
    document.querySelector("#damage-other-wrap").classList.toggle("hidden", !isOther);
    fields.outro_motivo.required = isOther;
    updateButtons();
  });
  const allowedPhotoTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]);
  const uploadPhotoFile = async (file) => {
    const extensionOk = /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
    const mimeOk = allowedPhotoTypes.has(file.type) || (file.type === "" && extensionOk);
    if (!mimeOk || !extensionOk) {
      throw new Error(`Formato inválido em ${file.name}. Use JPG, PNG, WEBP, HEIC ou HEIF.`);
    }
    if (file.size > 8 * 1024 * 1024) {
      throw new Error(`${file.name} ultrapassa 8 MB.`);
    }
    const payload = new FormData();
    payload.append("draftId", uploadDraftId);
    payload.append("itemTempId", currentItemTempId);
    payload.append("foto", file, file.name);
    const response = await fetch("/api/pdv/avarias/fotos/temp", {
      method: "POST",
      credentials: "include",
      body: payload
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || "Não foi possível anexar a foto.");
    return (data.photos || []).map((photo) => ({
      ...photo,
      name: photo.original_name || file.name,
      type: photo.mime_type || file.type,
      size: photo.size_bytes || file.size
    }));
  };
  const processPhotoFiles = async (fileList) => {
    const files = [...(fileList || [])].slice(0, Math.max(0, 12 - currentPhotos.length));
    if (!files.length) {
      toast("Limite de 12 fotos por produto atingido.", "error");
      return;
    }
    try {
      if (feedback) feedback.textContent = "Processando foto...";
      const uploadedGroups = await Promise.all(files.map(uploadPhotoFile));
      const newPhotos = uploadedGroups.flat();
      syncPhotos([...currentPhotos, ...newPhotos]);
      toast("Foto anexada com sucesso.");
      updateButtons();
    } catch (error) {
      toast(error.message || "Não foi possível anexar a foto.", "error");
    } finally {
      if (feedback) feedback.textContent = "";
    }
  };
  photoInput.addEventListener("change", async (event) => {
    await processPhotoFiles(event.target.files);
    event.target.value = "";
  });
  ["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  }));
  dropzone.addEventListener("drop", async (event) => {
    await processPhotoFiles(event.dataTransfer?.files);
  });
  photoList.addEventListener("click", (event) => {
    const remove = event.target.closest(".remove-damage-photo");
    if (remove) {
      syncPhotos(currentPhotos.filter((_, index) => index !== Number(remove.dataset.index || 0)));
      updateButtons();
      return;
    }
    const preview = event.target.closest(".preview-damage-photo");
    if (preview) openDamagePhotoViewer(currentPhotos, Number(preview.dataset.index || 0), productSearch.value || "Produto anexado");
  });
  Object.values(fields).forEach((field) => field?.addEventListener?.("input", updateButtons));
  Object.values(fields).forEach((field) => field?.addEventListener?.("change", updateButtons));
  observationField.addEventListener("input", updateButtons);
  addButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (adding) return;
    validationTouched = true;
    const result = validateItem({ showErrors: true });
    if (!result.valid) {
      const missing = Object.keys(result.errors).map((key) => errorLabels[key] || key);
      feedback.textContent = `Preencha: ${missing.join(", ")}.`;
      feedback.className = "text-sm text-red-700";
      return;
    }
    const externalDuplicate = findActiveDuplicateReturn(result.item);
    if (externalDuplicate) {
      feedback.textContent = duplicateReturnMessage(externalDuplicate);
      feedback.className = "text-sm text-red-700";
      toast("Já existe uma solicitação ativa para este produto.", "error");
      return;
    }
    adding = true;
    addButton.disabled = true;
    addButton.textContent = "Adicionando...";
    const editIndex = document.querySelector("#damage-edit-index").value;
    if (editIndex !== "") {
      damageDraftItems = damageDraftItems.map((item, index) => index === Number(editIndex) ? result.item : item);
    } else {
      const sameIndex = damageDraftItems.findIndex((item) =>
        String(item.sku) === String(result.item.sku)
        && String(item.motivo || "") === String(result.item.motivo || "")
        && String(item.lote || "") === String(result.item.lote || "")
        && String(item.data_validade || item.validade || "") === String(result.item.data_validade || result.item.validade || "")
      );
      const shouldSum = sameIndex >= 0 ? await confirmSystem({
        title: "Produto já adicionado",
        message: "Este produto já foi adicionado com os mesmos dados. Deseja somar a quantidade?",
        consequence: "As fotos novas serão mantidas junto ao item existente.",
        confirmLabel: "Somar quantidade"
      }) : false;
      if (sameIndex >= 0 && shouldSum) {
        damageDraftItems = damageDraftItems.map((item, index) => index === sameIndex
          ? { ...item, quantidade: Number(item.quantidade || 0) + Number(result.item.quantidade || 0), fotos: [...(item.fotos || []), ...(result.item.fotos || [])] }
          : item);
      } else if (sameIndex >= 0) {
        feedback.textContent = "Este produto já foi adicionado nesta devolução.";
        feedback.className = "text-sm text-red-700";
        adding = false;
        addButton.textContent = "+ Adicionar produto à devolução";
        updateButtons();
        return;
      } else {
        damageDraftItems = [...damageDraftItems, result.item];
      }
    }
    renderDamageDraftItems();
    clearItemForm();
    feedback.textContent = "Produto adicionado à devolução.";
    feedback.className = "text-sm text-slate-500";
    adding = false;
    updateButtons();
  });
  if (window.__damageDraftEditHandler) {
    document.removeEventListener("damage-draft-edit-requested", window.__damageDraftEditHandler);
  }
  window.__damageDraftEditHandler = (event) => {
    const index = Number(event.detail?.index);
    const item = damageDraftItems[index];
    if (!item) return;
    const product = productBySku(item.sku) || null;
    selectedProduct = product;
    productSearch.value = item.label || (product ? labelForProduct(product) : item.produto || item.sku);
    productSku.value = item.sku || "";
    productSearch.dataset.selectedSku = item.sku || "";
    fields.quantidade.value = item.quantidade || 1;
    fields.unidade_medida.value = item.unidade_medida || "UN";
    fields.motivo.value = item.motivo || "";
    fields.outro_motivo.value = item.outro_motivo || "";
    document.querySelector("#damage-other-wrap").classList.toggle("hidden", fields.motivo.value !== "Outro motivo");
    fields.data_identificacao.value = item.data_identificacao || todayValue;
    fields.lote.value = item.lote || "";
    fields.data_validade.value = item.data_validade || "";
    observationField.value = item.observacao || "";
    syncPhotos(item.fotos || []);
    document.querySelector("#damage-edit-index").value = String(index);
    addButton.textContent = "+ Salvar item";
    validationTouched = true;
    updateButtons();
  };
  document.addEventListener("damage-draft-edit-requested", window.__damageDraftEditHandler);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) return;
    const responsible = fields.usuario_solicitante.value.trim();
    if (!responsible) {
      setFieldError("usuario_solicitante", "Obrigatório");
      toast("Informe a pessoa responsável pelo PDV.", "error");
      return;
    }
    if (!damageDraftItems.length) {
      toast("Adicione pelo menos um produto válido antes de enviar.", "error");
      return;
    }
    const invalidItem = damageDraftItems.find((item) => !item.sku || !Number(item.quantidade || 0) || !(item.fotos || []).length || !item.motivo || !item.data_identificacao);
    if (invalidItem) {
      toast(`Revise o produto ${invalidItem.produto || invalidItem.sku}. Há dados obrigatórios pendentes.`, "error");
      return;
    }
    const shouldSend = await confirmSystem({
      title: "Enviar devolução",
      message: `Enviar devolução com ${damageDraftItems.length} produto(s) ao almoxarifado?`,
      consequence: "Após o envio, os produtos devem ser entregues ao almoxarifado para conferência.",
      confirmLabel: "Enviar devolução"
    });
    if (!shouldSend) return;
    sending = true;
    sendButton.disabled = true;
    sendButton.textContent = "Enviando devolução...";
    try {
      const duplicatedBeforeSend = damageDraftItems.map((item) => findActiveDuplicateReturn(item)).find(Boolean);
      if (duplicatedBeforeSend) {
        toast(duplicateReturnMessage(duplicatedBeforeSend), "error");
        return;
      }
      const produtos = damageDraftItems.map((item) => ({
        produtoId: item.produtoId || item.produto_id || item.sku,
        sku: item.sku,
        quantidade: item.quantidade,
        unidadeMedida: item.unidadeMedida || item.unidade_medida || "UN",
        unidade_medida: item.unidadeMedida || item.unidade_medida || "UN",
        motivo: item.motivo,
        outro_motivo: item.outro_motivo || "",
        dataIdentificacao: item.dataIdentificacao || item.data_identificacao,
        data_identificacao: item.dataIdentificacao || item.data_identificacao,
        lote: item.lote || "",
        validade: item.validade || item.data_validade || "",
        data_validade: item.validade || item.data_validade || "",
        observacao: item.observacao || "",
        foto_ids: item.foto_ids || item.photoIds || (item.fotos || []).map((photo) => Number(photo?.id || 0)).filter(Boolean),
        photoIds: item.photoIds || item.foto_ids || (item.fotos || []).map((photo) => Number(photo?.id || 0)).filter(Boolean),
        fotos: (item.fotos || []).map((photo) => typeof photo === "string" ? photo : photo.data).filter(Boolean)
      }));
      const idempotencyKey = buttonIdempotencyKey(sendButton);
      await request("/api/pdv/avarias", idempotentRequestOptions({
          pontoId: state.user?.pdvId || state.user?.pdv_id || null,
          usuario_solicitante: responsible,
          responsavelId: state.user?.id || null,
          produtos,
          items: produtos
        }, idempotencyKey));
      clearButtonIdempotencyKey(sendButton);
      damageDraftItems = [];
      localStorage.removeItem(draftKey);
      toast("Devolução enviada. Entregue os produtos ao almoxarifado para conferência.");
      await viewDamageReturn();
    } catch (error) {
      saveDraft();
      if (error.code === "DUPLICATE_ACTIVE_RETURN" && error.details?.existingRequest) {
        const existing = error.details.existingRequest;
        toast(`Já existe uma solicitação ativa para este produto. Solicitação ${existing.number}, atualmente em ${existing.status}.`, "error");
      } else {
        toast(error.message || "Falha ao enviar a devolução. Seus dados foram preservados.", "error");
      }
    } finally {
      sending = false;
      sendButton.textContent = "Enviar devolução ao almoxarifado";
      updateButtons();
    }
  });
  restoreDraft();
  renderDamageDraftItems();
  updateButtons();
  bindDamageCancelButtons();
  startAutoRefresh("damage-return", async () => {
    const active = document.activeElement;
    if (active && form.contains(active)) return;
    await refreshDamageFollowup();
  }, 10000, { ignoreEditing: true });
};

// Monta o card administrativo de avaria
function damageAdminCard(item) {
  const items = damageItemsArray(item.itens);
  const displayItems = items.length ? items : [item];
  const allItemPhotos = displayItems.flatMap((damageItem) => damagePhotosForItem(damageItem, item, displayItems.length));
  const visibleStatus = normalizeDamageStatusLabel(item.status);
  const needsReceiving = visibleStatus === "Aguardando Produto";
  const needsConference = ["Em Aprovação", "Aprovação Parcial", "Verificação"].includes(visibleStatus);
  const statusOptions = damageNextStatuses(visibleStatus);
  const canDeleteDamage = ["Cancelado", "Aguardando Produto"].includes(visibleStatus);
  const refusedPendingItems = displayItems.filter((damageItem) => Number(damageItem.quantidade_recusada || 0) > 0 && !damageItem.retirada_confirmada);
  const refusedReturnedItems = displayItems.filter((damageItem) => Number(damageItem.quantidade_recusada || 0) > 0 && damageItem.retirada_confirmada);
  return `<article class="card order-accordion damage-card" data-damage-id="${item.id}">
    <button class="order-accordion-head" type="button" data-toggle-order aria-expanded="false">
      <span class="order-arrow">&#9662;</span>
      <span>
        <strong>${esc(item.codigo_devolucao)} - ${esc(item.pdv || "-")}</strong>
        <small>${displayItems.length} produto(s) | ${item.total_quantidade || item.quantidade} unidade(s) | ${moneyDate(item.criado_em)}</small>
      </span>
      <span class="order-head-status">
        ${verifiedBadge(item)}
        ${statusPill(normalizeDamageStatusLabel(item.status))}
        <span class="print-status print-waiting">${esc(item.omie_status || "Integração desativada")}</span>
      </span>
    </button>
    <div class="order-accordion-body hidden">
      <div class="damage-detail-actions no-print">
        <button class="btn secondary view-damage-signature" type="button" data-code="${esc(item.codigo_devolucao)}" data-signature="${esc(item.assinatura_imagem || "")}" data-responsible="${esc(item.responsavel_entrega_nome || "")}" data-date="${esc(item.assinatura_confirmada_em ? moneyDate(item.assinatura_confirmada_em) : "")}" data-pdv="${esc(item.pdv || "")}" data-user="${esc(item.recebido_por_usuario || "")}">Visualizar assinatura</button>
        ${displayItems.length === 1 && allItemPhotos.length ? `<button class="btn secondary view-damage-photos" type="button" data-damage-photos='${esc(JSON.stringify(allItemPhotos))}' data-damage-product="${esc(displayItems[0].produto || displayItems[0].sku_produto || item.codigo_devolucao)}">Visualizar fotos</button>` : ""}
        <button class="btn secondary print-single-damage" type="button" data-damage-id="${item.id}">Imprimir</button>
        ${statusOptions.length ? `<button class="btn secondary open-damage-status-modal" type="button" data-id="${item.id}" data-status="${esc(visibleStatus)}" data-code="${esc(item.codigo_devolucao)}">Alterar status</button>` : ""}
        ${canDeleteDamage ? `<button class="btn danger delete-damage-return" type="button" data-id="${item.id}" data-code="${esc(item.codigo_devolucao)}" data-status="${esc(visibleStatus)}">Excluir devolução</button>` : ""}
      </div>
      <div class="damage-detail-grid">
        <p><strong>Motivo:</strong> ${esc(item.motivo)}${item.outro_motivo ? ` - ${esc(item.outro_motivo)}` : ""}</p>
        <p><strong>Usuário:</strong> ${esc(item.usuario_solicitante || "-")}</p>
        <p><strong>Identificação:</strong> ${moneyDate(item.data_identificacao)}</p>
        <p><strong>Validade:</strong> ${item.data_validade ? moneyDate(item.data_validade) : "-"}</p>
        <p><strong>Fotos:</strong> ${allItemPhotos.length} imagem(ns) vinculada(s) aos produtos</p>
        ${item.responsavel_entrega_nome ? `<p><strong>Entregue por:</strong> ${esc(item.responsavel_entrega_nome)}</p>` : ""}
        ${item.recebido_por_usuario ? `<p><strong>Recebido por:</strong> ${esc(item.recebido_por_usuario)}</p>` : ""}
        ${item.motivo_estorno ? `<p><strong>Motivo do estorno:</strong> ${esc(item.motivo_estorno)}</p>` : ""}
      </div>
      ${!needsConference ? `
        <section class="damage-items-card">
          <p class="eyebrow">Conferência</p>
          ${table(["Código", "Produto", "Solicitado", "Recebido", "Aprovado", "Recusado", "Motivo", "Validade", "Fotos", "Resultado"], displayItems.map((damageItem) => {
            const rowPhotos = damagePhotosForItem(damageItem, item, displayItems.length);
            const productName = damageItem.produto || item.produto || damageItem.sku_produto || item.sku_produto || "-";
            return `
            <tr>
              <td>${esc(damageItem.sku_produto || item.sku_produto || "-")}</td>
              <td>${esc(productName)}</td>
              <td>${damageItem.quantidade || item.quantidade || 0}</td>
              <td>${damageItem.quantidade_recebida || item.quantidade_recebida || 0}</td>
              <td>${damageItem.quantidade_aprovada || item.quantidade_aprovada || 0}</td>
              <td>${damageItem.quantidade_recusada || item.quantidade_recusada || 0}</td>
              <td>${esc(damageItem.motivo || item.motivo || "-")}</td>
              <td>${damageItem.data_validade ? moneyDate(damageItem.data_validade) : item.data_validade ? moneyDate(item.data_validade) : "-"}</td>
              <td>${rowPhotos.length ? `<button class="btn secondary view-damage-photos" type="button" data-damage-photos='${esc(JSON.stringify(rowPhotos))}' data-damage-product="${esc(productName)}">Ver ${rowPhotos.length}</button>` : "Sem foto"}</td>
              <td>${statusPill(itemVisibleStatus(damageItem))}</td>
            </tr>`;
          }))}
        </section>` : ""}
      ${visibleStatus === "Recusado" || refusedPendingItems.length || refusedReturnedItems.length ? `
        <section class="damage-items-card no-print">
          <p class="eyebrow">Retirada pelo ponto</p>
          <h4>${refusedPendingItems.length ? "Produtos recusados aguardando retirada" : "Produtos recusados devolvidos ao ponto"}</h4>
          ${refusedPendingItems.length ? `<p class="text-sm text-slate-500">O responsável do PDV deve assinar a retirada dos produtos recusados no Almoxarifado.</p>` : ""}
          ${refusedPendingItems.map((damageItem) => `
            <form class="damage-withdraw-form" data-damage-withdraw-form="${item.id}-${damageItem.id}">
              <strong>${esc(damageItem.produto || damageItem.sku_produto)}</strong>
              <span>Solicitado: ${damageItem.quantidade || item.quantidade || 0} ${esc(damageItem.unidade_medida || item.unidade_medida || "unidade(s)")}</span>
              <span>Recusado: ${damageItem.quantidade_recusada || 0} ${esc(damageItem.unidade_medida || item.unidade_medida || "unidade(s)")}</span>
              <input name="retirada_responsavel" placeholder="Nome de quem assina a retirada" />
              <button class="btn withdraw-damage-item" type="button" data-id="${item.id}" data-item-id="${damageItem.id}" data-product="${esc(damageItem.produto || damageItem.sku_produto)}" data-requested="${esc(damageItem.quantidade || item.quantidade || 0)}" data-refused="${esc(damageItem.quantidade_recusada || 0)}" data-unit="${esc(damageItem.unidade_medida || item.unidade_medida || "unidade(s)")}">Assinar e retirar</button>
            </form>`).join("")}
          ${!refusedPendingItems.length && refusedReturnedItems.length ? `<p class="text-sm text-slate-500">Todos os produtos recusados já foram devolvidos ao ponto.</p>` : ""}
        </section>` : ""}
      ${item.observacao ? `<p class="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">${esc(item.observacao)}</p>` : ""}
      ${needsReceiving ? `
        <form class="damage-flow-form category-settings" data-damage-flow-form="${item.id}">
          <div>
            <p class="eyebrow">Recebimento físico</p>
            <h4>Recebimento da devolução</h4>
          </div>
          <div class="damage-conference-grid">
            <label>Nome completo do responsável
              <input name="responsavel_entrega_nome" value="${esc(item.responsavel_entrega_nome || "")}" required />
            </label>
            <label>Ponto de origem
              <input value="${esc(item.pdv || "")}" readonly />
            </label>
            <label>Documento ou matrícula
              <input name="responsavel_entrega_documento" value="${esc(item.responsavel_entrega_documento || "")}" placeholder="Quando exigido" />
            </label>
            <label>Cargo ou função
              <input name="responsavel_entrega_cargo" value="${esc(item.responsavel_entrega_cargo || "")}" placeholder="Opcional" />
            </label>
            <label>Data e hora da entrega
              <input name="entrega_em" type="datetime-local" value="${esc(localDateTimeInput(item.entrega_em))}" required />
            </label>
            <label>Quantidade recebida
              <input name="quantidade_recebida" type="number" min="1" value="${item.quantidade_recebida || item.quantidade}" required />
            </label>
          </div>
          <div class="signature-compact-actions">
            <button class="btn secondary open-signature-panel" type="button">Coletar assinatura</button>
            <span class="signature-status">Assinatura opcional. O recebimento pode ser confirmado sem assinatura.</span>
          </div>
          <div class="signature-pad-wrap hidden">
            <div>
              <p class="eyebrow">Assinatura do responsável pelo ponto</p>
              <h4>${esc(item.codigo_devolucao)} - ${esc(item.pdv || "")}</h4>
              <p class="text-sm text-slate-500">Oriente o responsável pelo ponto a assinar na área indicada.</p>
            </div>
            <canvas class="signature-pad" width="720" height="220" data-signature-pad="${item.id}" aria-label="Área para assinatura do responsável pelo ponto"></canvas>
            <input name="assinatura_imagem" type="hidden" />
            <input name="recebido_sessao" type="hidden" value="${esc(navigator.userAgent || "Navegador")}" />
            <div class="signature-actions">
              <button class="btn secondary clear-signature" type="button">Limpar</button>
              <button class="btn secondary cancel-signature" type="button">Cancelar</button>
              <button class="btn confirm-signature" type="button">Confirmar assinatura</button>
            </div>
          </div>
          <div class="order-card-actions no-print">
            <button class="btn damage-flow confirm-receiving" type="button" data-action="receive" data-id="${item.id}">Confirmar recebimento</button>
          </div>
        </form>` : ""}
      ${needsConference ? `
        <form class="damage-flow-form category-settings" data-damage-flow-form="${item.id}">
          <div>
            <p class="eyebrow">Conferência</p>
            <h4>Aprovação da avaria</h4>
          </div>
          <div class="table-wrap">
            <table class="damage-item-conference-table">
              <thead>
                <tr><th>Produto</th><th>Fotos</th><th>Solicitado</th><th>Aprovado</th><th>Recusado</th><th>Justificativa da recusa/parcial</th><th>Observação do item</th></tr>
              </thead>
              <tbody>
                ${displayItems.map((damageItem) => {
                  const rowPhotos = damagePhotosForItem(damageItem, item, displayItems.length);
                  const productName = damageItem.produto || damageItem.sku_produto || "Produto";
                  return `
                  <tr class="damage-conference-item" data-item-id="${damageItem.id || ""}" data-requested="${esc(damageItem.quantidade || 0)}">
                    <td>${esc(productName)}</td>
                    <td>${rowPhotos.length ? `<button class="btn secondary view-damage-photos" type="button" data-damage-photos='${esc(JSON.stringify(rowPhotos))}' data-damage-product="${esc(productName)}">Ver ${rowPhotos.length}</button>` : "Sem foto"}</td>
                    <td>${damageItem.quantidade}</td>
                    <td><input name="quantidade_aprovada_${damageItem.id}" type="number" min="0" max="${damageItem.quantidade}" value="${damageItem.quantidade_aprovada || 0}" /></td>
                    <td><input name="quantidade_recusada_${damageItem.id}" type="number" min="0" max="${damageItem.quantidade}" value="${damageItem.quantidade_recusada || 0}" /></td>
                    <td><input name="motivo_divergencia_${damageItem.id}" value="${esc(damageItem.motivo_divergencia || "")}" placeholder="Obrigatória se recusar ou aprovar parcialmente" /></td>
                    <td><input name="observacao_interna_${damageItem.id}" value="${esc(damageItem.observacao_interna || "")}" placeholder="Opcional" /></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
          <p class="text-sm text-slate-500">Use a justificativa na própria linha do produto quando houver recusa ou aprovação parcial.</p>
          <div class="order-card-actions no-print">
            <button class="btn secondary damage-flow" type="button" data-action="conference" data-id="${item.id}">Salvar conferência</button>
            ${["Em Aprovação", "Aprovação Parcial"].includes(visibleStatus) ? `<button class="btn damage-flow" type="button" data-action="finalize" data-id="${item.id}">Finalizar devolução</button><button class="btn danger damage-flow" type="button" data-action="refuse" data-id="${item.id}">Recusar devolução</button>` : ""}
          </div>
        </form>` : ""}
    </div>
  </article>`;
}

// Monta o HTML de impressão do relatório de avarias
function buildDamagePrintHtml(devolucoes = [], options = {}) {
  const title = options.title || "Relatório de Devoluções de Avarias";
  const generatedAt = moneyDate(new Date().toISOString());
  const generatedBy = state.user?.name || "Usuário do sistema";
  const period = options.from || options.to
    ? `${options.from ? moneyDate(options.from) : "Início"} a ${options.to ? moneyDate(options.to) : "Hoje"}`
    : "Todos os registros filtrados";
  const filters = [
    options.pdvLabel ? `Ponto: ${options.pdvLabel}` : "",
    options.status ? `Status: ${options.status}` : ""
  ].filter(Boolean).join(" | ");
  const summaryEvents = (item) => [
    item.criado_em ? `Criação: ${moneyDate(item.criado_em)}` : "",
    item.recebido_em ? `Recebimento: ${moneyDate(item.recebido_em)}` : "",
    item.finalizado_em ? `Conclusão: ${moneyDate(item.finalizado_em)}` : "",
    item.cancelado_em ? `Cancelamento: ${moneyDate(item.cancelado_em)}` : "",
    item.verificado ? "Verificação: registro editado" : "",
    item.omie_status ? `Integração externa: ${item.omie_status}` : ""
  ].filter(Boolean);
  const productRows = (item) => {
    const items = damageItemsArray(item.itens);
    const exportItems = items.length ? items : [item];
    return exportItems.map((damageItem) => {
      const rowPhotos = damagePhotosForItem(damageItem, item, exportItems.length);
      return `
      <tr>
        <td>${esc(damageItem.produto || item.produto || damageItem.sku_produto || item.sku_produto || "-")}</td>
        <td class="num">${damageItem.quantidade || item.quantidade || 0}</td>
        <td class="num">${damageItem.quantidade_recebida || item.quantidade_recebida || 0}</td>
        <td class="num">${damageItem.quantidade_aprovada || item.quantidade_aprovada || 0}</td>
        <td class="num">${damageItem.quantidade_recusada || item.quantidade_recusada || 0}</td>
        <td>${esc(damageItem.motivo || item.motivo || "-")}</td>
        <td>${esc(damageItem.lote || item.lote || "-")}</td>
        <td>${damageItem.data_validade ? moneyDate(damageItem.data_validade) : item.data_validade ? moneyDate(item.data_validade) : "-"}</td>
        <td>${rowPhotos.length ? rowPhotos.map((photo, index) => `<img class="print-photo" src="${esc(photo)}" alt="Foto ${index + 1}" />`).join("") : "-"}</td>
        <td>${esc(itemVisibleStatus(damageItem))}</td>
        <td>${esc(item.omie_status || "Integração desativada")}</td>
      </tr>`;
    }).join("");
  };
  const signatureHtml = (item) => {
    const items = damageItemsArray(item.itens);
    const withdrawalSignatureItem = items.find((damageItem) => damageItem.retirada_assinatura);
    const image = item.assinatura_imagem || withdrawalSignatureItem?.retirada_assinatura || "";
    const responsible = item.assinatura_imagem
      ? item.responsavel_entrega_nome
      : withdrawalSignatureItem?.retirada_responsavel;
    const date = item.assinatura_imagem
      ? item.assinatura_confirmada_em
      : withdrawalSignatureItem?.retirada_em;
    return `
      <section class="signature-block">
        <h3>Assinatura do responsável</h3>
        ${image ? `
          <p>${esc(responsible || "-")} | ${esc(item.pdv || "-")} | ${date ? moneyDate(date) : "-"}</p>
          <img src="${esc(image)}" alt="Assinatura do responsável" />
        ` : `<p class="muted">Assinatura não registrada</p>`}
      </section>`;
  };
  const cards = devolucoes.map((item) => {
    const status = normalizeDamageStatusLabel(item.status);
    const events = summaryEvents(item);
    return `
      <article class="return-card">
        <div class="return-card-head">
          <div>
            <h2>Devolução ${esc(item.codigo_devolucao)} — ${esc(item.pdv || "-")}</h2>
            <p>${esc(item.usuario_solicitante || "-")} | Solicitada em ${item.criado_em ? moneyDate(item.criado_em) : "-"}</p>
            <p>Conclusão: ${item.finalizado_em ? moneyDate(item.finalizado_em) : "-"}</p>
          </div>
          <div class="status-box">
            <strong>${esc(status)}</strong>
            ${item.verificado ? `<span>Editado</span>` : ""}
          </div>
        </div>
        ${item.observacao ? `<p class="note"><strong>Observação:</strong> ${esc(item.observacao)}</p>` : ""}
        <table class="products-table">
          <thead>
            <tr><th>Produto</th><th>Solicitado</th><th>Recebido</th><th>Aprovado</th><th>Recusado</th><th>Motivo</th><th>Lote</th><th>Validade</th><th>Fotos</th><th>Resultado</th><th>Integração externa</th></tr>
          </thead>
          <tbody>${productRows(item) || `<tr><td colspan="11">Nenhum produto encontrado.</td></tr>`}</tbody>
        </table>
        ${signatureHtml(item)}
        <section class="history-block">
          <h3>Histórico resumido</h3>
          <ul>${events.length ? events.map((event) => `<li>${esc(event)}</li>`).join("") : "<li>Nenhum histórico resumido disponível.</li>"}</ul>
        </section>
      </article>`;
  }).join("");
  return `<!doctype html>
    <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <title>${esc(title)}</title>
      <style>
        @page { size: A4 landscape; margin: 9mm; }
        * { box-sizing: border-box; }
        body { margin: 0; background: #fff; color: #102f35; font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; line-height: 1.35; }
        .report-header { display: flex; align-items: center; gap: 14px; padding-bottom: 8px; margin-bottom: 12px; border-bottom: 2px solid #007b87; }
        .report-header img { width: 96px; height: auto; }
        .eyebrow { margin: 0 0 2px; color: #f4760f; font-size: 9px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; }
        h1 { margin: 0; color: #005f68; font-size: 18px; line-height: 1.1; }
        .meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 5px 0 0; color: #3f5962; font-size: 10px; }
        .return-card { break-inside: avoid; page-break-inside: avoid; margin: 0 0 10px; padding: 10px; border: 1px solid #b9dde1; border-radius: 10px; background: #fff; }
        .return-card-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
        .return-card h2 { margin: 0 0 3px; color: #005f68; font-size: 14px; line-height: 1.2; }
        .return-card p { margin: 0 0 2px; }
        .status-box { min-width: 108px; text-align: right; color: #005f68; font-size: 10px; }
        .status-box strong { display: inline-block; padding: 4px 8px; border: 1px solid #9ecfd5; border-radius: 999px; background: #eefafa; color: #005f68; }
        .status-box span { display: block; margin-top: 4px; font-weight: 800; color: #8a3d08; }
        .note { margin: 6px 0 8px !important; padding: 6px 8px; border-radius: 8px; background: #fff7ed; color: #5f3514; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td { padding: 5px 5px; border: 1px solid #c9dde0; vertical-align: top; overflow-wrap: anywhere; }
        th { background: #eaf8fa; color: #005f68; font-size: 9px; font-weight: 800; text-transform: uppercase; }
        th:nth-child(1), td:nth-child(1) { width: 22%; }
        th:nth-child(2), td:nth-child(2),
        th:nth-child(3), td:nth-child(3),
        th:nth-child(4), td:nth-child(4),
        th:nth-child(5), td:nth-child(5) { width: 6%; text-align: center; }
        th:nth-child(6), td:nth-child(6) { width: 11%; }
        th:nth-child(7), td:nth-child(7) { width: 7%; }
        th:nth-child(8), td:nth-child(8) { width: 7%; }
        th:nth-child(9), td:nth-child(9) { width: 10%; }
        th:nth-child(10), td:nth-child(10) { width: 10%; }
        th:nth-child(11), td:nth-child(11) { width: 9%; }
        td.num { text-align: center; font-weight: 700; }
        .print-photo { display: inline-block; width: 34px; height: 34px; margin: 0 3px 3px 0; object-fit: cover; border: 1px solid #c9dde0; border-radius: 5px; }
        thead { display: table-header-group; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        .signature-block, .history-block { break-inside: avoid; margin-top: 8px; padding-top: 7px; border-top: 1px solid #d6e8ea; }
        .signature-block h3, .history-block h3 { margin: 0 0 4px; color: #005f68; font-size: 11px; }
        .signature-block img { display: block; max-width: 210px; max-height: 92px; object-fit: contain; border: 1px solid #cbd5d8; background: #fff; }
        .muted { color: #60727a; font-style: italic; }
        .history-block ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px 14px; margin: 0; padding-left: 14px; color: #334b52; }
        .report-footer { position: fixed; right: 0; bottom: 0; left: 0; padding-top: 4px; border-top: 1px solid #d4e4e6; color: #60727a; font-size: 9px; text-align: center; }
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .return-card { box-shadow: none; }
        }
      </style>
    </head>
    <body>
      <header class="report-header">
        <img src="/logo-print.png" alt="Águas Correntes Park" />
        <div>
          <p class="eyebrow">ÁGUAS CORRENTES PARK</p>
          <h1>${esc(title)}</h1>
          <div class="meta">
            <span><strong>Período:</strong> ${esc(period)}</span>
            ${filters ? `<span>${esc(filters)}</span>` : ""}
            <span><strong>Emissão:</strong> ${esc(generatedAt)}</span>
            <span><strong>Usuário:</strong> ${esc(generatedBy)}</span>
          </div>
        </div>
      </header>
      ${cards || `<article class="return-card">Nenhum registro encontrado.</article>`}
      <footer class="report-footer">ACPARK Gestão - ${esc(title)} - ${esc(generatedAt)}</footer>
    </body>
    </html>`;
}

// Dispara a impressão do relatório de avarias
function printDamageReport(devolucoes = [], options = {}) {
  const printWindow = window.open("", "_blank", "width=1024,height=768");
  if (!printWindow) {
    toast("O navegador bloqueou a janela de impressão.", "error");
    return;
  }
  printWindow.document.open();
  printWindow.document.write(buildDamagePrintHtml(devolucoes, options));
  printWindow.document.close();
  const startPrint = () => {
    printWindow.focus();
    printWindow.print();
  };
  const images = [...printWindow.document.images];
  if (!images.length) {
    setTimeout(startPrint, 200);
    return;
  }
  let pending = images.length;
  let printed = false;
  const safeStartPrint = () => {
    if (printed) return;
    printed = true;
    setTimeout(startPrint, 250);
  };
  const done = () => {
    pending -= 1;
    if (pending <= 0) safeStartPrint();
  };
  images.forEach((image) => {
    if (image.complete) done();
    else {
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
    }
  });
  setTimeout(safeStartPrint, 2500);
}

// View administrativa de avarias
async function viewDamagesAdmin(filters = {}) {
  const isDamageHistory = Boolean(filters.historyOnly);
  const activeStatus = isDamageHistory
    ? (filters.status || document.querySelector("#damage-history-status")?.value || "")
    : (filters.status || document.querySelector("[data-damage-status].is-active")?.dataset.damageStatus || "Aguardando Produto");
  const from = filters.from || "";
  const to = filters.to || "";
  const q = filters.q || "";
  const pdvId = filters.pdvId || "";
  const returnFilter = filters.returnFilter || document.querySelector("#damage-return-filter")?.value || "todos";
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (pdvId) params.set("pdvId", pdvId);
  const data = await request(`/api/admin/avarias?${params.toString()}`, { silentLoading: Boolean(filters.auto) });
  const searched = q
    ? (data.devolucoes || []).filter((item) => `${item.codigo_devolucao} ${item.pdv || ""} ${item.produto || ""} ${damageItemsArray(item.itens).map((damageItem) => `${damageItem.produto || ""} ${damageItem.sku_produto || ""}`).join(" ")}`.toLowerCase().includes(q.toLowerCase()))
    : (data.devolucoes || []);
  const grouped = damageStatuses.reduce((acc, status) => {
    acc[status] = searched.filter((item) => normalizeDamageStatusLabel(item.status) === status || item.status === status);
    return acc;
  }, {});
  const baseVisible = isDamageHistory
    ? searched.filter((item) => {
      const normalized = normalizeDamageStatusLabel(item.status);
      if (!["Finalizado", "Recusado", "Cancelado"].includes(normalized)) return false;
      if (!activeStatus) return true;
      if (activeStatus === "Editado") return Boolean(item.verificado);
      return normalized === activeStatus;
    })
    : grouped[activeStatus] || [];
  const visible = activeStatus === "Recusado" && returnFilter !== "todos"
    ? baseVisible.filter((item) => damageRefusedReturnState(item) === returnFilter)
    : baseVisible;
  const showDamageMetrics = localStorage.getItem("damageMetricsOpen") === "true";
  shell(`
    <section class="release-screen">
      <section class="card history-filter-card">
        <form id="damage-admin-filter" class="filter-panel damage-admin-filter">
          <div class="filter-copy">
            <p class="eyebrow">Avarias</p>
            <h3 class="section-title text-xl font-black">${isDamageHistory ? "Histórico de Devoluções" : "Devoluções de avarias"}</h3>
            <p class="text-sm text-slate-500">${isDamageHistory ? "Consulta de devoluções finalizadas ou recusadas, com impressão e exportação." : "Controle manual de recebimento, assinatura, conferência, fotos e baixa por avaria."}</p>
          </div>
          <label class="field-wide">Pesquisar
            <input name="q" type="search" value="${esc(q)}" placeholder="Número, ponto ou produto" />
          </label>
          <label class="field-select">Ponto
            <select name="pdvId">
              <option value="">Todos os pontos</option>
              ${(state.pdvs || []).map((pdv) => `<option value="${pdv.id}" ${String(pdv.id) === String(pdvId) ? "selected" : ""}>${esc(pdv.nome)}</option>`).join("")}
            </select>
          </label>
          ${isDamageHistory ? `<label class="field-select">Status
            <select name="status" id="damage-history-status">
              <option value="" ${!activeStatus ? "selected" : ""}>Todos</option>
              <option value="Finalizado" ${activeStatus === "Finalizado" ? "selected" : ""}>Finalizado</option>
              <option value="Recusado" ${activeStatus === "Recusado" ? "selected" : ""}>Recusado</option>
              <option value="Cancelado" ${activeStatus === "Cancelado" ? "selected" : ""}>Cancelado</option>
              <option value="Editado" ${activeStatus === "Editado" ? "selected" : ""}>Editado</option>
            </select>
          </label>` : ""}
          <label class="field-date">De
            <input name="from" type="date" value="${esc(from)}" />
          </label>
          <label class="field-date">Até
            <input name="to" type="date" value="${esc(to)}" />
          </label>
          <div class="filter-actions damage-filter-actions">
            <button class="btn" type="submit">Filtrar</button>
            <button class="btn secondary" id="export-damage-report" type="button">Exportar planilha</button>
            <button class="btn secondary" id="print-damage-report" type="button">Imprimir relatório</button>
          </div>
        </form>
      </section>
      ${!isDamageHistory ? `<section class="damage-metrics-panel">
        <button class="btn secondary damage-metrics-toggle" type="button" aria-expanded="${showDamageMetrics ? "true" : "false"}">
          ${showDamageMetrics ? "Ocultar indicadores" : "Mostrar indicadores"}
        </button>
        <div class="damage-metrics-grid ${showDamageMetrics ? "" : "hidden"}" id="damage-metrics-grid">
          ${damageStatuses.map((status) => `<div class="card metric-card"><p class="eyebrow">${esc(status)}</p><b class="section-title text-3xl">${grouped[status]?.length || 0}</b></div>`).join("")}
        </div>
      </section>
      <div class="config-tabs release-tabs" role="tablist" aria-label="Status das devoluções de avarias">
        ${damageStatusTabs(activeStatus, grouped)}
      </div>` : ""}
      ${!isDamageHistory && activeStatus === "Recusado" ? `
        <section class="card filter-panel filter-panel-compact damage-return-filter-card no-print">
          <div class="filter-copy">
            <p class="eyebrow">Filtro</p>
            <h3 class="section-title text-lg font-black">Produtos recusados</h3>
          </div>
          <label class="field-select">Produtos devolvidos ao ponto
            <select id="damage-return-filter" name="returnFilter">
              <option value="todos" ${returnFilter === "todos" ? "selected" : ""}>Todos os recusados</option>
              <option value="aguardando" ${returnFilter === "aguardando" ? "selected" : ""}>Aguardando devolução ao ponto</option>
              <option value="devolvido" ${returnFilter === "devolvido" ? "selected" : ""}>Devolvidos ao ponto</option>
            </select>
          </label>
        </section>` : ""}
      ${!isDamageHistory && activeStatus === "Cancelado" && visible.length ? `
        <section class="card damage-return-filter-card no-print">
          <div>
            <p class="eyebrow">Limpeza</p>
            <h4>Devoluções canceladas</h4>
            <p class="text-sm text-slate-500">Remova todas as devoluções canceladas exibidas nesta aba.</p>
          </div>
          <button class="btn danger clear-cancelled-damages" type="button" data-total="${visible.length}">Limpar todos</button>
        </section>` : ""}
      <section class="grid gap-4 print-damage-area" id="damage-admin-list">
        ${visible.map(damageAdminCard).join("") || `<div class="card">Não há devoluções ${isDamageHistory ? "no histórico" : esc(activeStatus.toLowerCase())} no período.</div>`}
      </section>
    </section>`);

  document.querySelector("#damage-admin-filter").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await viewDamagesAdmin({ ...form, status: activeStatus, returnFilter, historyOnly: isDamageHistory });
  });
  document.querySelector("#damage-return-filter")?.addEventListener("change", async (event) => {
    await viewDamagesAdmin({ from, to, q, pdvId, status: activeStatus, returnFilter: event.currentTarget.value, historyOnly: isDamageHistory });
  });
  document.querySelector(".damage-metrics-toggle")?.addEventListener("click", (event) => {
    const grid = document.querySelector("#damage-metrics-grid");
    const isOpen = grid?.classList.toggle("hidden") === false;
    localStorage.setItem("damageMetricsOpen", String(isOpen));
    event.currentTarget.textContent = isOpen ? "Ocultar indicadores" : "Mostrar indicadores";
    event.currentTarget.setAttribute("aria-expanded", String(isOpen));
  });
  document.querySelectorAll("[data-damage-status]").forEach((button) => button.addEventListener("click", async () => {
    await viewDamagesAdmin({ from, to, q, pdvId, status: button.dataset.damageStatus });
  }));
  document.querySelectorAll(".damage-flow").forEach((button) => button.addEventListener("click", async () => {
    const form = document.querySelector(`[data-damage-flow-form="${CSS.escape(button.dataset.id)}"]`);
    const payload = form ? Object.fromEntries(new FormData(form)) : {};
    const itemRows = form ? [...form.querySelectorAll(".damage-conference-item")] : [];
    if (itemRows.length && ["conference", "refuse", "finalize"].includes(button.dataset.action)) {
      payload.items = itemRows.map((row) => {
        const itemId = row.dataset.itemId;
        return {
          id: itemId,
          quantidade_aprovada: form.querySelector(`[name="quantidade_aprovada_${CSS.escape(itemId)}"]`)?.value || 0,
          quantidade_recusada: form.querySelector(`[name="quantidade_recusada_${CSS.escape(itemId)}"]`)?.value || 0,
          motivo_divergencia: form.querySelector(`[name="motivo_divergencia_${CSS.escape(itemId)}"]`)?.value || "",
          observacao_interna: form.querySelector(`[name="observacao_interna_${CSS.escape(itemId)}"]`)?.value || ""
        };
      });
      for (const row of itemRows) {
        const itemId = row.dataset.itemId;
        const productName = row.querySelector("td")?.textContent?.trim() || "produto";
        const requested = Number(row.dataset.requested || 0);
        const approved = Number(form.querySelector(`[name="quantidade_aprovada_${CSS.escape(itemId)}"]`)?.value || 0);
        const refused = Number(form.querySelector(`[name="quantidade_recusada_${CSS.escape(itemId)}"]`)?.value || 0);
        const reason = form.querySelector(`[name="motivo_divergencia_${CSS.escape(itemId)}"]`)?.value.trim() || "";
        if (approved < 0 || refused < 0 || approved + refused > requested) {
          toast(`Confira as quantidades de ${productName}. Aprovado + recusado não pode passar do solicitado.`, "error");
          return;
        }
        if ((button.dataset.action === "refuse" || refused > 0 || approved < requested) && !reason) {
          toast(`Informe a justificativa na linha de ${productName}.`, "error");
          return;
        }
      }
      const firstReason = payload.items.find((entry) => entry.motivo_divergencia)?.motivo_divergencia || "";
      const firstObservation = payload.items.find((entry) => entry.observacao_interna)?.observacao_interna || "";
      payload.motivo_divergencia = payload.motivo_divergencia || firstReason;
      payload.observacao_interna = payload.observacao_interna || firstObservation;
    }
    payload.id = button.dataset.id;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Processando...";
    try {
      const idempotencyKey = buttonIdempotencyKey(button);
      if (button.dataset.action === "finalize" && itemRows.length) {
        await request("/api/admin/avarias/flow", idempotentRequestOptions({ ...payload, action: "conference" }, `${idempotencyKey}:conference`));
      }
      payload.action = button.dataset.action;
      await request("/api/admin/avarias/flow", idempotentRequestOptions(payload, `${idempotencyKey}:${button.dataset.action || "flow"}`));
      clearButtonIdempotencyKey(button);
      toast("Devolução atualizada.");
      await viewDamagesAdmin({ from, to, q, pdvId, status: activeStatus, returnFilter, historyOnly: isDamageHistory });
    } catch (error) {
      toast(error.message || "Não foi possível atualizar a devolução.", "error");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }));
  document.querySelectorAll(".open-damage-status-modal").forEach((button) => button.addEventListener("click", () => {
    openDamageStatusModal({
      id: button.dataset.id,
      status: button.dataset.status,
      code: button.dataset.code,
      refresh: async (nextStatus) => viewDamagesAdmin({ from, to, q, pdvId, status: nextStatus, returnFilter, historyOnly: isDamageHistory })
    });
  }));
  document.querySelector(".clear-cancelled-damages")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const total = Number(button.dataset.total || 0);
    const confirmed = await confirmSystem({
      title: "Limpar devoluções canceladas",
      message: `Deseja excluir ${total} devolução(ões) cancelada(s)?`,
      consequence: "Essa ação remove os registros cancelados desta aba e não altera devoluções em outros status.",
      confirmLabel: "Limpar todos",
      danger: true
    });
    if (!confirmed) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Limpando...";
    try {
      const result = await request("/api/admin/avarias", {
        method: "DELETE",
        body: JSON.stringify({ all: true, status: "Cancelado" })
      });
      toast(`${result.deleted || 0} devolução(ões) cancelada(s) excluída(s).`);
      await viewDamagesAdmin({ from, to, q, pdvId, status: "Cancelado", returnFilter, historyOnly: isDamageHistory });
    } catch (error) {
      toast(error.message || "Não foi possível limpar as devoluções canceladas.", "error");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  });
  document.querySelectorAll(".delete-damage-return").forEach((button) => button.addEventListener("click", async () => {
    const confirmed = await confirmSystem({
      title: "Excluir devolução",
      message: `Deseja excluir a devolução ${button.dataset.code || ""}?`,
      consequence: "A exclusão remove somente esta devolução. Os demais registros continuam preservados.",
      confirmLabel: "Excluir devolução",
      danger: true
    });
    if (!confirmed) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Excluindo...";
    try {
      await request("/api/admin/avarias", {
        method: "DELETE",
        body: JSON.stringify({ id: button.dataset.id })
      });
      toast("Devolução excluída.");
      await viewDamagesAdmin({ from, to, q, pdvId, status: activeStatus, returnFilter, historyOnly: isDamageHistory });
    } catch (error) {
      toast(error.message || "Não foi possível excluir a devolução.", "error");
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }));
  document.querySelectorAll(".withdraw-damage-item").forEach((button) => button.addEventListener("click", () => {
    const form = document.querySelector(`[data-damage-withdraw-form="${CSS.escape(`${button.dataset.id}-${button.dataset.itemId}`)}"]`);
    const payload = form ? Object.fromEntries(new FormData(form)) : {};
    if (!payload.retirada_responsavel) {
      toast("Informe o responsável pela retirada.", "error");
      return;
    }
    openDamageWithdrawSignature({
      damageId: button.dataset.id,
      itemId: button.dataset.itemId,
      product: button.dataset.product || "Produto recusado",
      requested: button.dataset.requested || "0",
      refused: button.dataset.refused || "0",
      unit: button.dataset.unit || "unidade(s)",
      responsible: payload.retirada_responsavel,
      refresh: async () => viewDamagesAdmin({ from, to, q, pdvId, status: activeStatus, returnFilter, historyOnly: isDamageHistory })
    });
  }));
  document.querySelectorAll(".withdraw-damage-all").forEach((button) => button.addEventListener("click", async () => {
    const form = document.querySelector(`[data-damage-withdraw-all-form="${CSS.escape(button.dataset.id)}"]`);
    const payload = form ? Object.fromEntries(new FormData(form)) : {};
    if (!payload.retirada_responsavel) {
      toast("Informe o responsável pela devolução ao ponto.", "error");
      return;
    }
    const card = button.closest("[data-damage-id]");
    const allItems = [...(card?.querySelectorAll(".withdraw-damage-item") || [])].map((itemButton) => ({
      product: itemButton.dataset.product || "Produto recusado",
      requested: itemButton.dataset.requested || "0",
      refused: itemButton.dataset.refused || "0",
      unit: itemButton.dataset.unit || "unidade(s)"
    }));
    openDamageWithdrawSignature({
      damageId: button.dataset.id,
      product: "Produtos recusados",
      requested: allItems.reduce((sum, entry) => sum + Number(entry.requested || 0), 0),
      refused: allItems.reduce((sum, entry) => sum + Number(entry.refused || 0), 0),
      unit: "unidade(s)",
      responsible: payload.retirada_responsavel,
      items: allItems,
      refresh: async () => viewDamagesAdmin({ from, to, q, pdvId, status: activeStatus, returnFilter, historyOnly: isDamageHistory })
    });
  }));
  document.querySelectorAll(".view-damage-photos").forEach((button) => button.addEventListener("click", () => {
    const photos = JSON.parse(button.dataset.damagePhotos || "[]");
    openDamagePhotoViewer(photos, 0, button.dataset.damageProduct || "Fotos da devolução");
  }));
  document.querySelectorAll(".view-damage-signature").forEach((button) => button.addEventListener("click", () => {
    openDamageSignatureViewer({
      image: button.dataset.signature,
      code: button.dataset.code,
      responsible: button.dataset.responsible,
      date: button.dataset.date,
      pdv: button.dataset.pdv,
      user: button.dataset.user
    });
  }));
  document.querySelectorAll(".print-single-damage").forEach((button) => button.addEventListener("click", () => {
    const damage = (data.devolucoes || []).find((item) => String(item.id) === String(button.dataset.damageId));
    if (damage) printDamageReport([damage], {
      title: isDamageHistory ? "Histórico de Devoluções" : "Relatório de Devoluções de Avarias",
      from,
      to,
      status: normalizeDamageStatusLabel(damage.status),
      pdvLabel: damage.pdv || ""
    });
  }));
  document.querySelector("#export-damage-report").addEventListener("click", () => {
    const headers = ["Número", "PDV", "Produto", "SKU", "Quantidade solicitada", "Quantidade recebida", "Quantidade aprovada", "Quantidade recusada", "Motivo", "Lote", "Validade", "Status", "Resultado do item", "Data da solicitação", "Data da finalização", "Usuário responsável", "Integração externa", "Editado"];
    const rows = visible.flatMap((item) => {
      const items = damageItemsArray(item.itens);
      const exportItems = items.length ? items : [item];
      return exportItems.map((damageItem) => [
        item.codigo_devolucao,
        item.pdv,
        damageItem.produto || item.produto || damageItem.sku_produto || item.sku_produto,
        damageItem.sku_produto || item.sku_produto,
        damageItem.quantidade || item.quantidade || 0,
        damageItem.quantidade_recebida || item.quantidade_recebida || 0,
        damageItem.quantidade_aprovada || item.quantidade_aprovada || 0,
        damageItem.quantidade_recusada || item.quantidade_recusada || 0,
        damageItem.motivo || item.motivo,
        damageItem.lote || item.lote || "",
        damageItem.data_validade ? moneyDate(damageItem.data_validade) : item.data_validade ? moneyDate(item.data_validade) : "",
        normalizeDamageStatusLabel(item.status),
        itemVisibleStatus(damageItem),
        moneyDate(item.criado_em),
        item.finalizado_em ? moneyDate(item.finalizado_em) : "",
        item.usuario_solicitante || "",
        item.omie_status || "",
        item.verificado ? "Sim" : "Não"
      ]);
    });
    downloadCsv("historico_devolucoes_avarias.csv", [headers, ...rows]);
  });
  document.querySelector("#print-damage-report").addEventListener("click", () => {
    toast("Preparando relatório para impressão...");
    const selectedPdv = state.pdvs.find((pdv) => String(pdv.id) === String(pdvId));
    const statusOrder = ["Aguardando Produto", "Em Aprovação", "Aprovação Parcial", "Aguardando Retirada", "Verificação", "Finalizado", "Recusado", "Cancelado"];
    const printItems = isDamageHistory
      ? visible
      : [...searched].sort((left, right) => {
        const statusDiff = statusOrder.indexOf(normalizeDamageStatusLabel(left.status)) - statusOrder.indexOf(normalizeDamageStatusLabel(right.status));
        if (statusDiff) return statusDiff;
        const dateDiff = new Date(left.criado_em || 0).getTime() - new Date(right.criado_em || 0).getTime();
        if (dateDiff) return dateDiff;
        return String(left.codigo_devolucao || "").localeCompare(String(right.codigo_devolucao || ""));
      });
    printDamageReport(printItems, {
      title: isDamageHistory ? "Histórico de Devoluções" : "Relatório de Devoluções de Avarias",
      from,
      to,
      status: activeStatus || "Todos",
      pdvLabel: selectedPdv?.nome || ""
    });
  });
  bindOrderToggles();
  bindDamageSignatures();
  bindDamagePhotoViewer();
  if (!isDamageHistory) {
    startAutoRefresh("damages", async () => {
      if (document.querySelector(".damage-card .order-accordion-head[aria-expanded='true']")) return;
      await viewDamagesAdmin({ from, to, q, pdvId, status: activeStatus, returnFilter, historyOnly: false, auto: true });
    }, 9000);
  }
}

// View de histórico de avarias
async function viewDamageHistory(filters = {}) {
  await viewDamagesAdmin({ ...filters, historyOnly: true });
}

// Liga o visualizador de fotos de avaria aos elementos da tela
function bindDamagePhotoViewer(root = document) {
  root.querySelectorAll(".damage-thumb").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const photos = JSON.parse(button.dataset.damagePhotos || "[]");
      const product = button.dataset.damageProduct || "Produto";
      openDamagePhotoViewer(photos, Number(button.dataset.damagePhotoIndex || 0), product);
    });
  });
}

// Abre o visualizador de fotos de avaria em tela cheia
function openDamagePhotoViewer(photos, initialIndex, product) {
  photos = (photos || []).map((photo) => typeof photo === "string" ? photo : (photo?.url || photo?.thumbnail_url || photo?.data || "")).filter(Boolean);
  if (!photos.length) return;
  let index = Math.max(0, Math.min(initialIndex, photos.length - 1));
  const modal = document.createElement("div");
  modal.className = "photo-viewer";
  const render = () => {
    modal.innerHTML = `
      <div class="photo-viewer-dialog" role="dialog" aria-modal="true" aria-label="Visualizador de fotos">
        <div class="photo-viewer-head">
          <div>
            <p class="eyebrow">${esc(product)}</p>
            <h3>${index + 1} de ${photos.length} foto(s)</h3>
          </div>
          <button class="icon-action close-photo-viewer" type="button" aria-label="Fechar">&times;</button>
        </div>
        <div class="photo-viewer-body">
          <button class="icon-action prev-photo" type="button" aria-label="Foto anterior">&#8249;</button>
          <img src="${esc(photos[index])}" alt="Foto ${index + 1} de ${esc(product)}" />
          <button class="icon-action next-photo" type="button" aria-label="Próxima foto">&#8250;</button>
        </div>
        <div class="photo-viewer-actions">
          <button class="btn secondary zoom-out-photo" type="button">Reduzir</button>
          <button class="btn secondary zoom-in-photo" type="button">Ampliar</button>
        </div>
      </div>`;
    const image = modal.querySelector("img");
    let scale = 1;
    modal.querySelector(".close-photo-viewer").addEventListener("click", close);
    modal.querySelector(".prev-photo").addEventListener("click", () => { index = (index - 1 + photos.length) % photos.length; render(); });
    modal.querySelector(".next-photo").addEventListener("click", () => { index = (index + 1) % photos.length; render(); });
    modal.querySelector(".zoom-in-photo").addEventListener("click", () => {
      scale = Math.min(scale + 0.25, 3);
      image.style.transform = `scale(${scale})`;
    });
    modal.querySelector(".zoom-out-photo").addEventListener("click", () => {
      scale = Math.max(scale - 0.25, 0.5);
      image.style.transform = `scale(${scale})`;
    });
  };
  const close = () => {
    document.removeEventListener("keydown", keyHandler);
    modal.remove();
  };
  const keyHandler = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowLeft") { index = (index - 1 + photos.length) % photos.length; render(); }
    if (event.key === "ArrowRight") { index = (index + 1) % photos.length; render(); }
  };
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", keyHandler);
  render();
  document.body.appendChild(modal);
}

// Liga os eventos de assinatura de avaria
function bindDamageSignatures(root = document) {
  root.querySelectorAll(".signature-pad").forEach((canvas) => {
    if (canvas.dataset.bound === "true") return;
    canvas.dataset.bound = "true";
    const form = canvas.closest("form");
    const ctx = canvas.getContext("2d");
    const hidden = form?.querySelector('input[name="assinatura_imagem"]');
    const confirmButton = form?.querySelector(".confirm-signature");
    const receiveButton = form?.querySelector(".confirm-receiving");
    const status = form?.querySelector(".signature-status");
    const panel = form?.querySelector(".signature-pad-wrap");
    let drawing = false;
    let hasInk = false;
    let signatureConfirmed = false;

    const clear = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#005f68";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      hasInk = false;
      signatureConfirmed = false;
      if (hidden) hidden.value = "";
      if (status) status.textContent = "Aguardando assinatura do responsável pelo ponto.";
      validate();
    };
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      const source = event.touches?.[0] || event;
      return {
        x: ((source.clientX - rect.left) / rect.width) * canvas.width,
        y: ((source.clientY - rect.top) / rect.height) * canvas.height
      };
    };
    const start = (event) => {
      event.preventDefault();
      drawing = true;
      const p = point(event);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    };
    const move = (event) => {
      if (!drawing) return;
      event.preventDefault();
      const p = point(event);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      hasInk = true;
      signatureConfirmed = false;
      if (hidden) hidden.value = "";
      validate();
    };
    const end = () => {
      drawing = false;
    };
    const validate = () => {
      const responsible = String(form?.querySelector('[name="responsavel_entrega_nome"]')?.value || "").trim();
      const deliveredAt = String(form?.querySelector('[name="entrega_em"]')?.value || "").trim();
      const receivedQty = Number(form?.querySelector('[name="quantidade_recebida"]')?.value || 0);
      const ok = responsible && deliveredAt && Number.isFinite(receivedQty) && receivedQty > 0;
      if (receiveButton) receiveButton.disabled = !ok;
    };

    clear();
    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end);
    form?.querySelectorAll("input, textarea").forEach((field) => field.addEventListener("input", validate));
    form?.querySelectorAll(".clear-signature").forEach((button) => button.addEventListener("click", clear));
    form?.querySelector(".open-signature-panel")?.addEventListener("click", () => {
      panel?.classList.remove("hidden");
      setTimeout(() => canvas.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    });
    form?.querySelector(".cancel-signature")?.addEventListener("click", () => {
      panel?.classList.add("hidden");
    });
    confirmButton?.addEventListener("click", () => {
      if (!hasInk) {
        toast("Assine no campo antes de confirmar.", "error");
        return;
      }
      if (hidden) hidden.value = canvas.toDataURL("image/png");
      signatureConfirmed = true;
      if (status) status.textContent = "Assinatura confirmada e vinculada a esta devolução.";
      form?.querySelector(".open-signature-panel") && (form.querySelector(".open-signature-panel").textContent = "Visualizar assinatura");
      panel?.classList.add("hidden");
      toast("Assinatura coletada com sucesso.");
      validate();
    });
  });
}

// Abre o modal de assinatura de retirada de avaria
function openDamageWithdrawSignature({ damageId, itemId, product, requested, refused, unit, responsible, items = [], refresh }) {
  const rows = items.length ? items : [{ product, requested, refused, unit }];
  const modal = document.createElement("div");
  modal.className = "damage-status-modal";
  modal.innerHTML = `
    <div class="damage-status-dialog order-withdrawal-dialog" role="dialog" aria-modal="true" aria-label="Assinar retirada de produto recusado">
      <div class="damage-status-dialog-head">
        <div>
          <p class="eyebrow">Retirada pelo ponto</p>
          <h3>Assinar e retirar produto recusado</h3>
          <p>O responsável pelo PDV deve assinar novamente no dispositivo do Almoxarifado.</p>
        </div>
        <button class="icon-action close-damage-withdrawal" type="button" aria-label="Fechar">&times;</button>
      </div>
      <p class="damage-status-warning">Declaro que recebi o produto recusado abaixo e que ele retornará ao ponto de origem.</p>
      ${table(["Produto", "Quantidade solicitada", "Quantidade recusada"], rows.map((row) => `
        <tr>
          <td>${esc(row.product)}</td>
          <td>${esc(row.requested)} ${esc(row.unit)}</td>
          <td>${esc(row.refused)} ${esc(row.unit)}</td>
        </tr>`))}
      <label>Responsável pela retirada
        <input name="retirada_responsavel" value="${esc(responsible || "")}" placeholder="Nome completo" autocomplete="off" />
      </label>
      <canvas class="signature-pad order-withdrawal-signature" width="720" height="220" aria-label="Área para assinatura do responsável pela retirada do produto recusado"></canvas>
      <input name="retirada_assinatura" type="hidden" />
      <div class="signature-actions">
        <button class="btn secondary clear-damage-withdrawal-signature" type="button">Limpar assinatura</button>
        <button class="btn secondary close-damage-withdrawal" type="button">Cancelar</button>
        <button class="btn confirm-damage-withdrawal" type="button" disabled>Confirmar retirada assinada</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const canvas = modal.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const hidden = modal.querySelector("[name='retirada_assinatura']");
  const responsibleInput = modal.querySelector("[name='retirada_responsavel']");
  const confirmButton = modal.querySelector(".confirm-damage-withdrawal");
  let drawing = false;

  const close = () => modal.remove();
  const updateConfirm = () => {
    confirmButton.disabled = !(responsibleInput.value.trim() && hidden.value.length > 1200);
  };
  const prepareSignatureContext = () => {
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#063f48";
  };
  const clearSignatureCanvas = () => {
    drawing = false;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    prepareSignatureContext();
    ctx.beginPath();
    hidden.value = "";
    updateConfirm();
  };
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, Math.floor(rect.width * ratio));
    canvas.height = Math.max(160, Math.floor(rect.height * ratio));
    clearSignatureCanvas();
  };
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    const source = event.touches?.[0] || event;
    return { x: source.clientX - rect.left, y: source.clientY - rect.top };
  };
  const start = (event) => {
    drawing = true;
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    event.preventDefault();
  };
  const move = (event) => {
    if (!drawing) return;
    const p = point(event);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hidden.value = canvas.toDataURL("image/png");
    updateConfirm();
    event.preventDefault();
  };
  const stop = () => {
    if (!drawing) return;
    drawing = false;
    hidden.value = canvas.toDataURL("image/png");
    updateConfirm();
  };

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", stop);
  requestAnimationFrame(resize);
  responsibleInput.addEventListener("input", updateConfirm);
  modal.querySelector(".clear-damage-withdrawal-signature").addEventListener("click", () => {
    clearSignatureCanvas();
  });
  modal.querySelectorAll(".close-damage-withdrawal").forEach((button) => button.addEventListener("click", close));
  confirmButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    confirmButton.textContent = "Confirmando...";
    try {
      const idempotencyKey = buttonIdempotencyKey(confirmButton);
      await request("/api/admin/avarias/flow", idempotentRequestOptions({
          id: damageId,
          itemId,
          action: itemId ? "withdraw_refused" : "withdraw_refused_all",
          retirada_responsavel: responsibleInput.value,
          retirada_assinatura: hidden.value
        }, idempotencyKey));
      clearButtonIdempotencyKey(confirmButton);
      toast("Retirada assinada e confirmada.");
      close();
      await refresh?.();
    } catch (error) {
      toast(error.message || "Falha ao confirmar retirada assinada.", "error");
      confirmButton.disabled = false;
      confirmButton.textContent = "Confirmar retirada assinada";
    }
  });
}

// Filtros do assistente de fator. Ficam fora da view porque `recarregar()` redesenha a tela
// inteira: guardados dentro, a fila e a busca voltariam ao padrão a cada confirmação.
const filtroEvidencia = { fila: "FATOR", situacao: "", busca: "" };

// View da Central de Integrações.
//
// A tela não conhece nenhuma API específica: tudo que ela desenha vem do catálogo de
// providers devolvido por /api/admin/integrations/providers — credenciais, operações,
// intervalos e prioridades. Ligar uma API nova no backend faz ela aparecer aqui sozinha,
// sem alterar este arquivo.
async function viewIntegrations(filters = {}) {
  const status = filters.status || "";
  const capacidade = filters.capacidade || "";
  const integrationId = filters.integrationId || "";

  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (capacidade) params.set("capacidade", capacidade);
  if (integrationId) params.set("integrationId", integrationId);

  const [
    catalogo,
    integrationsData,
    jobsData,
    pdvsData,
    locationsData,
    mappingsData,
    divergencesData,
    healthData,
    launchesData,
    fatoresData
  ] = await Promise.all([
    request("/api/admin/integrations/providers"),
    request("/api/admin/integrations"),
    request(`/api/admin/integrations/jobs?${params}`),
    request("/api/admin/pdvs"),
    request("/api/admin/integrations/locations").catch(() => ({ locations: [] })),
    request("/api/admin/integrations/location-mappings").catch(() => ({ mappings: [] })),
    request("/api/admin/integrations/reconciliations").catch(() => ({ divergences: [] })),
    request("/api/admin/integrations/health").catch(() => ({ sync_state: [] })),
    request("/api/admin/integrations/launches").catch(() => ({ launches: [], resumo: [] })),
    request("/api/admin/integrations/fatores").catch(() => ({ pendencias: [], resumo: [] }))
  ]);

  const providers = catalogo.providers || [];
  const integrations = integrationsData.integrations || [];
  const jobs = jobsData.jobs || [];
  const pdvs = pdvsData.pdvs || [];
  const locations = locationsData.locations || [];
  const mappings = mappingsData.mappings || [];
  const divergences = divergencesData.divergences || [];
  const syncState = healthData.sync_state || [];
  const launches = launchesData.launches || [];
  const resumoLancamentos = launchesData.resumo || [];
  const pendenciasFator = fatoresData.pendencias || [];
  const resumoFatores = fatoresData.resumo || [];

  // O assistente de fator depende de saber qual integração, então carrega depois do Promise.all
  const integracaoAtiva = integrations[0];
  const paramsEvidencia = new URLSearchParams({ fila: filtroEvidencia.fila });
  if (integracaoAtiva) paramsEvidencia.set("id", integracaoAtiva.id);
  if (filtroEvidencia.situacao) paramsEvidencia.set("situacao", filtroEvidencia.situacao);
  const evidenciaData = integracaoAtiva
    ? await request(`/api/admin/integrations/fator-evidencia?${paramsEvidencia}`).catch(() => ({
        sugestoes: [],
        resumo: {}
      }))
    : { sugestoes: [], resumo: {} };
  const resumoEvidencia = evidenciaData.resumo || {};

  // Planilha de controle de fardos: fonte de corroboracao, com sua propria fila de vinculo
  const planilhaData = integracaoAtiva
    ? await request(`/api/admin/integrations/fator-planilha?id=${integracaoAtiva.id}`).catch(() => ({
        linhas: [],
        pendencias: []
      }))
    : { linhas: [], pendencias: [] };
  const linhasPlanilha = planilhaData.linhas || [];
  const pendenciasVinculo = planilhaData.pendencias || [];

  // Busca por texto acontece na tela: a lista já vem limitada e filtrar aqui evita ida ao servidor
  const termoBusca = String(filtroEvidencia.busca || "").trim().toUpperCase();
  const sugestoesEvidencia = (evidenciaData.sugestoes || []).filter((item) => {
    if (!termoBusca) return true;
    const alvo = [item.sku, item.nome, item.opcoes?.[0]?.documento?.fornecedor, item.opcoes?.[0]?.documento?.descricao]
      .filter(Boolean)
      .join(" ")
      .toUpperCase();
    return alvo.includes(termoBusca);
  });

  // Rótulo curto de cada classificação, para a tela falar a língua de quem confere
  const rotuloSituacao = {
    SUGERIDO: "Fator sugerido",
    CONFLITO_EMBALAGEM: "Conflito de embalagem",
    CADASTRO_GENERICO: "Cadastro genérico",
    SO_AVULSO: "Só compra avulsa",
    SEM_EVIDENCIA: "Sem evidência"
  };
  const rotuloConfianca = {
    MAXIMA: "Confiança máxima",
    ALTA: "Confiança alta",
    MEDIA: "Confiança média",
    UNICA: "Evidência única"
  };

  // Mostra de qual fonte veio cada número — é isso que sustenta a conferência
  const linhaFontes = (fontes) => {
    if (!fontes) return "";
    const partes = [];
    if (fontes.notas) partes.push(`<span class="fonte-notas">Notas: ×${esc(fontes.notas.fator)} (${esc(fontes.notas.vezes)})</span>`);
    if (fontes.planilha) {
      partes.push(
        fontes.planilha.divergente
          ? `<span class="fonte-planilha divergente">Planilha "${esc(fontes.planilha.nome_operacao)}": abas discordam</span>`
          : `<span class="fonte-planilha">Planilha "${esc(fontes.planilha.nome_operacao)}": ×${esc(fontes.planilha.fator)}</span>`
      );
    }
    if (fontes.descricao) partes.push(`<span class="fonte-descricao">Descrição: ×${esc(fontes.descricao.fator)} ("${esc(fontes.descricao.trecho)}")</span>`);
    return partes.length ? `<div class="assistente-fontes">${partes.join("")}</div>` : "";
  };

  // Uma linha de evidência: a nota que sustenta aquele fator
  const linhaEvidencia = (opcao) => {
    const doc = opcao.documento || {};
    const de = `${doc.quantidade_documento ?? "?"} ${doc.unidade_documento || ""}`.trim();
    const para = `${doc.quantidade_estoque ?? "?"} ${doc.unidade_estoque || ""}`.trim();
    return `
      <li>
        <strong>×${esc(opcao.fator)}</strong>
        <span class="evidencia-notas">${esc(opcao.vezes)} nota(s)</span>
        <span class="evidencia-doc">${esc(de)} → ${esc(para)}</span>
        ${doc.nota ? `<span class="evidencia-nf">NF ${esc(doc.nota)} · ${esc(doc.emissao || "")}</span>` : ""}
        ${doc.fornecedor ? `<span class="evidencia-forn">${esc(doc.fornecedor)}</span>` : ""}
        ${doc.unidade_suspeita ? `<span class="evidencia-alerta" title="A nota usa o mesmo rótulo de unidade dos dois lados. A razão vale, o rótulo não.">rótulo de unidade duvidoso</span>` : ""}
      </li>`;
  };

  // Cartão de um produto na fila de conferência
  const cartaoSugestao = (item) => {
    const decidido = item.decisao;
    const ehCadastro = item.pendencia_de_cadastro;
    const podeAprovar = item.exigeConfirmacao && !ehCadastro;
    return `
      <article class="assistente-item ${ehCadastro ? "cadastro-generico" : ""}" data-produto="${esc(item.external_product_id)}">
        <header>
          <div>
            <strong>${esc(item.nome || item.sku || "-")}</strong>
            <span class="assistente-sku">SKU ${esc(item.sku || "-")} · id ${esc(item.external_product_id)}</span>
          </div>
          <div class="assistente-tags">
            <span class="tag-situacao">${esc(rotuloSituacao[item.situacao] || item.situacao)}</span>
            ${item.confianca ? `<span class="tag-confianca conf-${esc(item.confianca)}">${esc(rotuloConfianca[item.confianca])}</span>` : ""}
            ${item.pedidos_recentes ? `<span class="tag-demanda">${esc(item.pedidos_recentes)} pedido(s) em 90 dias</span>` : ""}
          </div>
        </header>

        <p class="assistente-motivo">${esc(item.motivo || "")}</p>

        ${linhaFontes(item.fontes)}
        ${item.opcoes?.length ? `<ul class="assistente-evidencias">${item.opcoes.map(linhaEvidencia).join("")}</ul>` : ""}
        ${item.tambemAvulso
          ? `<p class="assistente-nota">Também comprado avulso em ${esc(item.tambemAvulso)} nota(s): a embalagem tem ${esc(item.fator)}, mas o item também entra unitário.</p>`
          : ""}

        <footer>
          <span class="assistente-erp">Fator hoje no ERP: <strong>${esc(item.fator_no_erp ?? "—")}</strong></span>
          ${decidido
            ? `<span class="assistente-decisao ${decidido.status === "ERRO" ? "pendente" : ""}">
                 ${esc(decidido.status)}${decidido.fator ? ` · fator ${esc(decidido.fator)}` : ""}
                 ${decidido.por ? ` · por ${esc(decidido.por)}` : ""}
                 ${decidido.erro ? `<br><small>${esc(decidido.erro)}</small>` : ""}
               </span>`
            : ""}
          ${podeAprovar
            ? `<div class="assistente-botoes">
                 <input type="number" min="1" step="1" class="fator-escolhido" value="${esc(item.fator ?? item.opcoes?.[0]?.fator ?? "")}" aria-label="Fator para ${esc(item.sku || "")}" />
                 <button class="btn aprovar-fator" type="button" data-produto="${esc(item.external_product_id)}" data-sugerido="${esc(item.fator ?? "")}">Confirmar</button>
                 <button class="btn secondary recusar-fator" type="button" data-produto="${esc(item.external_product_id)}">Deixar pendente</button>
               </div>`
            : ""}
        </footer>
      </article>`;
  };

  const providerDe = (integration) => providers.find((item) => item.id === integration.provedor);
  // Só as operações que o operador pode disparar na mão (SALDO_ITEM é agendada pelo sistema)
  const capacidadesManuais = (provider) => (provider?.capacidades || []).filter((item) => item.manual !== false);
  const todasCapacidades = [...new Set(providers.flatMap((provider) => provider.capacidades.map((item) => item.id)))];

  // Estado do cursor de uma operação: quando rodou pela última vez e se deixou erro
  const estadoDe = (integrationId, capacidadeId) => syncState.find(
    (item) => String(item.integration_id) === String(integrationId) && item.scope === capacidadeId
  );

  // Cartão de uma operação dentro do card da integração
  const cartaoCapacidade = (integration, cap) => {
    const estado = estadoDe(integration.id, cap.id);
    const ultimo = estado?.last_success_at ? moneyDate(estado.last_success_at) : "Nunca";
    return `
      <div class="integration-capability ${estado?.last_error ? "has-error" : ""}">
        <div class="integration-capability-head">
          <strong>${esc(cap.rotulo)}</strong>
          <span class="integration-capability-priority">${esc(cap.prioridade)}</span>
        </div>
        <p class="integration-capability-desc">${esc(cap.descricao)}</p>
        <dl class="integration-capability-meta">
          <div><dt>Último sucesso</dt><dd>${esc(ultimo)}</dd></div>
          <div><dt>Automático</dt><dd>${cap.intervalo_padrao_ms ? esc(formatarIntervalo(cap.intervalo_padrao_ms)) : "Sob demanda"}</dd></div>
        </dl>
        ${estado?.last_error ? `<p class="integration-capability-error">${esc(estado.last_error)}</p>` : ""}
        <button class="btn secondary sync-capability" type="button"
                data-id="${integration.id}" data-capacidade="${esc(cap.id)}">Sincronizar</button>
      </div>`;
  };

  shell(`
    <section class="card filter-panel">
      <div class="filter-copy">
        <p class="eyebrow">Integrações</p>
        <h3 class="section-title text-xl font-black">Central de APIs e integrações</h3>
        <p class="text-sm text-slate-500">Cada integração declara as próprias credenciais e operações. As leituras trazem dados da API externa para o MyEstoque; nenhuma operação desta tela escreve no sistema externo.</p>
      </div>
      <div class="filter-actions">
        <button class="btn" id="add-integration" type="button">+ Adicionar integração</button>
      </div>
    </section>

    <section class="integration-card-grid">
      ${integrations.map((integration) => {
        const provider = providerDe(integration);
        const capacidades = capacidadesManuais(provider);
        const faltando = (integration.credenciais || []).filter((item) => item.obrigatoria && !item.configurada);
        return `
        <article class="card integration-card">
          <div class="integration-card-head">
            <div>
              <p class="eyebrow">${esc(provider?.rotulo || integration.provedor)}</p>
              <h3>${esc(integration.nome)}</h3>
            </div>
            ${statusPill(integration.status || "PENDENTE")}
          </div>

          ${!integration.provider_registrado
            ? `<p class="integration-alert">Este provedor não existe mais no sistema. A integração fica parada até ser reconfigurada.</p>`
            : ""}
          ${faltando.length
            ? `<p class="integration-alert">Falta configurar: ${esc(faltando.map((item) => item.rotulo).join(", "))}.</p>`
            : ""}

          <div class="integration-meta-grid">
            <span>Ambiente</span><strong>${esc(integration.ambiente || "-")}</strong>
            <span>URL base</span><strong>${esc(integration.url_base || "-")}</strong>
            <span>Empresa</span><strong>${esc(integration.empresa_vinculada || "-")}</strong>
            ${(provider?.configuracoes || []).map((config) => {
              const valor = integration.configuracao?.[config.chave];
              // Mostra o nome do local, não o código numérico que ninguém reconhece
              const local = locations.find((item) => String(item.integration_id) === String(integration.id)
                && String(item.omie_location_id) === String(valor));
              return `<span>${esc(config.rotulo)}</span><strong>${esc(local?.name || valor || "não configurado")}</strong>`;
            }).join("")}
            <span>Última sincronização</span><strong>${integration.ultima_sincronizacao ? moneyDate(integration.ultima_sincronizacao) : "Nunca"}</strong>
            <span>Último teste</span><strong>${integration.last_connection_test_at ? `${moneyDate(integration.last_connection_test_at)} (${integration.last_connection_duration_ms || 0} ms)` : "Nunca"}</strong>
          </div>

          <div class="integration-secret-list">
            ${(integration.credenciais || []).map((credential) => `
              <span class="${credential.configurada ? "" : "pendente"}">
                ${esc(credential.rotulo)}: ${esc(credential.configurada ? credential.mascara || "configurada" : "não configurada")}
              </span>`).join("")}
          </div>

          ${integration.last_error ? `<p class="integration-alert erro">${esc(integration.last_error)}</p>` : ""}

          <div class="integration-capability-grid">
            ${capacidades.map((cap) => cartaoCapacidade(integration, cap)).join("")
              || `<div class="empty-state">Este provedor não declara operações.</div>`}
          </div>

          <div class="integration-card-actions">
            <button class="btn secondary test-integration" type="button" data-id="${integration.id}">Testar conexão</button>
            <button class="btn secondary configure-integration" type="button" data-id="${integration.id}">Configurar</button>
            <button class="btn secondary toggle-integration" type="button" data-id="${integration.id}">${integration.ativo ? "Desativar" : "Ativar"}</button>
          </div>
        </article>`;
      }).join("") || `<section class="card"><div class="empty-state">Nenhuma integração cadastrada. Use “+ Adicionar integração” para conectar uma API.</div></section>`}
    </section>

    <section class="card filter-panel mt-4">
      <div class="filter-copy">
        <p class="eyebrow">Monitoramento</p>
        <h3 class="section-title text-xl font-black">Fila de sincronização</h3>
        <p class="text-sm text-slate-500">Todas as integrações compartilham esta fila. Jobs que falham por configuração ou credencial param e aguardam correção; falhas temporárias voltam sozinhas com espera crescente.</p>
      </div>
      <div class="filter-actions">
        <button class="btn secondary process-next-job" type="button">Processar próximo job</button>
      </div>
      <form id="integration-filter" class="filter-grid">
        <label class="field-select">Integração
          <select name="integrationId">
            <option value="">Todas</option>
            ${integrations.map((item) => `<option value="${item.id}" ${String(integrationId) === String(item.id) ? "selected" : ""}>${esc(item.nome)}</option>`).join("")}
          </select>
        </label>
        <label class="field-select">Operação
          <select name="capacidade">
            <option value="">Todas</option>
            ${todasCapacidades.map((item) => `<option value="${esc(item)}" ${capacidade === item ? "selected" : ""}>${esc(item)}</option>`).join("")}
          </select>
        </label>
        <label class="field-select">Status
          <select name="status">
            <option value="">Todos</option>
            ${["PENDENTE", "PROCESSANDO", "CONCLUIDO", "CONCLUIDO_COM_ALERTAS", "ERRO_TEMPORARIO", "ERRO_CONFIGURACAO", "ERRO_AUTENTICACAO", "ERRO_DADOS", "AGUARDANDO_REPROCESSAMENTO"]
              .map((item) => `<option value="${item}" ${status === item ? "selected" : ""}>${item}</option>`).join("")}
          </select>
        </label>
        <div class="filter-actions"><button class="btn" type="submit">Filtrar</button></div>
      </form>
    </section>

    <section class="card">
      ${table(["Status", "Operação", "Integração", "Tentativas", "Resultado", "Último erro", "Concluído em", "Ações"], jobs.map((job) => `
        <tr>
          <td>${statusPill(job.status)}</td>
          <td>${esc(job.job_type || "-")}</td>
          <td>${esc(job.integracao_nome || job.integration_id || "-")}</td>
          <td>${esc(job.attempts || 0)}</td>
          <td>${formatIntegrationJobResult(job.result)}</td>
          <td>${esc(job.last_error || "-")}</td>
          <td>${job.completed_at ? moneyDate(job.completed_at) : "-"}</td>
          <td>${["CONCLUIDO", "PROCESSANDO"].includes(job.status) ? "-" : `<button class="btn secondary retry-job" type="button" data-id="${job.id}">Reprocessar</button>`}</td>
        </tr>`))}
      ${jobs.length ? "" : `<div class="empty-state">Nenhum job na fila com esses filtros.</div>`}
    </section>

    <section class="card mt-4">
      <h3 class="section-title text-xl font-black">Vínculo PDV × local de estoque</h3>
      <p class="text-sm text-slate-500">Saldos e movimentações só são importados para PDVs vinculados a um local de estoque. Rode a operação “Locais de estoque” antes de criar os vínculos.</p>
      ${integrations.map((integration) => {
        const locaisDaIntegracao = locations.filter((item) => String(item.integration_id) === String(integration.id));
        const vinculos = mappings.filter((item) => String(item.integration_id) === String(integration.id) && item.active);
        return `
          <div class="integration-map-block">
            <h4>${esc(integration.nome)}</h4>
            ${locaisDaIntegracao.length
              ? `<form class="mapping-form filter-grid" data-id="${integration.id}">
                  <label class="field-select">PDV
                    <select name="pdv_id">${pdvs.map((pdv) => `<option value="${pdv.id}">${esc(pdv.nome)}</option>`).join("")}</select>
                  </label>
                  <label class="field-select">Local de estoque
                    <select name="omie_location_id">
                      ${locaisDaIntegracao.map((local) => `<option value="${esc(local.omie_location_id)}">${esc(local.name)}</option>`).join("")}
                    </select>
                  </label>
                  <div class="filter-actions"><button class="btn secondary" type="submit">Salvar vínculo</button></div>
                </form>`
              : `<div class="empty-state">Nenhum local importado ainda. Rode a operação “Locais de estoque” no card acima.</div>`}
            ${table(["PDV", "Local", "Vinculado em"], vinculos.map((item) => `
              <tr>
                <td>${esc(item.pdv_nome || item.pdv_acpark_id)}</td>
                <td>${esc(item.local_nome || item.omie_location_name || item.omie_location_id)}</td>
                <td>${item.updated_at ? moneyDate(item.updated_at) : "-"}</td>
              </tr>`))}
          </div>`;
      }).join("") || `<div class="empty-state">Cadastre uma integração para mapear locais.</div>`}
    </section>

    <section class="card mt-4">
      <div class="integration-card-head">
        <h3 class="section-title text-xl font-black">Fator de conversão dos produtos</h3>
        ${integrations.length
          ? `<button class="btn secondary reler-fatores" type="button" data-id="${integrations[0].id}">Reler todos</button>`
          : ""}
      </div>
      <p class="text-sm text-slate-500">
        Quantas unidades tem a embalagem em que o PDV pede. Vem da característica do produto no
        ERP — a correção é feita <strong>lá</strong>, não aqui. Depois de configurar as
        características, use “Reler todos” em vez de esperar o ciclo de 7 dias.
      </p>
      <div class="integration-secret-list">
        ${resumoFatores.length
          ? resumoFatores.map((item) => `<span class="${item.status === "INVALIDO" ? "pendente" : ""}">${esc(item.status)}: ${esc(item.total)}</span>`).join("")
          : `<span>Nenhum produto lido ainda</span>`}
      </div>
      ${pendenciasFator.length
        ? table(["SKU", "Produto", "Conteúdo no ERP", "Lido em"], pendenciasFator.map((item) => `
          <tr>
            <td>${esc(item.sku_produto)}</td>
            <td>${esc(item.produto_nome || "-")}${item.ativo === false ? " <em>(inativo)</em>" : ""}</td>
            <td><code>${esc(item.fator_conteudo_bruto || "")}</code></td>
            <td>${item.fator_lido_em ? moneyDate(item.fator_lido_em) : "-"}</td>
          </tr>`))
        : `<div class="empty-state">Nenhuma pendência: todo conteúdo lido é um número inteiro válido.</div>`}
    </section>

    <section class="card mt-4" id="assistente-fator">
      <div class="integration-card-head">
        <h3 class="section-title text-xl font-black">Assistente de fator (histórico de compra)</h3>
        <div class="assistente-acoes">
          ${integrations.length
            ? `<button class="btn secondary varrer-evidencia" type="button" data-id="${integrations[0].id}">Varrer histórico</button>
               <button class="btn secondary exportar-evidencia" type="button">Exportar planilha</button>
               <label class="btn secondary importar-planilha-label">Importar planilha de fardos
                 <input type="file" class="importar-planilha" accept=".xlsx,.xls" hidden />
               </label>
               <button class="btn secondary escrever-fatores" type="button" data-id="${integrations[0].id}">Gravar aprovados no ERP</button>`
            : ""}
        </div>
      </div>
      <p class="text-sm text-slate-500">
        Sugestões derivadas das notas de compra: o que o fornecedor faturou contra o que entrou
        no estoque. <strong>Nada é gravado sem aprovação.</strong> Produto sem nota fica pendente —
        nenhuma sugestão nasce de semelhança de nome ou de conhecimento de mercado.
      </p>

      <div class="integration-secret-list">
        <span>Aguardando conferência: ${esc(resumoEvidencia.aguardando_revisao || 0)}</span>
        <span>Confiança máxima: ${esc(resumoEvidencia.confianca_maxima || 0)}</span>
        <span>Confiança alta: ${esc(resumoEvidencia.confianca_alta || 0)}</span>
        <span>Confiança média: ${esc(resumoEvidencia.confianca_media || 0)}</span>
        <span>Evidência única: ${esc(resumoEvidencia.evidencia_unica || 0)}</span>
        <span>Conflito de embalagem: ${esc(resumoEvidencia.conflito_embalagem || 0)}</span>
        <span class="${resumoEvidencia.cadastro_generico ? "pendente" : ""}">Cadastro genérico: ${esc(resumoEvidencia.cadastro_generico || 0)}</span>
        <span>Aprovados: ${esc(resumoEvidencia.aprovados || 0)}</span>
        <span>Gravados no ERP: ${esc(resumoEvidencia.escritos || 0)}</span>
        ${resumoEvidencia.com_erro ? `<span class="pendente">Com erro: ${esc(resumoEvidencia.com_erro)}</span>` : ""}
      </div>

      <div class="assistente-filtros">
        <label>Fila
          <select class="filtro-evidencia" data-campo="fila">
            <option value="FATOR"${filtroEvidencia.fila === "FATOR" ? " selected" : ""}>Conferência de fator</option>
            <option value="CADASTRO"${filtroEvidencia.fila === "CADASTRO" ? " selected" : ""}>Corrigir cadastro no ERP</option>
          </select>
        </label>
        <label>Classificação
          <select class="filtro-evidencia" data-campo="situacao">
            <option value="">Todas</option>
            <option value="SUGERIDO"${filtroEvidencia.situacao === "SUGERIDO" ? " selected" : ""}>Fator sugerido</option>
            <option value="CONFLITO_EMBALAGEM"${filtroEvidencia.situacao === "CONFLITO_EMBALAGEM" ? " selected" : ""}>Conflito de embalagem</option>
            <option value="SO_AVULSO"${filtroEvidencia.situacao === "SO_AVULSO" ? " selected" : ""}>Só compra avulsa</option>
          </select>
        </label>
        <label class="assistente-busca">Buscar
          <input type="search" class="filtro-evidencia" data-campo="busca" value="${esc(filtroEvidencia.busca || "")}" placeholder="SKU, produto ou fornecedor" />
        </label>
        ${filtroEvidencia.fila === "FATOR"
          ? `<button class="btn secondary aprovar-lote" type="button">Confirmar todas de confiança alta</button>`
          : ""}
      </div>

      ${filtroEvidencia.fila === "CADASTRO"
        ? `<p class="text-sm text-slate-500">
             Estes códigos aparecem em notas com quantidades por embalagem incompatíveis entre si,
             ou descrevendo produtos diferentes. <strong>Isso não é conflito de fator, é cadastro
             errado</strong> — atribuir um fator aqui só carimba o problema. Corrija o cadastro no
             ERP e varra de novo.
           </p>`
        : ""}

      ${sugestoesEvidencia.length
        ? `<div class="assistente-lista">${sugestoesEvidencia.map((item) => cartaoSugestao(item)).join("")}</div>`
        : `<div class="empty-state">${
            resumoEvidencia.total
              ? "Nenhum produto nesta fila com os filtros atuais."
              : "Nenhuma evidência ainda. Use “Varrer histórico” para ler as notas de compra do ERP."
          }</div>`}
    </section>

    <section class="card mt-4" id="planilha-fardos">
      <h3 class="section-title text-xl font-black">Planilha de fardos — vínculo com o cadastro</h3>
      <p class="text-sm text-slate-500">
        A planilha é chaveada por <strong>nome de operação</strong>, não por SKU. O casamento é
        textual e <strong>erra</strong> — medido: o primeiro candidato de “ÁGUA MINERAL GÁSOSA
        500ML” foi “AGUA MINERAL SEM GAS 500ML”, o produto oposto. Por isso nenhum vínculo é
        criado sozinho.
      </p>
      <div class="integration-secret-list">
        <span>Linhas: ${esc(linhasPlanilha.length)}</span>
        <span>Vinculadas: ${esc(linhasPlanilha.filter((l) => l.external_product_id).length)}</span>
        <span class="${pendenciasVinculo.length ? "pendente" : ""}">Aguardando vínculo: ${esc(pendenciasVinculo.length)}</span>
        <span class="${linhasPlanilha.some((l) => l.divergente) ? "pendente" : ""}">Abas discordam: ${esc(linhasPlanilha.filter((l) => l.divergente).length)}</span>
      </div>
      ${pendenciasVinculo.length
        ? `<div class="assistente-lista">${pendenciasVinculo.slice(0, 60).map((linha) => `
            <article class="planilha-item ${linha.divergente ? "divergente" : ""}">
              <header>
                <div>
                  <strong>${esc(linha.nome_operacao)}</strong>
                  <span class="assistente-sku">${linha.secao ? `seção ${esc(linha.secao)} · ` : ""}${
                    linha.divergente
                      ? `abas discordam: ${esc(Object.values(linha.valores_por_aba || {}).filter((v) => v !== null).join(" x "))}`
                      : `fator ${esc(linha.fator ?? "—")}`
                  }</span>
                </div>
              </header>
              <div class="planilha-candidatos">
                ${linha.candidatos?.length
                  ? `<select class="vinculo-produto" data-linha="${esc(linha.nome_operacao)}">
                       <option value="">Escolha o produto…</option>
                       ${linha.candidatos.map((c) => `<option value="${esc(c.external_product_id)}">${esc(c.nome || c.sku)} [${esc(c.sku)}] — ${esc(Math.round(c.semelhanca * 100))}%</option>`).join("")}
                     </select>
                     <button class="btn vincular-linha" type="button" data-linha="${esc(linha.nome_operacao)}">Vincular</button>`
                  : `<em class="text-sm text-slate-500">Nenhum candidato parecido — vincule pelo cadastro do produto.</em>`}
              </div>
            </article>`).join("")}</div>`
        : `<div class="empty-state">${
            linhasPlanilha.length
              ? "Todas as linhas da planilha estão vinculadas."
              : "Nenhuma planilha importada ainda. Use “Importar planilha de fardos”."
          }</div>`}
    </section>

    <section class="card mt-4">
      <h3 class="section-title text-xl font-black">Lançamentos enviados à integração</h3>
      <p class="text-sm text-slate-500">
        Transferências Almoxarifado → PDV geradas pela confirmação de retirada. Esta é a única
        escrita do sistema: nunca venda, devolução, compra, inventário ou saldo absoluto.
      </p>
      <div class="integration-secret-list">
        ${resumoLancamentos.length
          ? resumoLancamentos.map((item) => `<span>${esc(item.status)}: ${esc(item.total)}</span>`).join("")
          : `<span>Nenhum lançamento registrado ainda</span>`}
      </div>
      ${table(
        ["Status", "Modo", "Pedido", "Produto", "PDV", "Qtd", "Origem → Destino", "Erro", "Criado em", "Ações"],
        launches.map((item) => `
        <tr>
          <td>${statusPill(item.status)}</td>
          <td>${esc(item.modo)}</td>
          <td>${esc(item.codigo_pedido)}</td>
          <td>${esc(item.produto_nome || item.sku_produto)}</td>
          <td>${esc(item.pdv_nome || item.pdv_id || "-")}</td>
          <td>${esc(Number(item.quantidade || 0))}</td>
          <td>${esc(item.local_origem || "-")} → ${esc(item.local_destino || "-")}</td>
          <td>${esc(item.erro || "-")}</td>
          <td>${item.created_at ? moneyDate(item.created_at) : "-"}</td>
          <td>${item.status === "ENVIADO"
            ? "-"
            : `<button class="btn secondary retry-launch" type="button" data-id="${item.id}">Reprocessar</button>`}</td>
        </tr>`)
      )}
      ${launches.length ? "" : `<div class="empty-state">Nenhum lançamento na fila.</div>`}
    </section>

    <section class="card mt-4">
      <h3 class="section-title text-xl font-black">Divergências de reconciliação</h3>
      <p class="text-sm text-slate-500">Divergências não são corrigidas automaticamente: ficam registradas aqui para revisão.</p>
      ${table(["Tipo", "PDV", "Produto", "Saldo local", "Saldo externo", "Diferença", "Criado em"], divergences.map((item) => `
        <tr>
          <td>${statusPill(item.difference_type)}</td>
          <td>${esc(item.pdv_nome || "-")}</td>
          <td>${esc(item.produto_nome || item.sku_produto || "-")}</td>
          <td>${esc(Number(item.saldo_local || 0))}</td>
          <td>${esc(Number(item.saldo_omie || 0))}</td>
          <td>${esc(Number(item.diferenca || 0))}</td>
          <td>${item.created_at ? moneyDate(item.created_at) : "-"}</td>
        </tr>`))}
      ${divergences.length ? "" : `<div class="empty-state">Nenhuma divergência pendente.</div>`}
    </section>
  `);

  const recarregar = () => viewIntegrations({ status, capacidade, integrationId });

  document.querySelector("#integration-filter").addEventListener("submit", async (event) => {
    event.preventDefault();
    await viewIntegrations(Object.fromEntries(new FormData(event.currentTarget)));
  });

  // Modal de configuração: os campos de credencial vêm do catálogo do provider selecionado
  const openIntegrationModal = (integration = {}) => {
    const modal = document.createElement("div");
    modal.className = "photo-viewer";
    const close = () => modal.remove();
    const providerAtual = () => providers.find((item) => item.id === (modal.querySelector('[name="provedor"]')?.value || integration.provedor)) || providers[0];

    // Redesenha os campos de credencial ao trocar de provider
    const camposDeCredencial = (provider) => (provider?.credenciais || []).map((credential) => {
      const salva = (integration.credenciais || []).find((item) => item.chave === credential.chave);
      return `
        <label class="grid gap-1 text-sm font-bold">${esc(credential.rotulo)}${credential.obrigatoria ? " *" : ""}
          <input name="${esc(credential.chave)}" type="password" autocomplete="new-password"
                 placeholder="${esc(salva?.configurada ? `Configurada (${salva.mascara}) — preencha só para alterar` : credential.rotulo)}" />
          ${credential.ajuda ? `<span class="text-xs font-normal text-slate-500">${esc(credential.ajuda)}</span>` : ""}
        </label>`;
    }).join("");

    // Ajustes não-secretos declarados pelo provider. O tipo "local_estoque" vira um seletor
    // com os locais já importados desta integração — digitar o código na mão é fonte de erro.
    const camposDeConfiguracao = (provider) => (provider?.configuracoes || []).map((config) => {
      const valor = integration.configuracao?.[config.chave] || "";
      const locais = locations.filter((item) => String(item.integration_id) === String(integration.id));
      const campo = config.tipo === "local_estoque"
        ? (locais.length
          ? `<select name="cfg_${esc(config.chave)}">
               <option value="">— selecione —</option>
               ${locais.map((local) => `<option value="${esc(local.omie_location_id)}" ${String(valor) === String(local.omie_location_id) ? "selected" : ""}>${esc(local.name)}</option>`).join("")}
             </select>`
          : `<input name="cfg_${esc(config.chave)}" value="${esc(valor)}" placeholder="Rode “Locais de estoque” para escolher pelo nome" />`)
        : `<input name="cfg_${esc(config.chave)}" value="${esc(valor)}" />`;
      return `
        <label class="grid gap-1 text-sm font-bold">${esc(config.rotulo)}${config.obrigatoria ? " *" : ""}
          ${campo}
          ${config.ajuda ? `<span class="text-xs font-normal text-slate-500">${esc(config.ajuda)}</span>` : ""}
        </label>`;
    }).join("");

    modal.innerHTML = `
      <form class="photo-viewer-dialog integration-modal" id="integration-form" role="dialog" aria-modal="true" aria-label="Configurar integração">
        <div class="photo-viewer-head">
          <div><p class="eyebrow">Integração</p><h3>${integration.id ? "Configurar integração" : "Adicionar integração"}</h3></div>
          <button class="icon-action close-integration-modal" type="button" aria-label="Fechar">&times;</button>
        </div>
        <input name="id" type="hidden" value="${esc(integration.id || "")}" />
        <div class="integration-modal-body">
          <label class="grid gap-1 text-sm font-bold">Provedor
            <select name="provedor" ${integration.id ? "disabled" : ""}>
              ${providers.map((provider) => `<option value="${esc(provider.id)}" ${integration.provedor === provider.id ? "selected" : ""}>${esc(provider.rotulo)} — ${esc(provider.descricao)}</option>`).join("")}
            </select>
          </label>
          <label class="grid gap-1 text-sm font-bold">Nome <input name="nome" value="${esc(integration.nome || "")}" required /></label>
          <label class="grid gap-1 text-sm font-bold">Ambiente
            <select name="ambiente">
              ${(providerAtual()?.ambientes || ["PRODUCAO"]).map((ambiente) => `<option value="${esc(ambiente)}" ${(integration.ambiente || "PRODUCAO") === ambiente ? "selected" : ""}>${esc(ambiente)}</option>`).join("")}
            </select>
          </label>
          <label class="grid gap-1 text-sm font-bold">URL base
            <input name="url_base" value="${esc(integration.url_base || providerAtual()?.url_base_padrao || "")}" />
          </label>
          <label class="grid gap-1 text-sm font-bold">Empresa vinculada <input name="empresa_vinculada" value="${esc(integration.empresa_vinculada || "")}" /></label>
          <div id="credential-fields" class="grid gap-3">${camposDeCredencial(providerAtual())}</div>
          <div id="config-fields" class="grid gap-3">${camposDeConfiguracao(providerAtual())}</div>
          <label class="category-chip selected-chip"><input name="ativo" type="checkbox" value="true" ${integration.ativo !== false ? "checked" : ""} /><span>Integração ativa</span></label>
        </div>
        <div class="form-actions integration-modal-actions">
          <button class="btn secondary close-integration-modal" type="button">Cancelar</button>
          <button class="btn" type="submit">Salvar integração</button>
        </div>
      </form>`;

    modal.querySelector('[name="provedor"]').addEventListener("change", () => {
      const provider = providerAtual();
      modal.querySelector("#credential-fields").innerHTML = camposDeCredencial(provider);
      modal.querySelector("#config-fields").innerHTML = camposDeConfiguracao(provider);
      const urlBase = modal.querySelector('[name="url_base"]');
      if (urlBase && !urlBase.value) urlBase.value = provider?.url_base_padrao || "";
    });

    modal.querySelectorAll(".close-integration-modal").forEach((button) => button.addEventListener("click", close));
    modal.querySelector("#integration-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      const originalLabel = submitButton.textContent;
      submitButton.disabled = true;
      submitButton.textContent = "Salvando...";
      const formData = new FormData(event.currentTarget);
      const form = Object.fromEntries(formData);
      form.ativo = formData.has("ativo");
      // Provedor fica desabilitado ao editar, então não vem no FormData
      form.provedor = form.provedor || integration.provedor;
      // Os ajustes vão prefixados com cfg_ no formulário e viajam agrupados em "configuracao",
      // para o backend distinguir configuração de credencial sem adivinhar pelo nome do campo
      form.configuracao = {};
      for (const [chave, valor] of Object.entries(form)) {
        if (!chave.startsWith("cfg_")) continue;
        form.configuracao[chave.slice(4)] = valor;
        delete form[chave];
      }
      try {
        await request("/api/admin/integrations", {
          method: "POST",
          body: JSON.stringify(form),
          loadingMessage: "Salvando integração..."
        });
        toast("Integração salva.");
        close();
        await recarregar();
      } catch (error) {
        toast(error.message || "Não foi possível salvar a integração.", "error");
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    document.body.appendChild(modal);
  };

  document.querySelector("#add-integration").addEventListener("click", () => openIntegrationModal());

  document.querySelectorAll(".configure-integration").forEach((button) => button.addEventListener("click", () => {
    openIntegrationModal(integrations.find((item) => String(item.id) === button.dataset.id) || {});
  }));

  document.querySelectorAll(".test-integration").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const resposta = await request("/api/admin/integrations/test", {
        method: "POST",
        body: JSON.stringify({ id: button.dataset.id }),
        loadingMessage: "Testando conexão..."
      });
      const detalhe = resposta.resultado?.detalhe;
      toast(detalhe?.total_de_produtos
        ? `Conexão validada. A API respondeu com ${detalhe.total_de_produtos} produtos.`
        : "Conexão validada.");
      await recarregar();
    } catch (error) {
      toast(error.message || "Não foi possível testar a integração.", "error");
      await recarregar();
    } finally {
      button.disabled = false;
    }
  }));

  // Dispara uma operação específica e mostra o resultado real, não só "registrado"
  document.querySelectorAll(".sync-capability").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const resposta = await request("/api/admin/integrations/sync", {
        method: "POST",
        body: JSON.stringify({ id: button.dataset.id, capacidade: button.dataset.capacidade }),
        loadingMessage: `Sincronizando ${button.dataset.capacidade.toLowerCase()}...`
      });
      const job = resposta.job || {};
      if (job.status === "CONCLUIDO") toast(`Sincronização concluída. ${formatIntegrationJobResult(job.result)}`);
      else if (job.status === "CONCLUIDO_COM_ALERTAS") toast(job.last_error || "Concluído com alertas.", "error");
      else toast(job.last_error || "A sincronização falhou.", "error");
    } catch (error) {
      toast(error.message || "Não foi possível sincronizar.", "error");
    } finally {
      button.disabled = false;
      await recarregar();
    }
  }));

  document.querySelector(".process-next-job")?.addEventListener("click", async () => {
    const resposta = await request("/api/admin/integrations/jobs/process-next", { method: "POST", body: JSON.stringify({}) });
    toast(resposta.job ? `Job ${resposta.job.job_type} processado.` : "Nenhum job pendente na fila.");
    await recarregar();
  });

  document.querySelectorAll(".retry-job").forEach((button) => button.addEventListener("click", async () => {
    const confirmed = await confirmSystem({
      title: "Reprocessar job",
      message: "Deseja recolocar este job na fila?",
      consequence: "Somente leitura será executada. Nada é escrito no sistema externo.",
      confirmLabel: "Reprocessar"
    });
    if (!confirmed) return;
    button.disabled = true;
    try {
      await request("/api/admin/integrations/jobs/retry", {
        method: "POST",
        body: JSON.stringify({ id: button.dataset.id, motivo: "Reprocessamento manual pela Central de Integrações." })
      });
      toast("Job recolocado na fila.");
      await recarregar();
    } catch (error) {
      toast(error.message || "Não foi possível reprocessar.", "error");
    } finally {
      button.disabled = false;
    }
  }));

  document.querySelectorAll(".mapping-form").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const select = event.currentTarget.querySelector('[name="omie_location_id"]');
    try {
      await request("/api/admin/integrations/location-mappings", {
        method: "POST",
        body: JSON.stringify({
          integration_id: event.currentTarget.dataset.id,
          pdv_id: formData.get("pdv_id"),
          omie_location_id: formData.get("omie_location_id"),
          omie_location_name: select?.selectedOptions?.[0]?.textContent?.trim() || ""
        })
      });
      toast("Vínculo salvo.");
      await recarregar();
    } catch (error) {
      toast(error.message || "Não foi possível salvar o vínculo.", "error");
    }
  }));


  // Filtros do assistente: mudam o estado e redesenham, sem perder o que já foi conferido
  document.querySelectorAll(".filtro-evidencia").forEach((campo) => {
    const evento = campo.tagName === "SELECT" ? "change" : "input";
    campo.addEventListener(evento, async () => {
      filtroEvidencia[campo.dataset.campo] = campo.value;
      // Busca é filtrada na tela; trocar fila ou classificação precisa de nova consulta
      if (campo.dataset.campo === "busca") {
        await recarregar();
        const foco = document.querySelector('.filtro-evidencia[data-campo="busca"]');
        if (foco) {
          foco.focus();
          foco.setSelectionRange(foco.value.length, foco.value.length);
        }
        return;
      }
      await recarregar();
    });
  });

  // Dispara a varredura do histórico de compra. Roda na fila, em lotes que encadeiam sozinhos.
  document.querySelectorAll(".varrer-evidencia").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request("/api/admin/integrations/fator-evidencia/varrer", {
          method: "POST",
          body: JSON.stringify({ id: button.dataset.id }),
          loadingMessage: "Agendando varredura do histórico de compra..."
        });
        toast("Varredura agendada. Ela lê as notas em lotes e continua sozinha.");
        await recarregar();
      } catch (error) {
        toast(error.message || "Não foi possível agendar a varredura.", "error");
      } finally {
        button.disabled = false;
      }
    })
  );

  // Envia uma decisão (ou um lote) e redesenha
  async function decidirFatores(decisoes, mensagem) {
    if (!integracaoAtiva || !decisoes.length) return;
    try {
      const resposta = await request("/api/admin/integrations/fator-evidencia/decidir", {
        method: "POST",
        body: JSON.stringify({ id: integracaoAtiva.id, decisoes }),
        loadingMessage: mensagem
      });
      const recusadas = resposta.recusadas?.length || 0;
      toast(
        recusadas
          ? `${resposta.aceitas} confirmada(s); ${recusadas} recusada(s) por fator inválido.`
          : `${resposta.aceitas} confirmada(s).`,
        recusadas ? "error" : "success"
      );
      await recarregar();
    } catch (error) {
      toast(error.message || "Não foi possível registrar a decisão.", "error");
    }
  }

  // Confirma o fator de um produto. O número vem do campo, não da sugestão: quem confere pode
  // corrigir, e um conflito de embalagem só sai daqui com a escolha explícita de uma pessoa.
  document.querySelectorAll(".aprovar-fator").forEach((button) =>
    button.addEventListener("click", async () => {
      const cartao = button.closest(".assistente-item");
      const campo = cartao?.querySelector(".fator-escolhido");
      const fator = Number(campo?.value || 0);
      if (!Number.isInteger(fator) || fator < 1) {
        toast("Informe um número inteiro positivo para o fator.", "error");
        campo?.focus();
        return;
      }
      await decidirFatores(
        [
          {
            external_product_id: button.dataset.produto,
            status: "APROVADA",
            fator,
            fator_sugerido: button.dataset.sugerido || null
          }
        ],
        "Registrando confirmação..."
      );
    })
  );

  // Deixa pendente: registra que uma pessoa olhou e não quis aprovar, para o item sair da fila
  document.querySelectorAll(".recusar-fator").forEach((button) =>
    button.addEventListener("click", async () => {
      await decidirFatores(
        [{ external_product_id: button.dataset.produto, status: "RECUSADA" }],
        "Marcando como pendente..."
      );
    })
  );

  // Confirmação em lote, só para confiança alta. Média e única continuam item a item de
  // propósito: são exatamente os casos em que uma pessoa precisa olhar a nota.
  document.querySelectorAll(".aprovar-lote").forEach((button) =>
    button.addEventListener("click", async () => {
      const alvos = sugestoesEvidencia.filter(
        (item) => item.confianca === "ALTA" && item.situacao === "SUGERIDO" && !item.decisao
      );
      if (!alvos.length) {
        toast("Nenhuma sugestão de confiança alta aguardando confirmação nesta fila.");
        return;
      }
      if (!window.confirm(`Confirmar o fator sugerido de ${alvos.length} produto(s) de confiança alta?`)) return;
      await decidirFatores(
        alvos.map((item) => ({
          external_product_id: item.external_product_id,
          status: "APROVADA",
          fator: item.fator,
          fator_sugerido: item.fator
        })),
        `Confirmando ${alvos.length} produto(s)...`
      );
    })
  );

  // Exporta a fila atual para conferência fora do sistema, com a evidência junto
  document.querySelectorAll(".exportar-evidencia").forEach((button) =>
    button.addEventListener("click", () => {
      if (!sugestoesEvidencia.length) {
        toast("Nada para exportar nesta fila.");
        return;
      }
      const linhas = [
        [
          "sku",
          "id_erp",
          "produto",
          "classificacao",
          "confianca",
          "fator_sugerido",
          "fatores_observados",
          "notas",
          "fator_hoje_no_erp",
          "pedidos_90_dias",
          "decisao",
          "motivo"
        ]
      ];
      for (const item of sugestoesEvidencia) {
        linhas.push([
          item.sku || "",
          item.external_product_id,
          item.nome || "",
          rotuloSituacao[item.situacao] || item.situacao,
          item.confianca || "",
          item.fator ?? "",
          (item.opcoes || []).map((o) => `${o.fator}x(${o.vezes})`).join(" | "),
          (item.opcoes || []).reduce((soma, o) => soma + Number(o.vezes || 0), 0),
          item.fator_no_erp ?? "",
          item.pedidos_recentes || 0,
          item.decisao ? `${item.decisao.status}${item.decisao.fator ? ` ${item.decisao.fator}` : ""}` : "",
          item.motivo || ""
        ]);
      }
      downloadCsv(`fatores-${filtroEvidencia.fila.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`, linhas);
      toast(`${sugestoesEvidencia.length} linha(s) exportada(s).`);
    })
  );

  // Grava no ERP os fatores já aprovados. Em modo simulação isso monta o payload e não envia.
  document.querySelectorAll(".escrever-fatores").forEach((button) =>
    button.addEventListener("click", async () => {
      const aprovados = resumoEvidencia.aprovados || 0;
      if (!aprovados) {
        toast("Nenhum fator aprovado aguardando gravação.");
        return;
      }
      if (!window.confirm(`Gravar ${aprovados} fator(es) aprovado(s) no cadastro do ERP?`)) return;
      button.disabled = true;
      try {
        await request("/api/admin/integrations/fator-evidencia/escrever", {
          method: "POST",
          body: JSON.stringify({ id: button.dataset.id }),
          loadingMessage: "Agendando gravação no ERP..."
        });
        toast("Gravação agendada. Em modo simulação o payload é montado e nada é enviado.");
        await recarregar();
      } catch (error) {
        toast(error.message || "Não foi possível agendar a gravação.", "error");
      } finally {
        button.disabled = false;
      }
    })
  );


  // Importa a planilha de fardos. O arquivo é lido AQUI, no navegador, com a mesma biblioteca
  // já usada na importação de produtos — o servidor recebe linhas, não um .xlsx.
  document.querySelectorAll(".importar-planilha").forEach((input) =>
    input.addEventListener("change", async () => {
      const arquivo = input.files?.[0];
      if (!arquivo) return;
      if (!integracaoAtiva) {
        toast("Cadastre uma integração antes de importar a planilha.", "error");
        return;
      }
      if (!window.XLSX) {
        toast("Leitor de Excel indisponível. Recarregue a página e tente novamente.", "error");
        return;
      }
      try {
        const workbook = window.XLSX.read(await arquivo.arrayBuffer(), { type: "array", raw: true });
        // Colunas A (nome de operação) e B (unidades por fardo) de cada aba
        const abas = {};
        for (const nomeAba of workbook.SheetNames) {
          abas[nomeAba] = window.XLSX.utils
            .sheet_to_json(workbook.Sheets[nomeAba], { header: 1, raw: true, defval: "" })
            .map((linha) => ({ nome: linha[0], valor: linha[1] }))
            .filter((linha) => String(linha.nome || "").trim());
        }
        const resposta = await request("/api/admin/integrations/fator-planilha/importar", {
          method: "POST",
          body: JSON.stringify({ id: integracaoAtiva.id, abas }),
          loadingMessage: "Importando planilha de fardos..."
        });
        const r = resposta.resumo || {};
        toast(
          `${r.linhas_lidas} linha(s): ${r.com_fator} com fator, ${r.divergentes} com abas discordando.`,
          r.divergentes ? "error" : "success"
        );
        await recarregar();
      } catch (error) {
        toast(error.message || "Não foi possível importar a planilha.", "error");
      } finally {
        input.value = "";
      }
    })
  );

  // Vincula uma linha da planilha ao produto escolhido. Sempre escolha explícita: o candidato
  // sugerido é só uma ordenação por semelhança de nome, e ela erra.
  document.querySelectorAll(".vincular-linha").forEach((button) =>
    button.addEventListener("click", async () => {
      const cartao = button.closest(".planilha-item");
      const select = cartao?.querySelector(".vinculo-produto");
      const produto = select?.value;
      if (!produto) {
        toast("Escolha o produto antes de vincular.", "error");
        select?.focus();
        return;
      }
      try {
        await request("/api/admin/integrations/fator-planilha/vincular", {
          method: "POST",
          body: JSON.stringify({
            id: integracaoAtiva.id,
            nome_operacao: button.dataset.linha,
            external_product_id: produto
          }),
          loadingMessage: "Vinculando linha da planilha..."
        });
        toast("Vínculo registrado. A planilha passa a corroborar o fator deste produto.");
        await recarregar();
      } catch (error) {
        toast(error.message || "Não foi possível vincular.", "error");
      }
    })
  );

  // Dispara a releitura de fatores depois de configurar as características no ERP
  document.querySelectorAll(".reler-fatores").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request("/api/admin/integrations/fatores/reler", {
          method: "POST",
          body: JSON.stringify({ id: button.dataset.id }),
          loadingMessage: "Agendando releitura dos fatores..."
        });
        toast("Releitura agendada. A varredura roda em lotes e continua sozinha.");
        await recarregar();
      } catch (error) {
        toast(error.message || "Não foi possível agendar a releitura.", "error");
      } finally {
        button.disabled = false;
      }
    })
  );

  // Reprocessa um lançamento com erro pela interface, sem terminal
  document.querySelectorAll(".retry-launch").forEach((button) =>
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await request("/api/admin/integrations/launches/retry", {
          method: "POST",
          body: JSON.stringify({ id: button.dataset.id }),
          loadingMessage: "Recolocando o lançamento na fila..."
        });
        toast("Lançamento recolocado na fila.");
        await recarregar();
      } catch (error) {
        toast(error.message || "Não foi possível reprocessar o lançamento.", "error");
      } finally {
        button.disabled = false;
      }
    })
  );

  document.querySelectorAll(".toggle-integration").forEach((button) => button.addEventListener("click", async () => {
    const integration = integrations.find((item) => String(item.id) === button.dataset.id);
    if (!integration) return;
    await request("/api/admin/integrations", {
      method: "POST",
      body: JSON.stringify({ ...integration, ativo: !integration.ativo })
    });
    toast(integration.ativo ? "Integração desativada." : "Integração ativada.");
    await recarregar();
  }));
}

// Converte milissegundos no texto curto usado nos cartões de operação
function formatarIntervalo(ms) {
  const minutos = Math.round(Number(ms) / 60000);
  if (!Number.isFinite(minutos) || minutos <= 0) return "Sob demanda";
  if (minutos < 60) return `A cada ${minutos} min`;
  const horas = Math.round(minutos / 60);
  return horas < 24 ? `A cada ${horas} h` : `A cada ${Math.round(horas / 24)} d`;
}

// View do painel (dashboard) com indicadores gerais
async function viewDashboard(filters = {}) {
  const from = filters.from || monthsAgo(6);
  const to = filters.to || today();
  const sku = filters.sku || "";
  const q = filters.q || "";
  const ranking = filters.ranking || "produto";
  const params = new URLSearchParams({ from, to, ranking });
  if (sku) params.set("sku", sku);
  if (q) params.set("q", q);
  const data = await request(`/api/admin/dashboard?${params.toString()}`);
  const max = Math.max(...data.ranking.map((r) => r.total), 1);
  const trendMax = Math.max(...data.productTrend.map((r) => r.total), 1);
  const rankingHint = ranking === "pdv"
    ? "Ranking agrupado por ponto de venda"
    : q
      ? `Pesquisa: ${esc(q)}`
      : "Clique em um produto para ver os últimos meses";
  shell(`
    <section class="card mb-4">
      <form id="dash-filter" class="filter-panel dashboard-filter">
        <div class="filter-copy">
          <p class="eyebrow">Filtro</p>
          <h3 class="section-title text-xl font-black">Pedidos e produto</h3>
        </div>
        <label class="field-wide">Produto
          <input name="q" type="search" list="dashboard-products" value="${esc(q)}" placeholder="Pesquisar produto" autocomplete="off" />
          <datalist id="dashboard-products">
            ${state.products.map((p) => `<option value="${esc(p.nome)}">${esc(p.sku)}</option>`).join("")}
          </datalist>
        </label>
        <label class="field-date">De
          <input name="from" type="date" value="${esc(from)}" />
        </label>
        <label class="field-date">Até
          <input name="to" type="date" value="${esc(to)}" />
        </label>
        <label class="field-select">Ranking
          <select name="ranking">
            <option value="produto" ${ranking === "produto" ? "selected" : ""}>Produtos</option>
            <option value="pdv" ${ranking === "pdv" ? "selected" : ""}>PDVs</option>
          </select>
        </label>
        <div class="filter-actions">
          <button class="btn" type="submit">Filtrar</button>
        </div>
      </form>
    </section>
    <section class="grid gap-4 md:grid-cols-4">
      <div class="card metric-card"><p class="eyebrow">PDVs</p><b class="section-title text-3xl">${state.pdvs.length}</b></div>
      <div class="card metric-card"><p class="eyebrow">Produtos</p><b class="section-title text-3xl">${data.stats?.total ?? state.products.length}</b></div>
      <div class="card metric-card"><p class="eyebrow">Ativos</p><b class="section-title text-3xl">${data.stats?.ativos ?? state.products.filter((p) => p.ativo).length}</b></div>
      <div class="card metric-card"><p class="eyebrow">Inativos</p><b class="section-title text-3xl">${data.stats?.inativos ?? state.products.filter((p) => !p.ativo).length}</b></div>
    </section>
    <section class="mt-4 grid gap-4 xl:grid-cols-[1fr_420px]">
      <div class="card print-ranking-area">
        <div class="print-logo-header">
          <img src="/logo-print.png" alt="Aguas Correntes Park" />
          <div>
            <p class="eyebrow">Aguas Correntes Park</p>
            <h2 class="section-title text-xl font-black">${ranking === "pdv" ? "Ranking de PDVs" : "Ranking de produtos"}</h2>
          </div>
        </div>
        <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="eyebrow">Ranking</p>
            <h3 class="section-title text-xl font-black">${ranking === "pdv" ? "PDVs com mais pedidos" : "Produtos mais pedidos"}</h3>
          </div>
          <p class="text-sm font-bold text-[color:var(--ac-teal-dark)]">${rankingHint}</p>
        </div>
        <div class="mt-4 grid gap-3">
          ${data.ranking.map((r) => `<button class="rank-item product-trend-btn ${ranking === "produto" && data.selectedProduct?.sku === r.sku ? "is-selected" : ""}" data-sku="${esc(r.sku || "")}" ${ranking === "pdv" ? "disabled" : ""}>
            <div class="flex justify-between gap-3 text-sm font-bold"><span>${ranking === "pdv" ? esc(r.pdv) : esc(r.produto)}</span><span>${r.total}</span></div>
            <div class="h-3 rounded-full bg-cyan-50"><div class="h-3 rounded-full bg-[color:var(--ac-orange)]" style="width:${(r.total / max) * 100}%"></div></div>
          </button>`).join("") || `<p class="text-sm text-slate-500">Nenhum pedido encontrado no período.</p>`}
        </div>
      </div>
      <div class="card">
        <p class="eyebrow">Gráfico mensal</p>
        <h3 class="section-title text-xl font-black">${ranking === "pdv" ? "Disponível no ranking de produtos" : data.selectedProduct ? esc(data.selectedProduct.nome) : "Selecione um produto"}</h3>
        <p class="mt-1 text-sm text-slate-500">${ranking === "pdv" ? "Troque para Produtos para visualizar a evolução mensal de um item." : "Quantidade solicitada nos últimos 6 meses."}</p>
        <div class="trend-chart mt-5">
          ${ranking === "produto" ? data.productTrend.map((item) => `<div class="trend-bar">
            <div class="trend-value">${item.total}</div>
            <div class="trend-track"><span style="height:${Math.max((item.total / trendMax) * 100, item.total > 0 ? 8 : 2)}%"></span></div>
            <strong>${esc(monthLabel(item.mes))}</strong>
          </div>`).join("") || `<p class="text-sm text-slate-500">Sem dados para exibir.</p>` : `<p class="text-sm text-slate-500">Gráfico mensal oculto para ranking por PDV.</p>`}
        </div>
      </div>
    </section>`);

  document.querySelector("#dash-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const typedProduct = String(form.q || "").trim();
    const foundProduct = state.products.find((p) =>
      p.sku.toLowerCase() === typedProduct.toLowerCase() ||
      p.nome.toLowerCase() === typedProduct.toLowerCase()
    );
    viewDashboard({ from: form.from, to: form.to, q: typedProduct, sku: foundProduct?.sku || "", ranking: form.ranking });
  });

  document.querySelectorAll(".product-trend-btn").forEach((btn) => btn.addEventListener("click", () => {
    if (btn.dataset.sku) viewDashboard({ from, to, q, sku: btn.dataset.sku, ranking });
  }));
}

// View de produtos (estoque central) com filtros e planilha
async function viewProductsV2(options = {}) {
  const productFilterStorageKey = "acpark_central_product_filter";
  const readCentralProductFilter = () => {
    const fromDom = {
      tab: document.querySelector("[data-product-tab].is-active")?.dataset.productTab || "",
      search: document.querySelector("#central-product-search")?.value || "",
      status: document.querySelector("#central-product-status")?.value || "",
      stockSort: document.querySelector("#central-product-stock-sort")?.value || "",
      categorySearch: document.querySelector("#central-category-search")?.value || "",
      categories: [...document.querySelectorAll(".central-category-check:checked")].map((checkbox) => checkbox.value)
    };
    if (fromDom.search || fromDom.status || fromDom.stockSort || fromDom.categorySearch || fromDom.categories.length || fromDom.tab) return fromDom;
    try {
      const stored = JSON.parse(sessionStorage.getItem(productFilterStorageKey) || "{}");
      return {
        tab: stored.tab || "manual",
        search: stored.search || "",
        status: stored.status || "",
        stockSort: stored.stockSort || "",
        categorySearch: stored.categorySearch || "",
        categories: Array.isArray(stored.categories) ? stored.categories : []
      };
    } catch {
      return { tab: "manual", search: "", status: "", stockSort: "", categorySearch: "", categories: [] };
    }
  };
  const currentFilter = readCentralProductFilter();
  const data = await request("/api/admin/products", { silentLoading: Boolean(options.auto) });
  const manualProducts = data.products.filter((product) => (product.origem || "manual") === "manual");
  const omieProducts = data.products.filter((product) => (product.origem || "manual") === "omie");
  const productFilterCategories = [...new Set(data.products.flatMap((product) => {
    const values = Array.isArray(product.categorias) && product.categorias.length
      ? product.categorias
      : String(product.categoria || "").split(",");
    return values.map((category) => String(category || "").trim()).filter(Boolean);
  }))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const productOrder = new Map(data.products.map((product, index) => [String(product.sku), index]));
  const sheetCategoryOptions = [...new Set(data.products.flatMap((product) => {
    const values = Array.isArray(product.categorias) && product.categorias.length
      ? product.categorias
      : String(product.categoria || "").split(",");
    return values.map((category) => String(category || "").trim()).filter(Boolean);
  }))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const productRow = (p, actions = "") => {
    const categories = Array.isArray(p.categorias) && p.categorias.length ? p.categorias : String(p.categoria || "").split(",");
    const categoryText = categories.map((category) => String(category || "").trim()).filter(Boolean).join(", ") || "-";
    const searchText = `${p.sku} ${p.nome} ${categoryText}`.toLowerCase();
    const categoryKeys = categories.map((category) => String(category || "").trim().toLowerCase()).filter(Boolean).join("|");
    return `
      <tr class="central-product-row" data-product-search="${esc(searchText)}" data-product-categories="${esc(categoryKeys)}" data-product-status="${p.ativo ? "ativo" : "inativo"}" data-product-stock="${Number(p.qtd_total || 0)}" data-product-order="${productOrder.get(String(p.sku)) ?? 0}">
        <td>${esc(p.sku)}</td>
        <td>${esc(p.nome)}</td>
        <td>${esc(categoryText)}</td>
        <td>${p.qtd_total}</td>
        <td>${p.ativo ? "Ativo" : "Inativo"}</td>
        ${actions}
      </tr>`;
  };
  shell(`
    <section class="grid gap-4">
      <section class="product-tabs-shell">
        <div class="config-tabs" role="tablist" aria-label="Produtos do estoque central">
          <button class="config-tab ${currentFilter.tab === "manual" || !currentFilter.tab ? "is-active" : ""}" type="button" data-product-tab="manual" role="tab" aria-selected="${currentFilter.tab === "manual" || !currentFilter.tab ? "true" : "false"}">Produtos manuais</button>
          <button class="config-tab ${currentFilter.tab === "omie" ? "is-active" : ""}" type="button" data-product-tab="omie" role="tab" aria-selected="${currentFilter.tab === "omie" ? "true" : "false"}">Produtos OMIE</button>
          <button class="config-tab ${currentFilter.tab === "categories" ? "is-active" : ""}" type="button" data-product-tab="categories" role="tab" aria-selected="${currentFilter.tab === "categories" ? "true" : "false"}">Categorias</button>
        </div>
        <section class="card filter-panel product-filter-card" id="central-product-filter">
          <div class="filter-copy">
            <p class="eyebrow">Filtro</p>
            <h3 class="section-title text-lg font-black">Pesquisar produtos</h3>
          </div>
          <label class="field-wide">Produto
            <input id="central-product-search" type="search" value="${esc(currentFilter.search)}" placeholder="Digite SKU, código ou nome do produto" />
          </label>
          <label class="field-select">Status
            <select id="central-product-status">
              <option value="" ${!currentFilter.status ? "selected" : ""}>Todos os status</option>
              <option value="ativo" ${currentFilter.status === "ativo" ? "selected" : ""}>Ativo</option>
              <option value="inativo" ${currentFilter.status === "inativo" ? "selected" : ""}>Inativo</option>
            </select>
          </label>
          <label class="field-select">Estoque
            <select id="central-product-stock-sort">
              <option value="" ${!currentFilter.stockSort ? "selected" : ""}>Sem ordenação</option>
              <option value="asc" ${currentFilter.stockSort === "asc" ? "selected" : ""}>Menor estoque</option>
              <option value="desc" ${currentFilter.stockSort === "desc" ? "selected" : ""}>Maior estoque</option>
            </select>
          </label>
          <div class="multi-filter" id="central-category-filter">
            <span class="multi-filter-label">Categoria</span>
            <button class="multi-filter-toggle" id="central-category-filter-toggle" type="button" aria-expanded="false">
              <span id="central-category-filter-label">Todas as categorias</span>
              <span aria-hidden="true">&#9662;</span>
            </button>
            <div class="multi-filter-menu hidden" id="central-category-filter-menu">
              <div class="multi-filter-actions">
                <button class="btn compact" id="apply-category-filter" type="button">Aplicar</button>
                <button class="btn compact secondary" id="cancel-category-filter" type="button">Cancelar</button>
              </div>
              <div class="multi-filter-head">
                <label class="multi-filter-check">
                  <input id="central-category-select-all" type="checkbox" />
                  <span>Selecionar tudo</span>
                </label>
                <span id="central-category-count">0 selecionada(s)</span>
              </div>
              <input id="central-category-search" type="search" value="${esc(currentFilter.categorySearch)}" placeholder="Pesquisar categoria" />
              <div class="multi-filter-options">
                ${productFilterCategories.map((category) => `
                  <label class="multi-filter-option" data-category-option="${esc(category.toLowerCase())}">
                    <input class="central-category-check" type="checkbox" value="${esc(category.toLowerCase())}" ${currentFilter.categories.includes(category.toLowerCase()) ? "checked" : ""} />
                    <span>${esc(category)}</span>
                  </label>`).join("") || `<p class="text-sm text-slate-500">Nenhuma categoria cadastrada.</p>`}
              </div>
            </div>
          </div>
          <div class="filter-actions">
            <button class="btn" id="search-product-filter" type="button">Buscar</button>
            <button class="btn secondary" id="clear-product-filter" type="button">Limpar filtros</button>
          </div>
        </section>
        <section class="product-panel ${currentFilter.tab === "manual" || !currentFilter.tab ? "is-active" : "hidden"}" data-product-panel="manual" role="tabpanel">
          <div class="section-toolbar">
            <div>
              <p class="eyebrow">Cadastro</p>
              <h3 class="section-title text-xl font-black">Produtos manuais</h3>
            </div>
            <button class="icon-action" id="open-product-form" type="button" title="Adicionar produto" aria-label="Adicionar produto">+</button>
          </div>
          <section id="product-form-panel" class="card product-side-panel hidden">
            <form id="product-form" class="grid gap-3">
              <input name="editing" type="hidden" />
              <div class="panel-head">
                <div>
                  <p class="eyebrow">Cadastro</p>
                  <h3 class="section-title text-xl font-black" id="product-form-title">Produto manual</h3>
                </div>
                <button class="icon-action" id="close-product-form" type="button" title="Fechar" aria-label="Fechar">&times;</button>
              </div>
              <input name="sku" placeholder="SKU/Código" required />
              <input name="nome" placeholder="Nome" required />
              <input name="qtd_total" type="number" min="0" value="0" />
              <select name="ativo">
                <option value="true">Ativo</option>
                <option value="false">Inativo</option>
              </select>
              <div class="category-picker">
                <p class="text-sm font-bold">Categorias do produto</p>
                <div class="category-select-row">
                  <select id="product-category-select">
                    <option value="">Selecione uma categoria</option>
                    ${state.categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join("")}
                  </select>
                  <button class="btn secondary" id="add-product-category" type="button">Adicionar</button>
                </div>
                <div class="category-picker-list" id="product-category-list"></div>
              </div>
              <button class="btn secondary hidden" id="cancel-product-edit" type="button">Cancelar edição</button>
              <button class="btn">Salvar produto</button>
            </form>
          </section>
          <div class="card">
            ${table(["SKU", "Produto", "Categoria", "Estoque central", "Status", "Ações"], manualProducts.map((p) => `
              ${productRow(p, `<td><div class="table-actions"><button class="icon-action edit-product" type="button" data-sku="${esc(p.sku)}" data-name="${esc(p.nome)}" data-qty="${p.qtd_total}" data-active="${p.ativo}" data-categories="${esc((p.categorias || []).join("|"))}" title="Editar produto" aria-label="Editar produto">&#9998;</button><button class="icon-action ${p.ativo ? "danger" : "success"} toggle-product-active" type="button" data-sku="${esc(p.sku)}" data-name="${esc(p.nome)}" data-qty="${p.qtd_total}" data-active="${p.ativo}" data-categories="${esc((p.categorias || []).join("|"))}" title="${p.ativo ? "Inativar produto" : "Ativar produto"}" aria-label="${p.ativo ? "Inativar produto" : "Ativar produto"}">${p.ativo ? "&times;" : "&#10003;"}</button></div></td>`)}
            `))}
          </div>
        </section>
        <section class="product-panel ${currentFilter.tab === "omie" ? "is-active" : "hidden"}" data-product-panel="omie" role="tabpanel">
          <div class="card">
            ${table(["SKU", "Produto", "Categoria", "Estoque central", "Status"], omieProducts.map((p) => `
              ${productRow(p)}
            `))}
          </div>
        </section>
        <section class="product-panel ${currentFilter.tab === "categories" ? "is-active" : "hidden"}" data-product-panel="categories" role="tabpanel">
          <section class="card grid gap-4">
            <div>
              <p class="eyebrow">Categorias</p>
              <h3 class="section-title text-xl font-black">Gerenciar categorias</h3>
            </div>
            <form id="category-form" class="category-panel-form">
              <input name="atual" type="hidden" />
              <input name="nome" placeholder="Nova categoria" required />
              <div class="category-panel-actions">
                <button class="btn secondary hidden" id="cancel-category-edit" type="button">Cancelar</button>
                <button class="btn" id="save-category-btn" type="submit">Salvar categoria</button>
              </div>
            </form>
            <div class="category-panel-list" id="category-panel-list"></div>
          </section>
        </section>
      </section>
    </section>`, `
      <div class="sheet-actions">
        <button class="btn secondary" id="sheet-actions-toggle" type="button" aria-expanded="false" aria-controls="sheet-actions-menu">Planilha</button>
        <div class="sheet-manager-backdrop hidden" id="sheet-manager-backdrop" aria-hidden="true"></div>
        <div class="sheet-actions-menu sheet-manager-menu hidden" id="sheet-actions-menu" role="dialog" aria-modal="true" aria-labelledby="sheet-manager-title">
          <div class="sheet-manager-head">
            <div>
              <p class="eyebrow">Planilhas</p>
              <strong id="sheet-manager-title">Gerenciar dados</strong>
            </div>
            <button class="icon-action" id="close-sheet-actions" type="button" aria-label="Fechar planilhas">&times;</button>
          </div>
          <label>Pesquisar
            <input id="sheet-product-search" type="search" placeholder="SKU, produto ou categoria" />
          </label>
          <div class="sheet-manager-grid">
            <label>Status
              <select id="sheet-product-status">
                <option value="">Todos</option>
                <option value="ativo">Ativos</option>
                <option value="inativo">Inativos</option>
              </select>
            </label>
            <label>Origem
              <select id="sheet-product-origin">
                <option value="">Todas</option>
                <option value="manual">Manual</option>
                <option value="omie">OMIE</option>
              </select>
            </label>
          </div>
          <label>Categoria
            <select id="sheet-product-category">
              <option value="">Todas as categorias</option>
              ${sheetCategoryOptions.map((category) => `<option value="${esc(category.toLowerCase())}">${esc(category)}</option>`).join("")}
            </select>
          </label>
          <div class="sheet-manager-summary" id="sheet-manager-summary">${data.products.length} produto(s) disponíveis</div>
          <button class="btn secondary" id="export-products-filtered" type="button">Exportar filtrados</button>
          <button class="btn secondary" id="export-products-all" type="button">Exportar todos</button>
          <label class="btn secondary import-sheet-control">
            Importar planilha
            <input id="import-products" type="file" accept=".xlsx,.xls,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values" hidden />
          </label>
        </div>
      </div>
    `);

  document.querySelectorAll("[data-product-tab]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-product-tab]").forEach((tab) => {
      const active = tab.dataset.productTab === button.dataset.productTab;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-product-panel]").forEach((panel) => {
      const active = panel.dataset.productPanel === button.dataset.productTab;
      panel.classList.toggle("is-active", active);
      panel.classList.toggle("hidden", !active);
    });
    document.querySelector("#central-product-filter")?.classList.toggle("hidden", button.dataset.productTab === "categories");
    applyCentralProductFilter();
    saveCentralProductFilter();
  }));

  const saveCentralProductFilter = () => {
    const payload = {
      tab: document.querySelector("[data-product-tab].is-active")?.dataset.productTab || "manual",
      search: document.querySelector("#central-product-search")?.value || "",
      status: document.querySelector("#central-product-status")?.value || "",
      stockSort: document.querySelector("#central-product-stock-sort")?.value || "",
      categorySearch: document.querySelector("#central-category-search")?.value || "",
      categories: [...document.querySelectorAll(".central-category-check:checked")].map((checkbox) => checkbox.value)
    };
    sessionStorage.setItem(productFilterStorageKey, JSON.stringify(payload));
  };

  const centralProductFilterPanel = document.querySelector("#central-product-filter");
  const centralProductSearch = document.querySelector("#central-product-search");
  const centralProductStatus = document.querySelector("#central-product-status");
  const centralProductStockSort = document.querySelector("#central-product-stock-sort");
  const centralCategorySearch = document.querySelector("#central-category-search");
  const centralProductSearchButton = document.querySelector("#search-product-filter");
  const centralCategoryRows = [...document.querySelectorAll("[data-category-option]")];
  const centralProductRowsByPanel = new Map([...document.querySelectorAll(".product-panel")].map((panel) => [
    panel.dataset.productPanel,
    [...panel.querySelectorAll(".central-product-row")]
  ]));
  const centralPanelSortState = new Map();
  let centralFilterFrame = 0;
  let centralFilterVersion = 0;
  const setCentralFilterBusy = (busy) => {
    centralProductFilterPanel?.classList.toggle("is-filtering", busy);
  };
  const applyCentralProductFilter = () => {
    const version = ++centralFilterVersion;
    if (centralFilterFrame) cancelAnimationFrame(centralFilterFrame);
    setCentralFilterBusy(true);
    centralFilterFrame = requestAnimationFrame(() => {
      if (version !== centralFilterVersion) return;
      const start = performance.now();
    const term = String(document.querySelector("#central-product-search")?.value || "").trim().toLowerCase();
    const status = String(document.querySelector("#central-product-status")?.value || "").trim().toLowerCase();
    const stockSort = String(document.querySelector("#central-product-stock-sort")?.value || "");
    const selectedCategories = [...document.querySelectorAll(".central-category-check:checked")].map((checkbox) => checkbox.value);
    const activePanel = document.querySelector(".product-panel.is-active");
      const activePanelKey = activePanel?.dataset.productPanel || "";
      const rows = centralProductRowsByPanel.get(activePanelKey) || [];
    rows.forEach((row) => {
      const matchesTerm = !term || row.dataset.productSearch.includes(term);
      const rowCategories = String(row.dataset.productCategories || "").split("|").filter(Boolean);
      const matchesCategory = !selectedCategories.length || rowCategories.some((category) => selectedCategories.includes(category));
      const matchesStatus = !status || row.dataset.productStatus === status;
      row.classList.toggle("hidden", !(matchesTerm && matchesCategory && matchesStatus));
    });
      const sortSignature = `${activePanelKey}:${stockSort}`;
      const tbody = activePanel?.querySelector("tbody");
      if (tbody && centralPanelSortState.get(activePanelKey) !== sortSignature) {
        rows
          .slice()
          .sort((a, b) => {
        if (!stockSort) return Number(a.dataset.productOrder || 0) - Number(b.dataset.productOrder || 0);
        const stockA = Number(a.dataset.productStock || 0);
        const stockB = Number(b.dataset.productStock || 0);
        return stockSort === "asc" ? stockA - stockB : stockB - stockA;
      })
          .forEach((row) => tbody.appendChild(row));
        centralPanelSortState.set(activePanelKey, sortSignature);
      }
    saveCentralProductFilter();
      centralFilterFrame = 0;
      requestAnimationFrame(() => setCentralFilterBusy(false));
      if (window.__ACPACK_DEBUG_FILTERS__) {
        console.debug("Filtro Estoque Central", {
          tempoAteExecutarMs: Math.round(start),
          tempoRenderizacaoMs: Math.round((performance.now() - start) * 10) / 10,
          linhas: rows.length,
          apiMs: 0,
          bancoMs: 0
        });
      }
    });
  };
  const updateCentralCategoryFilterLabel = () => {
    const selected = [...document.querySelectorAll(".central-category-check:checked")];
    const count = selected.length;
    const total = document.querySelectorAll(".central-category-check").length;
    const label = document.querySelector("#central-category-filter-label");
    const countLabel = document.querySelector("#central-category-count");
    const selectAll = document.querySelector("#central-category-select-all");
    if (label) label.textContent = count ? `${count} de ${total} selecionada(s)` : "Todas as categorias";
    if (countLabel) countLabel.textContent = count ? `${count} selecionada(s)` : "0 selecionada(s)";
    if (selectAll) {
      selectAll.checked = total > 0 && count === total;
      selectAll.indeterminate = count > 0 && count < total;
    }
  };
  const closeCentralCategoryFilter = () => {
    document.querySelector("#central-category-filter-menu")?.classList.add("hidden");
    document.querySelector("#central-category-filter-toggle")?.setAttribute("aria-expanded", "false");
  };
  const executeCentralProductSearch = () => {
    if (centralProductSearchButton?.disabled) return;
    centralProductSearchButton.disabled = true;
    centralProductSearchButton.textContent = "Buscando...";
    applyCentralProductFilter();
    setTimeout(() => {
      centralProductSearchButton.disabled = false;
      centralProductSearchButton.textContent = "Buscar";
    }, 250);
  };
  centralProductSearch?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      executeCentralProductSearch();
    }
  });
  centralProductSearchButton?.addEventListener("click", executeCentralProductSearch);
  document.querySelector("#central-category-filter-toggle")?.addEventListener("click", () => {
    const menu = document.querySelector("#central-category-filter-menu");
    const isHidden = menu?.classList.contains("hidden");
    menu?.classList.toggle("hidden", !isHidden);
    document.querySelector("#central-category-filter-toggle")?.setAttribute("aria-expanded", isHidden ? "true" : "false");
  });
  centralCategorySearch?.addEventListener("input", (event) => {
    const term = String(event.target.value || "").trim().toLowerCase();
    centralCategoryRows.forEach((option) => {
      option.classList.toggle("hidden", term && !option.dataset.categoryOption.includes(term));
    });
  });
  document.querySelector("#central-category-select-all")?.addEventListener("change", (event) => {
    document.querySelectorAll(".central-category-check").forEach((checkbox) => {
      if (!checkbox.closest("[data-category-option]")?.classList.contains("hidden")) {
        checkbox.checked = event.target.checked;
      }
    });
    updateCentralCategoryFilterLabel();
  });
  document.querySelectorAll(".central-category-check").forEach((checkbox) => checkbox.addEventListener("change", () => {
    updateCentralCategoryFilterLabel();
  }));
  document.querySelector("#apply-category-filter")?.addEventListener("click", () => {
    updateCentralCategoryFilterLabel();
    closeCentralCategoryFilter();
  });
  document.querySelector("#cancel-category-filter")?.addEventListener("click", closeCentralCategoryFilter);
  document.querySelector("#clear-product-filter")?.addEventListener("click", () => {
    document.querySelector("#central-product-search").value = "";
    document.querySelector("#central-product-status").value = "";
    document.querySelector("#central-product-stock-sort").value = "";
    document.querySelectorAll(".central-category-check").forEach((checkbox) => {
      checkbox.checked = false;
    });
    document.querySelector("#central-category-search").value = "";
    document.querySelectorAll("[data-category-option]").forEach((option) => option.classList.remove("hidden"));
    updateCentralCategoryFilterLabel();
    closeCentralCategoryFilter();
    sessionStorage.removeItem(productFilterStorageKey);
  });
  updateCentralCategoryFilterLabel();
  applyCentralProductFilter();

  const sheetActionsMenu = document.querySelector("#sheet-actions-menu");
  const sheetActionsToggle = document.querySelector("#sheet-actions-toggle");
  const sheetActionsBackdrop = document.querySelector("#sheet-manager-backdrop");
  const closeSheetActions = () => {
    sheetActionsMenu?.classList.add("hidden");
    sheetActionsBackdrop?.classList.add("hidden");
    sheetActionsToggle?.setAttribute("aria-expanded", "false");
    document.body.classList.remove("sheet-manager-open");
  };
  const openSheetActions = () => {
    sheetActionsMenu?.classList.remove("hidden");
    sheetActionsBackdrop?.classList.remove("hidden");
    sheetActionsToggle?.setAttribute("aria-expanded", "true");
    document.body.classList.add("sheet-manager-open");
    updateSheetSummary();
    setTimeout(() => document.querySelector("#sheet-product-search")?.focus(), 0);
  };
  const sheetSearchInput = document.querySelector("#sheet-product-search");
  const sheetStatusInput = document.querySelector("#sheet-product-status");
  const sheetOriginInput = document.querySelector("#sheet-product-origin");
  const sheetCategoryInput = document.querySelector("#sheet-product-category");
  const sheetSummary = document.querySelector("#sheet-manager-summary");
  const sheetFilteredProducts = () => {
    const term = String(sheetSearchInput?.value || "").trim().toLowerCase();
    const status = String(sheetStatusInput?.value || "");
    const origin = String(sheetOriginInput?.value || "");
    const category = String(sheetCategoryInput?.value || "");
    return data.products.filter((product) => {
      const categories = Array.isArray(product.categorias) && product.categorias.length
        ? product.categorias
        : String(product.categoria || "").split(",");
      const categoryList = categories.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
      const text = `${product.sku || ""} ${product.nome || ""} ${categoryList.join(" ")}`.toLowerCase();
      const productStatus = product.ativo ? "ativo" : "inativo";
      const productOrigin = product.origem || "manual";
      return (!term || text.includes(term))
        && (!status || productStatus === status)
        && (!origin || productOrigin === origin)
        && (!category || categoryList.includes(category));
    });
  };
  const updateSheetSummary = () => {
    if (sheetSummary) sheetSummary.textContent = `${sheetFilteredProducts().length} de ${data.products.length} produto(s) selecionado(s)`;
  };
  const exportProductsSheet = (products, filename = "produtos_google_sheets.csv") => {
    const headers = ["SKU", "Produto", "Categoria", "Estoque Central", "Ativo", "Origem"];
    const rows = products.map((p) => [spreadsheetText(p.sku), p.nome, (p.categorias || []).join(", ") || p.categoria || "", p.qtd_total, p.ativo ? "SIM" : "N\u00c3O", p.origem || "manual"]);
    downloadCsv(filename, [headers, ...rows]);
    closeSheetActions();
  };
  sheetActionsToggle?.addEventListener("click", () => {
    if (sheetActionsMenu?.classList.contains("hidden")) {
      openSheetActions();
    } else {
      closeSheetActions();
    }
  });
  document.querySelector("#close-sheet-actions")?.addEventListener("click", closeSheetActions);
  sheetActionsBackdrop?.addEventListener("click", closeSheetActions);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sheetActionsMenu?.classList.contains("hidden")) {
      closeSheetActions();
    }
  });
  [sheetSearchInput, sheetStatusInput, sheetOriginInput, sheetCategoryInput].forEach((field) => {
    field?.addEventListener("input", updateSheetSummary);
    field?.addEventListener("change", updateSheetSummary);
  });
  document.querySelector("#export-products-filtered")?.addEventListener("click", () => exportProductsSheet(sheetFilteredProducts(), "produtos_filtrados_google_sheets.csv"));
  document.querySelector("#export-products-all")?.addEventListener("click", () => exportProductsSheet(data.products, "produtos_google_sheets.csv"));
  document.querySelector("#import-products").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const items = await parseProductsFile(file);
      if (!items.length) throw new Error("Nenhum produto válido encontrado na planilha.");
      const imported = await importProductsInBatches(items);
      toast(`${imported} produto(s) importado(s).`);
      closeSheetActions();
      route("products");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      event.target.value = "";
    }
  });

  const productForm = document.querySelector("#product-form");
  const productFormPanel = document.querySelector("#product-form-panel");
  const productTitle = document.querySelector("#product-form-title");
  const productSku = productForm.querySelector('[name="sku"]');
  const cancelProductEdit = document.querySelector("#cancel-product-edit");
  const productCategories = [];
  const renderProductCategories = () => {
    const list = document.querySelector("#product-category-list");
    list.innerHTML = productCategories.length
      ? productCategories.map((category) => `
        <label class="category-chip selected-chip">
          <input name="categorias" type="hidden" value="${esc(category)}">
          <span>${esc(category)}</span>
          <button class="chip-remove" type="button" data-product-category="${esc(category)}" aria-label="Remover categoria">x</button>
        </label>`).join("")
      : `<p class="text-sm text-slate-500">Nenhuma categoria adicionada.</p>`;
    list.querySelectorAll("[data-product-category]").forEach((button) => button.addEventListener("click", () => {
      const index = productCategories.indexOf(button.dataset.productCategory);
      if (index >= 0) productCategories.splice(index, 1);
      renderProductCategories();
    }));
  };
  const openProductPanel = () => productFormPanel.classList.remove("hidden");
  const closeProductPanel = () => productFormPanel.classList.add("hidden");
  const resetProductForm = () => {
    productForm.reset();
    productForm.querySelector('[name="editing"]').value = "";
    productSku.readOnly = false;
    productTitle.textContent = "Produto manual";
    cancelProductEdit.classList.add("hidden");
    productCategories.splice(0, productCategories.length);
    renderProductCategories();
  };
  document.querySelector("#open-product-form").addEventListener("click", () => {
    resetProductForm();
    openProductPanel();
  });
  document.querySelector("#close-product-form").addEventListener("click", closeProductPanel);
  document.querySelector("#add-product-category").addEventListener("click", () => {
    const select = document.querySelector("#product-category-select");
    const value = String(select.value || "").trim();
    if (value && !productCategories.includes(value)) productCategories.push(value);
    select.value = "";
    renderProductCategories();
  });
  document.querySelectorAll(".edit-product").forEach((button) => button.addEventListener("click", () => {
    productForm.querySelector('[name="editing"]').value = "true";
    productSku.value = button.dataset.sku;
    productSku.readOnly = true;
    productForm.querySelector('[name="nome"]').value = button.dataset.name;
    productForm.querySelector('[name="qtd_total"]').value = button.dataset.qty;
    productForm.querySelector('[name="ativo"]').value = button.dataset.active === "true" ? "true" : "false";
    productCategories.splice(0, productCategories.length, ...String(button.dataset.categories || "").split("|").filter(Boolean));
    renderProductCategories();
    productTitle.textContent = `Editar produto: ${button.dataset.name}`;
    cancelProductEdit.classList.remove("hidden");
    openProductPanel();
  }));
  document.querySelectorAll(".toggle-product-active").forEach((button) => button.addEventListener("click", async () => {
    const nextActive = button.dataset.active !== "true";
    await request("/api/admin/products", {
      method: "PATCH",
      body: JSON.stringify({
        sku: button.dataset.sku,
        nome: button.dataset.name,
        qtd_total: button.dataset.qty,
        ativo: nextActive,
        categorias: String(button.dataset.categories || "").split("|").filter(Boolean)
      })
    });
    toast(nextActive ? "Produto ativado." : "Produto inativado.");
    await loadBootstrap();
    route("products");
  }));
  cancelProductEdit.addEventListener("click", resetProductForm);
  renderProductCategories();
  productForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = Object.fromEntries(formData);
    const editing = Boolean(form.editing);
    form.ativo = form.ativo === "true";
    form.categorias = formData.getAll("categorias");
    delete form.editing;
    await request("/api/admin/products", { method: editing ? "PATCH" : "POST", body: JSON.stringify(form) });
    toast(editing ? "Produto atualizado." : "Produto salvo.");
    await loadBootstrap();
    route("products");
  });

  const categoryList = document.querySelector("#category-panel-list");
  const categoryForm = document.querySelector("#category-form");
  const categoryNameInput = categoryForm.querySelector("input[name='nome']");
  const categoryCurrentInput = categoryForm.querySelector("input[name='atual']");
  const cancelCategoryEdit = document.querySelector("#cancel-category-edit");
  const saveCategoryBtn = document.querySelector("#save-category-btn");
  let selectedCategoryName = "";
  let showCategoryAvailableProducts = false;
  const resetCategoryForm = () => {
    categoryCurrentInput.value = "";
    categoryNameInput.value = "";
    categoryNameInput.placeholder = "Nova categoria";
    cancelCategoryEdit.classList.add("hidden");
    saveCategoryBtn.textContent = "Salvar categoria";
  };
  const addCategoryProduct = async (button) => {
    const sku = button?.dataset?.sku || "";
    const categoria = button?.dataset?.category || selectedCategoryName;
    if (!sku || !categoria) return;
    try {
      await request("/api/admin/category-products", {
        method: "POST",
        body: JSON.stringify({ sku, categoria })
      });
      toast("Produto adicionado a categoria.");
      await loadBootstrap();
      await renderCategories();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  const removeCategoryProduct = async (button) => {
    const sku = button?.dataset?.sku || "";
    if (!sku || !selectedCategoryName) return;
    try {
      await request("/api/admin/category-products", {
        method: "POST",
        body: JSON.stringify({ sku, categoria: selectedCategoryName, action: "remove" })
      });
      toast("Produto removido da categoria.");
      await loadBootstrap();
      await renderCategories();
    } catch (error) {
      toast(error.message, "error");
    }
  };
  window.__acAddCategoryProduct = addCategoryProduct;
  window.__acRemoveCategoryProduct = removeCategoryProduct;
  const categoryActionHandler = (event) => {
    const addButton = event.target.closest?.(".add-category-product");
    if (addButton) {
      event.preventDefault();
      event.stopPropagation();
      addCategoryProduct(addButton);
      return;
    }

    const removeButton = event.target.closest?.(".remove-category-product");
    if (removeButton) {
      event.preventDefault();
      event.stopPropagation();
      removeCategoryProduct(removeButton);
    }
  };
  document.addEventListener("click", categoryActionHandler, true);
  const renderCategories = async () => {
    const panelData = await request("/api/admin/categories");
    const categoryKey = (value) => String(value || "").trim().toUpperCase();
    const productCategories = (product) => Array.isArray(product.categorias)
      ? product.categorias.map(categoryKey).filter(Boolean)
      : String(product.categoria || "").split(",").map(categoryKey).filter(Boolean);
    const categoryLabel = (product) => productCategories(product).join(", ");
    const categoryProducts = panelData.products && panelData.products.length ? panelData.products : (await request("/api/admin/products")).products || [];
    const categories = panelData.categories || state.categories.map((nome) => ({ nome, produtos: 0, pdvs: 0 }));
    if (selectedCategoryName && !categories.some((category) => categoryKey(category.nome) === categoryKey(selectedCategoryName))) {
      selectedCategoryName = "";
      showCategoryAvailableProducts = false;
    }
    const selectedCategory = categories.find((category) => categoryKey(category.nome) === categoryKey(selectedCategoryName));
    const selectedKey = categoryKey(selectedCategory?.nome);
    const assigned = selectedCategory ? categoryProducts.filter((product) => productCategories(product).includes(selectedKey)) : [];
    const centralProducts = selectedCategory ? categoryProducts : [];
    categoryForm.classList.toggle("hidden", Boolean(selectedCategory));
    categoryList.innerHTML = selectedCategory
      ? `
        <section class="category-detail category-detail-screen">
          <div class="category-detail-head">
            <div>
              <p class="eyebrow">Produtos da categoria</p>
              <h3 class="section-title text-xl font-black">${esc(selectedCategory.nome)}</h3>
              <p class="text-sm text-slate-500">${assigned.length} produto(s) vinculado(s)</p>
            </div>
            <div class="category-row-actions">
              <button class="btn secondary" type="button" id="toggle-category-products">
                ${showCategoryAvailableProducts ? "Fechar produtos" : "Adicionar produtos"}
              </button>
              <button class="btn secondary" type="button" id="back-category-list">Voltar</button>
            </div>
          </div>
          <section class="category-settings">
            <div>
              <p class="eyebrow">Configuração da categoria</p>
              <h4>Editar dados</h4>
            </div>
            <div class="category-settings-form">
              <input id="selected-category-name" value="${esc(selectedCategory.nome)}" />
              <button class="btn secondary update-category-btn" type="button" data-current="${esc(selectedCategory.nome)}">Salvar nome</button>
                  <button class="btn danger delete-category-btn" type="button" data-name="${esc(selectedCategory.nome)}">Excluir categoria</button>
            </div>
          </section>
          ${showCategoryAvailableProducts ? `
            <div class="category-product-list category-available-list">
              <div class="category-product-list-head">
                <strong>Adicionar produtos</strong>
                    <input class="category-available-search" type="search" placeholder="Pesquisar produto disponível" />
              </div>
              <div class="category-add-list category-check-list">
                ${centralProducts.length ? centralProducts.map((product) => `
                  <div class="category-add-row category-available-row" data-search="${esc(`${product.sku} ${product.nome} ${categoryLabel(product)} ${product.origem || "manual"}`.toLowerCase())}">
                    <label class="category-check-cell">
                      <input class="category-product-check" type="checkbox" value="${esc(product.sku)}" ${productCategories(product).includes(selectedKey) ? "checked disabled" : ""}>
                    </label>
                    <span class="category-add-sku">${esc(product.sku)}</span>
                    <strong>${esc(product.nome)}</strong>
                    <span>${esc(categoryLabel(product) || "-")}</span>
                    <span>${esc(product.origem || "manual")}</span>
                    ${productCategories(product).includes(selectedKey) ? `<span class="status">Vinculado</span>` : `<span class="status">Disponível</span>`}
                  </div>`).join("") : `<p class="text-sm text-slate-500">Nenhum produto cadastrado no estoque central.</p>`}
              </div>
              <div class="category-save-row">
                <span id="category-selected-count">0 produto(s) selecionado(s)</span>
                <button class="btn" id="save-category-products" type="button">Salvar produtos</button>
              </div>
            </div>`
          : ""}
          <div class="category-product-list">
            <div class="category-product-list-head">
              <strong>Produtos vinculados</strong>
              <input class="category-product-search" type="search" placeholder="Pesquisar produto" />
            </div>
            <div class="category-product-table">
              ${assigned.length ? table(["SKU", "Produto", "Origem", "Ação"], assigned.map((product) => `
                <tr class="category-product-row" data-search="${esc(`${product.sku} ${product.nome} ${product.origem || "manual"}`.toLowerCase())}">
                  <td>${esc(product.sku)}</td>
                  <td>${esc(product.nome)}</td>
                  <td>${esc(product.origem || "manual")}</td>
                  <td><button class="icon-action danger remove-category-product" type="button" data-sku="${esc(product.sku)}" onclick="window.__acRemoveCategoryProduct?.(this)" title="Remover produto" aria-label="Remover produto">&times;</button></td>
                </tr>`)) : `<p class="text-sm text-slate-500">Nenhum produto nesta categoria.</p>`}
            </div>
          </div>
        </section>`
      : categories.length
        ? `
          <div class="category-list-summary">
            ${categories.map((category) => `
            <div class="category-row category-row-button" data-open-category-row="${esc(category.nome)}" role="button" tabindex="0">
              <div class="category-row-head">
                <div>
                  <strong>${esc(category.nome)}</strong>
                  <span>${category.produtos} produto(s) | ${category.pdvs} PDV(s)</span>
                </div>
                <button class="category-row-open" type="button" data-open-category="${esc(category.nome)}">Abrir</button>
              </div>
            </div>`).join("")}
          </div>`
        : `<p class="text-sm text-slate-500">Nenhuma categoria cadastrada ainda.</p>`;
    const openCategory = async (categoryName) => {
      if (!categoryName) return;
      selectedCategoryName = categoryName;
      showCategoryAvailableProducts = false;
      await renderCategories();
    };
    document.querySelectorAll("[data-open-category]").forEach((button) => button.addEventListener("click", async () => {
      await openCategory(button.dataset.openCategory);
    }));
    document.querySelectorAll("[data-open-category-row]").forEach((row) => {
      row.addEventListener("click", async (event) => {
        if (event.target.closest("[data-open-category]")) return;
        await openCategory(row.dataset.openCategoryRow);
      });
      row.addEventListener("keydown", async (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        await openCategory(row.dataset.openCategoryRow);
      });
    });
    document.querySelector("#back-category-list")?.addEventListener("click", async () => {
      selectedCategoryName = "";
      showCategoryAvailableProducts = false;
      await renderCategories();
    });
    document.querySelector("#toggle-category-products")?.addEventListener("click", async () => {
      showCategoryAvailableProducts = !showCategoryAvailableProducts;
      await renderCategories();
    });
    document.querySelector(".category-product-search")?.addEventListener("input", (event) => {
      const term = String(event.target.value || "").trim().toLowerCase();
      document.querySelectorAll(".category-product-row").forEach((row) => {
        row.classList.toggle("hidden", term && !row.dataset.search.includes(term));
      });
    });
    document.querySelector(".category-available-search")?.addEventListener("input", (event) => {
      const term = String(event.target.value || "").trim().toLowerCase();
      document.querySelectorAll(".category-available-row").forEach((row) => {
        row.classList.toggle("hidden", term && !row.dataset.search.includes(term));
      });
    });
    const updateCategorySelectedCount = () => {
      const total = document.querySelectorAll(".category-product-check:not(:disabled):checked").length;
      const label = document.querySelector("#category-selected-count");
      if (label) label.textContent = `${total} produto(s) selecionado(s)`;
    };
    document.querySelectorAll(".category-product-check").forEach((checkbox) => checkbox.addEventListener("change", updateCategorySelectedCount));
    updateCategorySelectedCount();
    document.querySelector("#save-category-products")?.addEventListener("click", async () => {
      const skus = [...document.querySelectorAll(".category-product-check:not(:disabled):checked")].map((checkbox) => checkbox.value);
      if (!skus.length) {
        toast("Selecione pelo menos um produto.", "error");
        return;
      }
      await request("/api/admin/category-products", {
        method: "POST",
        body: JSON.stringify({ skus, categoria: selectedCategoryName })
      });
      toast(`${skus.length} produto(s) adicionados a categoria.`);
      await loadBootstrap();
      await renderCategories();
    });
    document.querySelector(".update-category-btn")?.addEventListener("click", async (event) => {
      const input = document.querySelector("#selected-category-name");
      const nextName = String(input?.value || "").trim();
      if (!nextName) return;
      await request("/api/admin/categories", {
        method: "PATCH",
        body: JSON.stringify({ atual: event.currentTarget.dataset.current, nome: nextName })
      });
      toast("Categoria atualizada.");
      selectedCategoryName = nextName;
      await loadBootstrap();
      await renderCategories();
    });
    document.querySelector(".delete-category-btn")?.addEventListener("click", async (event) => {
      const confirmed = await confirmSystem({
        title: "Excluir categoria",
        message: `Excluir a categoria ${event.currentTarget.dataset.name}?`,
        consequence: "Essa ação não altera o estoque central, mas remove a organização da categoria.",
        confirmLabel: "Excluir",
        danger: true
      });
      if (!confirmed) return;
      await request("/api/admin/categories", { method: "DELETE", body: JSON.stringify({ nome: event.currentTarget.dataset.name }) });
      toast("Categoria excluída.");
      selectedCategoryName = "";
      showCategoryAvailableProducts = false;
      await loadBootstrap();
      await renderCategories();
    });
  };
  cancelCategoryEdit.addEventListener("click", resetCategoryForm);
  categoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const isEditing = Boolean(form.atual);
    await request("/api/admin/categories", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(form)
    });
    toast(isEditing ? "Categoria atualizada." : "Categoria cadastrada.");
    await loadBootstrap();
    resetCategoryForm();
    await renderCategories();
  });
  await renderCategories();
  startAutoRefresh("products", async () => {
    const activeTab = document.querySelector("[data-product-tab].is-active")?.dataset.productTab || "manual";
    if (activeTab === "categories") return;
    if (!document.querySelector("#product-form-panel")?.classList.contains("hidden")) return;
    if (!document.querySelector("#central-category-filter-menu")?.classList.contains("hidden")) return;
    if (!document.querySelector("#sheet-actions-menu")?.classList.contains("hidden")) return;
    await viewProductsV2({ auto: true });
  }, 12000);
}

// View de estoque geral
async function viewStock() {
  const pdvId = state.pdvs[0]?.id || 0;
  const data = pdvId ? await request(`/api/admin/stock?pdvId=${pdvId}`) : { stock: [], pdv: null };
  shell(`
    <section class="card">
      <div class="mb-3 grid gap-3 md:grid-cols-[1fr_auto]">
        <select id="stock-pdv">${state.pdvs.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join("")}</select>
        <button class="btn secondary" id="print-stock-pdv" type="button">Imprimir estoque</button>
        <button class="btn" id="save-stock">Salvar configurações</button>
      </div>
      <div class="config-tabs stock-view-tabs" role="tablist" aria-label="Lista do estoque PDV">
        <button class="config-tab is-active" type="button" data-stock-view="stock">Produtos em estoque</button>
        <button class="config-tab" type="button" data-stock-view="categories">Categorias permitidas</button>
      </div>
      <div class="stock-category-note"></div>
      <div id="stock-table"></div>
    </section>`);

  let stockView = "stock";
  let currentPayload = data;
  const render = (payload) => {
    currentPayload = payload;
    const stock = payload.stock || [];
    const currentCategories = payload.pdv?.categorias?.length ? payload.pdv.categorias.join(", ") : "";
    document.querySelector(".stock-category-note").innerHTML = stockView === "categories"
      ? "Categorias liberadas para este ponto solicitar produtos."
      : currentCategories
        ? `Mostrando somente produtos com quantidade no estoque do PDV. Categorias permitidas: <strong>${esc(currentCategories)}</strong>`
        : "Este PDV ainda não possui categorias permitidas.";
    if (stockView === "categories") {
      document.querySelector("#stock-table").innerHTML = payload.pdv?.categorias?.length
        ? `<div class="category-picker-list">${payload.pdv.categorias.map((category) => `<span class="category-chip selected-chip">${esc(category)}</span>`).join("")}</div>`
        : `<p class="text-sm text-slate-500">Nenhuma categoria permitida para este PDV.</p>`;
      return;
    }
    const stocked = stock.filter((s) => Number(s.quantidade) > 0);
    document.querySelector("#stock-table").innerHTML = table(["Produto", "Categoria", "Estoque central", "Atual manual", "Saldo OMIE", "Reservado", "Disponível", "Sincronização", "Min", "Max"], stocked.map((s) => `
      <tr data-sku="${esc(s.sku)}">
        <td>${esc(s.nome)}</td>
        <td>${esc(s.categoria || "-")}</td>
        <td class="release-number-cell">${centralStockValue(s)}</td>
        <td><input class="quantidade" type="number" value="${s.quantidade}"></td>
        <td>${Number(s.saldo_omie ?? s.quantidade ?? 0)}</td>
        <td>${Number(s.quantidade_reservada_acpark || 0)}</td>
        <td>${Number(s.saldo_disponivel_acpark ?? s.quantidade ?? 0)}</td>
        <td>${s.ultima_sincronizacao ? moneyDate(s.ultima_sincronizacao) : esc(s.sincronizacao_status || "Manual")}</td>
        <td><input class="minimo" type="number" value="${s.estoque_minimo}"></td>
        <td><input class="maximo" type="number" value="${s.estoque_maximo}"></td>
      </tr>`));
  };
  render(data);
  document.querySelectorAll("[data-stock-view]").forEach((button) => button.addEventListener("click", () => {
    stockView = button.dataset.stockView;
    document.querySelectorAll("[data-stock-view]").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.stockView === stockView));
    document.querySelector("#save-stock").classList.toggle("hidden", stockView !== "stock");
    render(currentPayload);
  }));
  document.querySelector("#stock-pdv").addEventListener("change", async (event) => {
    const fresh = await request(`/api/admin/stock?pdvId=${event.target.value}`);
    render(fresh);
  });
  document.querySelector("#save-stock").addEventListener("click", async () => {
    const items = [...document.querySelectorAll("#stock-table tbody tr")].map((tr) => ({
      sku: tr.dataset.sku,
      permitido: true,
      quantidade: tr.querySelector(".quantidade").value,
      estoque_minimo: tr.querySelector(".minimo").value,
      estoque_maximo: tr.querySelector(".maximo").value
    }));
    await request("/api/admin/stock", { method: "POST", body: JSON.stringify({ pdvId: document.querySelector("#stock-pdv").value, items }) });
    toast("Estoque do PDV atualizado.");
  });
  document.querySelector("#print-stock-pdv").addEventListener("click", async () => {
    printStockPdv(currentPayload);
  });
}

// Dispara a impressão do estoque do PDV
async function printStockPdv(payload = {}) {
  const pdv = payload.pdv || {};
  const stock = (payload.stock || []).filter((item) => Number(item.quantidade || 0) > 0);
  const rows = stock.map((item) => `
    <tr>
      <td>${esc(item.sku || "")}</td>
      <td>${esc(item.nome || "")}</td>
      <td>${esc(item.categoria || "-")}</td>
      <td>${centralStockValue(item)}</td>
      <td>${Number(item.quantidade || 0)}</td>
      <td>${Number(item.estoque_minimo || 0)}</td>
      <td>${Number(item.estoque_maximo || 0)}</td>
    </tr>`).join("");
  const target = document.createElement("section");
  target.className = "stock-print-target";
  target.innerHTML = `
    <div class="print-logo-header">
      <img src="/logo-print.png" alt="Águas Correntes Park" />
      <div>
        <p class="eyebrow">Águas Correntes Park</p>
        <h1>Estoque do PDV</h1>
        <p><strong>Ponto:</strong> ${esc(pdv.nome || "-")} | <strong>Emitido em:</strong> ${moneyDate(new Date().toISOString())}</p>
        <p><strong>Categorias permitidas:</strong> ${esc((pdv.categorias || []).join(", ") || "-")}</p>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>SKU</th>
          <th>Produto</th>
          <th>Categoria</th>
          <th>Estoque central</th>
          <th>Estoque PDV</th>
          <th>Min</th>
          <th>Max</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="7">Nenhum produto com quantidade no estoque deste PDV.</td></tr>`}</tbody>
    </table>
  `;
  document.body.appendChild(target);
  document.body.classList.add("printing-stock");
  await waitForPrintReady(target);
  window.print();
  schedulePrintCleanup(() => {
    document.body.classList.remove("printing-stock");
    target.remove();
  });
}

// View de liberação de pedidos (Kanban)
async function viewRelease(filters = {}) {
  let from = filters.from || weekAgo();
  let to = filters.to || today();
  let selectedPdvId = filters.pdvId || document.querySelector("#release-pdv-filter")?.value || "";
  let searchCode = filters.q || document.querySelector("#release-code-filter")?.value || "";
  const releaseMode = filters.mode || document.querySelector("[data-release-view-mode].is-active")?.dataset.releaseViewMode || "active";
  const finalizedOffset = Number(filters.offset || 0);
  if (from && to && from > to) {
    toast("A data inicial não pode ser posterior à data final.", "error");
    [from, to] = [to, from];
  }
  const statuses = releaseKanbanStatuses;
  const statusLabels = orderStatusLabels;
  const params = new URLSearchParams({ from, to, limit: "80" });
  if (releaseMode === "finalized") {
    params.set("status", "Finalizado");
    params.set("offset", String(finalizedOffset));
  } else {
    params.set("active", "1");
  }
  if (selectedPdvId) params.set("pdvId", selectedPdvId);
  if (searchCode) params.set("q", searchCode);
  let data;
  let loadError = null;
  try {
    data = await request(`/api/admin/orders?${params.toString()}`, {
      loadingMessage: filters.auto ? "Atualizando solicitações..." : releaseMode === "finalized" ? "Carregando pedidos finalizados..." : "Carregando Liberações...",
      silentLoading: Boolean(filters.auto)
    });
  } catch (error) {
    console.error("Erro ao carregar Liberação:", {
      message: error?.message,
      status: error?.status,
      details: error?.details
    });
    if (filters.auto) return;
    loadError = error;
    toast("Não foi possível carregar os pedidos. Tente novamente.", "error");
    data = { orders: [] };
  }
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const grouped = Object.values(orders.reduce((acc, row) => {
    const key = orderGroupKey(row);
    acc[key] ||= [];
    acc[key].push(row);
    return acc;
  }, {}));
  const byStatus = statuses.reduce((acc, status) => {
    acc[status] = orderGroupsForStatus(grouped, status);
    return acc;
  }, {});
  const allGroupsByKey = new Map(grouped.map((group) => [orderGroupKey(group[0] || {}), group]));
  if (filters.auto) {
    if (releaseMode !== "active") return;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    updateReleaseCounters(byStatus);
    syncReleaseKanbanBoard(byStatus, from, to, selectedPdvId, searchCode);
    window.scrollTo(scrollX, scrollY);
    return;
  }
  const finalizedGroups = releaseMode === "finalized" ? sortOrderGroupsNewest(grouped) : [];
  shell(`
    <section class="release-screen">
      <section class="card release-filter-card">
        <form id="release-filter" class="filter-panel release-filter">
          <div class="filter-copy">
            <p class="eyebrow">Filtro</p>
            <h3 class="section-title text-xl font-black">Liberação de pedidos</h3>
            <p>Filtre por período e ponto de venda sem perder a aba selecionada.</p>
          </div>
          <label class="field-date">De
            <input name="from" type="date" value="${esc(from)}" />
          </label>
          <label class="field-date">Até
            <input name="to" type="date" value="${esc(to)}" />
          </label>
          <label class="field-select">Ponto de Venda
            <select name="pdvId" id="release-pdv-filter">
              <option value="">Todos os PDVs</option>
              ${(state.pdvs || []).map((pdv) => `<option value="${pdv.id}" ${String(pdv.id) === String(selectedPdvId) ? "selected" : ""}>${esc(pdv.nome)}</option>`).join("")}
            </select>
          </label>
          <label class="field-wide">Código do pedido
            <input name="q" id="release-code-filter" type="search" value="${esc(searchCode)}" placeholder="Ex: 67F1" autocomplete="off" />
          </label>
          <div class="filter-actions">
            <button class="btn" type="submit">Filtrar</button>
          </div>
        </form>
      </section>

      <div class="release-tabs-row">
        <div class="config-tabs release-tabs release-mode-tabs" role="tablist" aria-label="Visualização da liberação">
          <button class="config-tab ${releaseMode === "active" ? "is-active" : ""}" data-release-view-mode="active" type="button">Pedidos ativos</button>
          <button class="config-tab ${releaseMode === "finalized" ? "is-active" : ""}" data-release-view-mode="finalized" type="button">Finalizados</button>
        </div>
        <button class="btn secondary release-refresh" id="refresh-release" type="button">Atualizar solicitações</button>
      </div>

      ${releaseMode === "finalized" ? `
        <section class="card release-finalized-view" id="release-finalized-view">
          <div class="release-finalized-head">
            <div>
              <p class="eyebrow">Finalizados</p>
              <h3 class="section-title text-lg font-black">Pedidos finalizados</h3>
              <p>Esta lista carrega separada do quadro ativo para evitar lentidão.</p>
            </div>
            <button class="btn secondary" id="back-release-active" type="button">Voltar aos pedidos ativos</button>
          </div>
          <div class="release-finalized-list" id="release-finalized-list" aria-live="polite">
            ${loadError
              ? `<div class="card release-error-state"><strong>Não foi possível carregar os finalizados.</strong><p>Tente novamente mantendo os filtros atuais.</p><button class="btn secondary retry-release" type="button">Tentar novamente</button></div>`
              : finalizedGroups.map((group) => releaseFinalizedCard(group)).join("") || `<div class="card release-empty-state">Não há pedidos finalizados para os filtros selecionados.</div>`}
          </div>
          ${!loadError && orders.length >= 80 ? `<button class="btn secondary load-more-finalized" type="button" data-next-offset="${finalizedOffset + 80}">Carregar mais finalizados</button>` : ""}
        </section>
      ` : `
        <div class="config-tabs release-tabs release-kanban-summary" role="list" aria-label="Resumo dos pedidos ativos">
          ${statuses.map((status) => `
            <span class="config-tab release-summary-pill" data-release-status="${esc(status)}" role="listitem">
              ${esc(statusLabels[status] || status)} <span data-release-count="${esc(status)}">${byStatus[status].length}</span>
            </span>`).join("")}
        </div>
        <section class="release-kanban-board" id="release-kanban-board" aria-label="Quadro de pedidos ativos">
          ${loadError
            ? `<div class="card release-error-state"><strong>Não foi possível carregar os pedidos.</strong><p>Tente novamente mantendo os filtros atuais.</p><button class="btn secondary retry-release" type="button">Tentar novamente</button></div>`
            : statuses.map((status) => releaseKanbanColumn(status, byStatus[status] || [])).join("")}
        </section>
      `}

      <div class="release-detail-panel" id="release-detail-panel" aria-live="polite"></div>
    </section>`);
  document.querySelector("#release-filter").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await viewRelease({ ...form, mode: releaseMode });
  });
  document.querySelector("#refresh-release").addEventListener("click", async () => {
    const btn = document.querySelector("#refresh-release");
    btn.disabled = true;
    const previousText = btn.textContent;
    btn.textContent = "Atualizando solicitações...";
    try {
      await viewRelease({ from, to, pdvId: selectedPdvId, q: searchCode, mode: releaseMode, offset: releaseMode === "finalized" ? finalizedOffset : 0 });
    } finally {
      btn.disabled = false;
      btn.textContent = previousText;
    }
  });
  document.querySelector(".retry-release")?.addEventListener("click", async () => {
    await viewRelease({ from, to, pdvId: selectedPdvId, q: searchCode, mode: releaseMode, offset: finalizedOffset });
  });
  document.querySelectorAll("[data-release-view-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      await viewRelease({ from, to, pdvId: selectedPdvId, q: searchCode, mode: button.dataset.releaseViewMode });
    });
  });
  document.querySelector("#back-release-active")?.addEventListener("click", async () => {
    await viewRelease({ from, to, pdvId: selectedPdvId, q: searchCode, mode: "active" });
  });
  document.querySelector(".load-more-finalized")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    const nextOffset = Number(button.dataset.nextOffset || 0);
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "Carregando...";
    try {
      const moreParams = new URLSearchParams({ from, to, status: "Finalizado", limit: "80", offset: String(nextOffset) });
      if (selectedPdvId) moreParams.set("pdvId", selectedPdvId);
      if (searchCode) moreParams.set("q", searchCode);
      const moreData = await request(`/api/admin/orders?${moreParams.toString()}`, { silentLoading: true });
      const moreOrders = Array.isArray(moreData?.orders) ? moreData.orders : [];
      const moreGroups = sortOrderGroupsNewest(Object.values(moreOrders.reduce((acc, row) => {
        const key = orderGroupKey(row);
        acc[key] ||= [];
        acc[key].push(row);
        return acc;
      }, {})));
      const list = document.querySelector("#release-finalized-list");
      const moreGroupsByKey = new Map(moreGroups.map((group) => [orderGroupKey(group[0] || {}), group]));
      moreGroups.forEach((group) => list?.insertAdjacentHTML("beforeend", releaseFinalizedCard(group)));
      bindReleaseFinalizedList(from, to, selectedPdvId, searchCode, moreGroupsByKey);
      if (!moreData?.hasMore || moreGroups.length === 0) {
        button.remove();
      } else {
        button.dataset.nextOffset = String(nextOffset + 80);
        button.disabled = false;
        button.textContent = previousText;
      }
    } catch (error) {
      toast(error.message || "Não foi possível carregar mais finalizados.", "error");
      button.disabled = false;
      button.textContent = previousText;
    }
  });
  if (releaseMode === "finalized") {
    bindReleaseFinalizedList(from, to, selectedPdvId, searchCode, allGroupsByKey, finalizedOffset);
    stopAutoRefresh("release");
  } else {
    bindReleaseKanban(from, to, selectedPdvId, searchCode, allGroupsByKey);
    focusReleaseOrderFromAlert({ from, to, pdvId: selectedPdvId, q: searchCode, status: "Pendente", focusRetry: filters.focusRetry });
    startAutoRefresh("release", async () => {
      if (document.body.classList.contains("printing-receipt")) return;
      if (document.querySelector("[data-release-view-mode].is-active")?.dataset.releaseViewMode !== "active") return;
      const currentPdvId = document.querySelector("#release-pdv-filter")?.value || selectedPdvId;
      const currentSearchCode = document.querySelector("#release-code-filter")?.value || searchCode;
      await viewRelease({ from, to, pdvId: currentPdvId, q: currentSearchCode, mode: "active", auto: true });
    }, 5000, { ignoreEditing: true });
  }
}

// Foca um pedido específico na tela de liberação a partir de um alerta
async function focusReleaseOrderFromAlert(context = {}) {
  const orderCode = sessionStorage.getItem("acparkFocusReleaseOrder");
  if (!orderCode) return;
  const card = document.querySelector(`[data-order="${CSS.escape(orderCode)}"]`);
  if (!card) {
    if (context.focusRetry) return;
    const showAll = await confirmSystem({
      title: "Pedido fora dos filtros",
      message: "Este pedido está fora dos filtros atuais.",
      consequence: "Você pode visualizar todos os pendentes sem aplicar o código do pedido como filtro.",
      cancelLabel: "Manter filtros",
      confirmLabel: "Visualizar todos os pendentes"
    });
    if (showAll) {
      await viewRelease({ from: context.from, to: context.to, pdvId: "", q: "", status: "Pendente", focusRetry: true });
    }
    return;
  }
  sessionStorage.removeItem("acparkFocusReleaseOrder");
  card.classList.add("order-alert-focus");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => card.classList.remove("order-alert-focus"), 4500);
}

// Liga as interações gerais da tela de liberação
// Atualiza o painel do pedido em tela cheia após uma edição de itens (excluir, adicionar),
// sem fechar o painel. Se o card não estiver dentro de um painel (uso futuro fora dele),
// simplesmente não faz nada, para não quebrar em outro contexto.
async function refreshReleasePanelAfterEdit(card, context = {}) {
  const overlay = card?.closest(".release-detail-overlay");
  if (!overlay) return false;
  await reloadReleasePanel(overlay, card.dataset.order || "", context);
  return true;
}

function bindReleaseInteractions(from, to, activeStatus, root = document, pdvId = "", q = "") {
  bindOrderToggles(root);
  root.querySelectorAll(".print-order").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
    const card = btn.closest("[data-order]");
    printOrder(card);
    });
  });
  root.querySelectorAll(".delete-order").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", async () => {
      const card = btn.closest("[data-order]");
      const orderCode = card?.dataset.order || "";
      await deleteReleaseOrderByCode(orderCode, btn);
    });
  });
  root.querySelectorAll(".bulk-order-item").forEach((input) => {
    if (input.dataset.bound === "true") return;
    input.dataset.bound = "true";
    input.addEventListener("change", () => {
      const row = input.closest("tr");
      row?.classList.toggle("is-selected-for-delete", input.checked);
      updateReleaseBulkActions(input.closest("[data-order]"));
    });
  });
  root.querySelectorAll(".delete-selected-order-items").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", async () => {
      const card = btn.closest("[data-order]");
      const rows = releaseSelectedItemRows(card);
      const selectedItems = releaseSelectedItemsSummary(rows);
      if (!card || !selectedItems.length) return;
      const detailsHtml = `<ul class="system-confirm-list">${selectedItems.map((item) => `
        <li><strong>${esc(item.produto)}</strong><span>Solicitado: ${esc(item.quantidade)} | Liberado: ${esc(item.liberada)}</span></li>`).join("")}</ul>`;
      const confirmed = await confirmSystem({
        title: "Excluir produtos selecionados",
        message: `${selectedItems.length} produto${selectedItems.length === 1 ? "" : "s"} será${selectedItems.length === 1 ? "" : "ão"} removido${selectedItems.length === 1 ? "" : "s"} deste pedido.`,
        detailsHtml,
        consequence: "Somente os produtos listados serão excluídos. Os demais itens do pedido serão mantidos.",
        confirmLabel: "Excluir selecionados",
        danger: true
      });
      if (!confirmed) return;
      const previousText = btn.textContent;
      btn.disabled = true;
      btn.classList.add("is-processing");
      btn.textContent = "Excluindo...";
      try {
        try {
          await request("/api/admin/order-items", {
            method: "DELETE",
            body: JSON.stringify({
              codigo_pedido: card.dataset.order || "",
              status: card.dataset.orderStatus || "",
              items: selectedItems.map((item) => ({ id: item.id, version: item.version }))
            })
          });
        } catch (error) {
          if (error.status !== 404) throw error;
          for (const item of selectedItems) {
            await request("/api/admin/order-item", {
              method: "DELETE",
              body: JSON.stringify({
                id: item.id,
                version: item.version,
                codigo_pedido: card.dataset.order || "",
                status: card.dataset.orderStatus || ""
              })
            });
          }
        }
        removeReleaseDraftItems(card.dataset.order, selectedItems.map((item) => item.id));
        toast(`${selectedItems.length} produto${selectedItems.length === 1 ? "" : "s"} excluído${selectedItems.length === 1 ? "" : "s"} do pedido.`);
        // Atualiza o painel em tela cheia sem fechá-lo; o quadro ao fundo é só sincronizado (leve)
        const atualizouPainel = await refreshReleasePanelAfterEdit(card, { from, to, pdvId, q });
        if (!atualizouPainel) await viewRelease({ from, to, pdvId, q, status: activeStatus });
        else viewRelease({ from, to, pdvId, q, status: activeStatus, auto: true }).catch(() => {});
      } catch (error) {
        toast(error.message || "Não foi possível excluir os produtos selecionados.", "error");
      } finally {
        btn.classList.remove("is-processing");
        btn.disabled = false;
        btn.textContent = previousText;
        updateReleaseBulkActions(card);
      }
    });
  });
  root.querySelectorAll(".delete-order-item").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", async () => {
      const card = btn.closest("[data-order]");
      const row = btn.closest("tr");
      const itemId = row?.dataset.id || "";
      const version = row?.dataset.version || "";
      const productName = row?.querySelector(".release-product-name")?.textContent?.trim() || "este produto";
      if (!itemId || !card) return;
      const confirmed = await confirmSystem({
        title: "Excluir produto",
        message: `Deseja excluir ${productName} deste pedido?`,
        consequence: "Somente este produto será removido. Os demais itens do pedido serão mantidos.",
        confirmLabel: "Excluir produto",
        danger: true
      });
      if (!confirmed) return;
      try {
        await request("/api/admin/order-item", {
          method: "DELETE",
          body: JSON.stringify({
            id: itemId,
            version,
            codigo_pedido: card.dataset.order || "",
            status: card.dataset.orderStatus || ""
          })
        });
        removeReleaseDraftItems(card.dataset.order, [itemId]);
        toast("Produto excluído do pedido.");
        // O painel se atualiza sozinho a partir dos dados do servidor — sem remover nós na mão,
        // o que antes podia apagar o painel inteiro ao excluir o último produto
        const atualizouPainel = await refreshReleasePanelAfterEdit(card, { from, to, pdvId, q });
        if (!atualizouPainel) {
          row.remove();
          await viewRelease({ from, to, pdvId, q, status: activeStatus });
        } else {
          viewRelease({ from, to, pdvId, q, status: activeStatus, auto: true }).catch(() => {});
        }
      } catch (error) {
        toast(error.message || "Não foi possível excluir o produto.", "error");
      }
    });
  });
  root.querySelectorAll(".confirm-order-withdrawal-open").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
      openOrderWithdrawalModal(btn.closest("[data-order]"), { from, to, pdvId });
    });
  });
  root.querySelectorAll(".add-almox-product").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
      openAddAlmoxProductModal(btn.closest("[data-order]"), { from, to, pdvId, q, status: activeStatus });
    });
  });
  root.querySelectorAll(".view-order-withdrawal").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
      const card = btn.closest("[data-order]");
      openOrderWithdrawalReceipt({
        orderCode: btn.dataset.order || card?.dataset.order,
        pdv: btn.dataset.pdv,
        responsible: btn.dataset.responsible,
        date: btn.dataset.date,
        user: btn.dataset.user,
        signature: btn.dataset.signature,
        items: orderWithdrawalItemsFromButton(btn, card)
      });
    });
  });
  root.querySelectorAll(".save-release-draft").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => {
      const card = btn.closest("[data-order]");
      if (!card) return;
      saveReleaseDraft(card);
      toast("Rascunho salvo com os valores informados.");
    });
  });
  root.querySelectorAll(".flow").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", async () => {
      await submitOrderFlow(btn, { from, to, pdvId, q });
    });
  });
  bindReleaseDrafts(root);
}

// Envia a mudança de status do pedido com as quantidades informadas na tabela
async function submitOrderFlow(btn, { from, to, pdvId = "", q = "" } = {}) {
  const card = btn?.closest("[data-order]");
  if (!card) return false;
  const previousText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Processando...";
  try {
    if (btn.dataset.fillRequested === "true") {
      card.querySelectorAll("tbody tr").forEach((tr) => {
        const input = tr.querySelector(".liberada");
        const currentValue = Number(String(input?.value || "").replace(",", "."));
        if (input && (!Number.isFinite(currentValue) || currentValue <= 0)) {
          input.value = tr.dataset.requested || input.value;
        }
      });
    }
    const rows = [...card.querySelectorAll("tbody tr")];
    const releaseMode = btn.dataset.releaseMode || "";
    let items = rows.map((tr) => ({
      id: tr.dataset.id,
      version: tr.dataset.version,
      quantidade_liberada: tr.querySelector(".liberada")?.value ?? tr.dataset.released ?? "0",
      remover: Boolean(tr.querySelector(".remover")?.checked)
    })).filter((item) => item.id);
    if (releaseMode === "entered-only" && btn.dataset.status === "Aguardando Retirada") {
      items = items.filter((item) => Number(String(item.quantidade_liberada || "0").replace(",", ".")) > 0);
    }
    // Liberar acima do solicitado é permitido; a tela apenas avisa o almoxarifado
    const excedentes = rows.filter((tr) => {
      const requested = Number(tr.dataset.requested || 0);
      const released = Number(String(tr.querySelector(".liberada")?.value || "0").replace(",", "."));
      return Number.isFinite(released) && requested > 0 && released > requested;
    });
    if (excedentes.length) {
      toast(`Atenção: ${excedentes.length} produto${excedentes.length === 1 ? "" : "s"} com liberação acima do solicitado.`);
    }
    if (!items.length && releaseMode !== "entered-only") {
      try {
        const fallbackItems = JSON.parse(card.dataset.orderItems || "[]");
        items = Array.isArray(fallbackItems)
          ? fallbackItems.map((item) => ({
              id: item.id,
              version: item.version,
              quantidade_liberada: btn.dataset.fillRequested === "true"
                ? item.quantidade_solicitada
                : item.quantidade_liberada || 0,
              remover: false
            })).filter((item) => item.id)
          : [];
      } catch {
        items = [];
      }
    }
    if (!items.length) {
      toast(releaseMode === "entered-only"
        ? "Informe a quantidade que deseja liberar em pelo menos um produto."
        : "Não há produtos disponíveis neste card para alterar o status.", "error");
      return false;
    }
    const nextStatus = btn.dataset.status;
    await request("/api/admin/order-flow", {
      method: "POST",
      body: JSON.stringify({
        codigo_pedido: card.dataset.order || "",
        current_status: card.dataset.orderStatus || "",
        status: nextStatus,
        release_mode: releaseMode,
        items
      })
    });
    clearReleaseDraft(card.dataset.order);
    toast("Pedido atualizado.");
    await viewRelease({ from, to, pdvId, q, status: nextStatus });
    return true;
  } catch (error) {
    if (!String(error.message || "").includes("Conflito")) {
      toast(error.message || "Não foi possível atualizar o pedido.", "error");
    }
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = previousText;
  }
}

// Converte erro de adição de produtos em mensagem amigável
function addProductsFriendlyError(error = {}) {
  const technicalMessage = String(error.data?.error || error.data?.message || error.message || "");
  if (error.status === 404 && technicalMessage.includes("Rota não encontrada")) return "Não foi possível localizar a função de inclusão de produtos. Atualize a página e tente novamente.";
  if (error.status === 404) return technicalMessage || "Não foi possível localizar o pedido ou produto informado.";
  if (error.status === 400) return "Revise os produtos e as quantidades informadas.";
  if (error.status === 403) return "Você não possui permissão para adicionar produtos neste pedido.";
  if (error.status === 409) return "O pedido foi alterado por outro usuário. Atualize os dados antes de continuar.";
  if (error.status >= 500) return "Não foi possível adicionar os produtos ao pedido.";
  if (error.status) return error.message || "Não foi possível adicionar os produtos ao pedido.";
  return "Falha de conexão ao adicionar os produtos. Verifique a rede e tente novamente.";
}

// Envia requisição para adicionar produtos a um pedido existente
async function adicionarProdutosAoPedido({ pedidoId, produtos, idempotencyKey = createIdempotencyKey() }) {
  const url = "/api/admin/orders/add-items";
  const method = "POST";
  if (!pedidoId || ["undefined", "null", "[object Object]"].includes(String(pedidoId))) {
    throw new Error("Não foi possível identificar o pedido.");
  }
  if (!Array.isArray(produtos) || !produtos.length) {
    throw new Error("Inclua ao menos um produto antes de adicionar ao pedido.");
  }
  console.debug("Adicionando produtos ao pedido", {
    pedidoId,
    produtos: produtos.map((item) => ({
      sku: item.sku_produto || item.sku,
      quantidade: item.quantidade_solicitada || item.quantidade
    }))
  });
  try {
    const response = await fetch(url, {
      method,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({
        codigo_pedido: pedidoId,
        items: produtos,
        idempotencyKey
      })
    });
    const data = await response.json().catch(() => ({}));
    console.debug("Resposta ao adicionar produtos", {
      status: response.status,
      data
    });
    if (!response.ok) {
      const error = new Error(data.message || data.error || "Não foi possível adicionar os produtos.");
      error.status = response.status;
      error.data = data;
      error.userMessage = addProductsFriendlyError(error);
      throw error;
    }
    return data;
  } catch (error) {
    if (!error.userMessage) error.userMessage = addProductsFriendlyError(error);
    console.error("Erro ao adicionar produtos", {
      pedidoId,
      url,
      method,
      status: error?.status,
      message: error?.message,
      response: error?.data
    });
    throw error;
  }
}

// Abre o modal de adicionar produtos do almoxarifado ao pedido
function openAddAlmoxProductModal(card, filters = {}) {
  if (!card) return;
  const orderCode = card.dataset.order || "";
  const existingSkus = new Set([...card.querySelectorAll("tbody tr")].map((row) => row.dataset.sku).filter(Boolean));
  const products = (state.products || []).filter((product) => product.ativo !== false && !existingSkus.has(product.sku));
  const modal = document.createElement("div");
  modal.className = "photo-viewer";
  let selectedProduct = null;
  let pendingItems = [];
  const close = () => modal.remove();
  modal.innerHTML = `
    <form class="photo-viewer-dialog integration-modal" id="add-almox-product-form" role="dialog" aria-modal="true" aria-label="Adicionar produto ao pedido">
      <div class="photo-viewer-head">
        <div>
          <p class="eyebrow">Pedido ${esc(orderCode)}</p>
          <h3>Adicionar produto</h3>
        </div>
        <button class="icon-action close-add-almox-product" type="button" aria-label="Fechar">&times;</button>
      </div>
      <label class="grid gap-1 text-sm font-bold">Produto
        <span class="almox-product-search-box">
          <input id="add-almox-product-search" type="search" placeholder="Digite nome ou SKU" autocomplete="off" />
          <span class="almox-product-results" id="add-almox-product-results" role="listbox" aria-label="Produtos encontrados"></span>
        </span>
      </label>
      <label class="grid gap-1 text-sm font-bold">Quantidade
        <input name="quantidade" type="number" min="1" step="1" inputmode="numeric" />
      </label>
      <div class="almox-product-add-actions">
        <button class="btn secondary queue-almox-product" type="button">Incluir na lista</button>
      </div>
      <div class="almox-product-selected-list" id="almox-product-selected-list" aria-live="polite"></div>
      <p class="text-sm text-slate-500">O produto adicionado pelo almoxarifado aparecerá com o selo Almox.</p>
      <div class="form-actions">
        <button class="btn secondary close-add-almox-product" type="button">Cancelar</button>
        <button class="btn" type="submit">Adicionar produtos</button>
      </div>
    </form>`;
  modal.querySelectorAll(".close-add-almox-product").forEach((button) => button.addEventListener("click", close));
  const searchInput = modal.querySelector("#add-almox-product-search");
  const qtyInput = modal.querySelector('[name="quantidade"]');
  const resultsBox = modal.querySelector("#add-almox-product-results");
  const selectedList = modal.querySelector("#almox-product-selected-list");
  const submitButton = modal.querySelector('#add-almox-product-form button[type="submit"]');
  const productLabel = (product) => `${product.nome || ""} - ${product.sku || ""}`.trim();
  const matchesProduct = (product, term) => `${product.sku || ""} ${product.nome || ""}`.toLowerCase().includes(term);
  const availableProducts = () => products.filter((product) => !pendingItems.some((item) => item.sku === product.sku));
  let visibleProducts = [];
  const selectProduct = (product) => {
    selectedProduct = product || null;
    if (!selectedProduct) return;
    searchInput.value = productLabel(selectedProduct);
    resultsBox.classList.remove("is-open");
    resultsBox.innerHTML = "";
  };
  const typedProduct = () => {
    const search = searchInput.value.trim();
    const normalized = search.toLowerCase();
    const candidates = availableProducts();
    return selectedProduct
      || candidates.find((item) => item.sku === search)
      || candidates.find((item) => item.nome?.toLowerCase() === normalized)
      || candidates.find((item) => productLabel(item).toLowerCase() === normalized)
      || (visibleProducts.length === 1 ? visibleProducts[0] : null);
  };
  const renderPendingItems = () => {
    selectedList.innerHTML = pendingItems.length
      ? `<strong>${pendingItems.length} produto${pendingItems.length === 1 ? "" : "s"} para adicionar</strong>
        ${pendingItems.map((item, index) => `
          <div class="almox-product-selected-item">
            <span><b>${esc(item.nome)}</b><small>${esc(item.sku)} | Qtd ${esc(item.quantidade)}</small></span>
            <button class="icon-action remove-pending-almox-product" type="button" data-index="${index}" aria-label="Remover ${esc(item.nome)}">&times;</button>
          </div>`).join("")}`
      : `<span class="almox-product-empty">Nenhum produto na lista.</span>`;
  };
  const clearProductFields = () => {
    selectedProduct = null;
    visibleProducts = [];
    searchInput.value = "";
    qtyInput.value = "";
    resultsBox.classList.remove("is-open");
    resultsBox.innerHTML = "";
    searchInput.focus();
  };
  const queueCurrentProduct = () => {
    const product = typedProduct();
    const quantidade = Number.parseInt(qtyInput.value, 10);
    if (!product) {
      toast("Selecione um produto da lista antes de incluir.", "error");
      return false;
    }
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      toast("Informe uma quantidade válida.", "error");
      return false;
    }
    if (pendingItems.some((item) => item.sku === product.sku)) {
      toast("Este produto já está na lista.", "error");
      return false;
    }
    pendingItems.push({ sku: product.sku, nome: product.nome, quantidade });
    renderPendingItems();
    clearProductFields();
    return true;
  };
  const renderResults = () => {
    const term = searchInput.value.trim().toLowerCase();
    const candidates = availableProducts();
    selectedProduct = candidates.find((product) => productLabel(product).toLowerCase() === searchInput.value.trim().toLowerCase()) || null;
    visibleProducts = [];
    if (!term) {
      resultsBox.innerHTML = `<span class="almox-product-empty">Digite para pesquisar os produtos.</span>`;
      resultsBox.classList.remove("is-open");
      return;
    }
    const matches = candidates.filter((product) => matchesProduct(product, term)).slice(0, 8);
    visibleProducts = matches;
    resultsBox.classList.add("is-open");
    resultsBox.innerHTML = matches.length
      ? matches.map((product) => `
        <button class="almox-product-option" type="button" data-sku="${esc(product.sku)}" role="option">
          <strong>${esc(product.nome || "")}</strong>
          <span>${esc(product.sku || "")}</span>
        </button>`).join("")
      : `<span class="almox-product-empty">Nenhum produto encontrado.</span>`;
  };
  resultsBox.addEventListener("click", (event) => {
    const option = event.target.closest(".almox-product-option");
    if (!option) return;
    selectProduct(products.find((product) => product.sku === option.dataset.sku) || null);
  });
  selectedList.addEventListener("click", (event) => {
    const removeButton = event.target.closest(".remove-pending-almox-product");
    if (!removeButton) return;
    pendingItems = pendingItems.filter((_, index) => index !== Number(removeButton.dataset.index));
    renderPendingItems();
    renderResults();
  });
  modal.querySelector(".queue-almox-product")?.addEventListener("click", queueCurrentProduct);
  searchInput.addEventListener("input", renderResults);
  searchInput.addEventListener("focus", renderResults);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const firstOption = resultsBox.querySelector(".almox-product-option");
    if (!firstOption || selectedProduct) return;
    event.preventDefault();
    firstOption.click();
  });
  modal.querySelector("#add-almox-product-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!orderCode) {
      toast("Não foi possível identificar o pedido.", "error");
      return;
    }
    if (!pendingItems.length && !queueCurrentProduct()) {
      return;
    }
    const items = pendingItems.map((item) => ({
      sku_produto: item.sku,
      quantidade_solicitada: item.quantidade
    }));
    const previousText = submitButton?.textContent || "Adicionar produtos";
    try {
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Adicionando produtos...";
      }
      await adicionarProdutosAoPedido({
        pedidoId: orderCode,
        produtos: items,
        idempotencyKey: createIdempotencyKey()
      });
      toast("Produtos adicionados com sucesso.");
      close();
      // Atualiza o painel de onde este modal foi aberto, sem fechá-lo; o quadro ao fundo
      // é só sincronizado (leve), para não recarregar a tela inteira com o painel aberto
      const atualizouPainel = await refreshReleasePanelAfterEdit(card, filters);
      if (!atualizouPainel) await viewRelease(filters);
      else viewRelease({ ...filters, auto: true }).catch(() => {});
    } catch (error) {
      toast(error.userMessage || error.message || "Não foi possível adicionar os produtos ao pedido.", "error");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = previousText;
      }
    }
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.body.appendChild(modal);
  renderPendingItems();
  modal.querySelector("#add-almox-product-search")?.focus();
}

// Verifica se existe algum pedido aberto na liberação
function releaseHasOpenOrder() {
  return Boolean(document.querySelector(".order-accordion.is-open"));
}

// Atualiza os contadores por status no quadro de liberação
function updateReleaseCounters(byStatus) {
  Object.entries(byStatus).forEach(([status, groups]) => {
    const el = document.querySelector(`[data-release-count="${CSS.escape(status)}"]`);
    if (el) el.textContent = groups.length;
  });
}

// Monta uma coluna do quadro Kanban de liberação
function releaseKanbanColumn(status, groups = []) {
  return `
    <section class="release-kanban-column" data-release-column="${esc(status)}" aria-label="${esc(orderStatusLabels[status] || status)}">
      <header class="release-kanban-column-head">
        <div>
          <p class="eyebrow">${esc(orderStatusLabels[status] || status)}</p>
          <strong>${groups.length} pedido${groups.length === 1 ? "" : "s"}</strong>
        </div>
        <span data-release-count="${esc(status)}">${groups.length}</span>
      </header>
      <div class="release-kanban-dropzone" data-release-dropzone="${esc(status)}">
        ${groups.map((group) => releaseKanbanCard(group)).join("") || `<div class="release-kanban-empty">Nenhum pedido nesta coluna.</div>`}
      </div>
    </section>`;
}

// Monta o card de pedido do quadro Kanban de liberação
function releaseKanbanCard(group = []) {
  const first = group[0] || {};
  const key = orderGroupKey(first);
  const totalItems = group.length;
  const totalRequested = group.reduce((sum, item) => sum + Number(item.quantidade_solicitada || 0), 0);
  const version = releaseKanbanGroupVersion(group);
  const statusTime = moneyDate(first.criado_em || first.data_hora || new Date().toISOString());
  // Finalizar so aparece quando o pedido aguarda retirada e ainda nao tem assinatura
  const canFinalize = first.status === "Aguardando Retirada" && !first.retirada_assinatura;
  // Pendente avanca direto para separacao em um clique, sem abrir o painel
  const quickAdvance = first.status === "Pendente" ? "Em Andamento" : "";
  return `
    <article class="release-kanban-card" draggable="true" tabindex="0"
      data-order="${esc(first.codigo_pedido || "")}"
      data-order-key="${esc(key)}"
      data-order-status="${esc(first.status || "")}"
      data-version="${esc(version)}">
      <div class="release-kanban-card-main">
        <strong>Pedido ${esc(first.codigo_pedido || "")}</strong>
        <span>${esc(first.pdv || "PDV")}</span>
        <small>${esc(first.solicitante || "Solicitante")} | ${esc(statusTime)}</small>
      </div>
      <div class="release-kanban-card-meta">
        ${statusPill(first.status || "")}
        ${orderEditedBadge(first)}
        <span>${totalItems} item${totalItems === 1 ? "" : "s"}</span>
        <span>${totalRequested} un.</span>
      </div>
      <div class="release-kanban-card-actions">
        <button class="btn secondary open-release-detail" type="button">Visualizar</button>
        ${quickAdvance ? `<button class="btn release-card-advance" type="button" data-next-status="${esc(quickAdvance)}">Iniciar separação</button>` : ""}
        ${canFinalize ? `<button class="btn release-card-finalize" type="button">Finalizar pedido</button>` : ""}
        <label class="release-mobile-move">Mover
          <select class="release-card-status-select" aria-label="Mover pedido ${esc(first.codigo_pedido || "")}">
            ${releaseKanbanStatuses.map((status) => `<option value="${esc(status)}" ${status === first.status ? "selected" : ""}>${esc(orderStatusLabels[status] || status)}</option>`).join("")}
          </select>
        </label>
      </div>
    </article>`;
}

// Extrai o identificador do pedido a partir do valor informado
function releaseKanbanOrderId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof Element !== "undefined" && value instanceof Element) return value.dataset.order || "";
  if (Array.isArray(value)) return value[0]?.codigo_pedido || "";
  return value.codigo_pedido || value.orderCode || "";
}

// Obtém a versão otimista do grupo de pedido
function releaseKanbanGroupVersion(group = []) {
  return Math.max(1, ...group.map((item) => Number(item.version || 1)).filter(Number.isFinite));
}

// Guarda o último status/versão conhecido do pedido no Kanban
function rememberReleaseKanbanState(orderId = "", status = "", version = 1) {
  if (!orderId) return;
  const normalizedVersion = Math.max(Number(version) || 1, releaseKanbanKnownVersions.get(orderId) || 1);
  releaseKanbanKnownVersions.set(orderId, normalizedVersion);
  if (status) {
    releaseKanbanRecentStatuses.set(orderId, {
      status,
      version: normalizedVersion,
      at: Date.now()
    });
  }
}

// Verifica se o grupo recebido está desatualizado em relação ao estado local
function isStaleReleaseKanbanGroup(orderId = "", group = []) {
  if (!orderId) return true;
  const incomingVersion = releaseKanbanGroupVersion(group);
  const knownVersion = releaseKanbanKnownVersions.get(orderId) || 0;
  if (knownVersion && incomingVersion < knownVersion) return true;
  const recent = releaseKanbanRecentStatuses.get(orderId);
  if (!recent) return false;
  if (Date.now() - recent.at > 12000) {
    releaseKanbanRecentStatuses.delete(orderId);
    return false;
  }
  const incomingStatus = group[0]?.status || "";
  return Boolean(incomingStatus && incomingStatus !== recent.status && incomingVersion <= recent.version);
}

// Retorna a operação em andamento para o pedido, se houver
function activeReleaseKanbanOperation(orderId = "") {
  return orderId ? releaseKanbanOperations.get(orderId) : null;
}

// Inicia o controle de uma operação assíncrona no Kanban (com AbortController)
function beginReleaseKanbanOperation(orderId = "") {
  if (!orderId || releaseKanbanOperations.has(orderId)) return null;
  const operation = {
    id: ++releaseKanbanOperationSeq,
    orderId,
    controller: new AbortController()
  };
  releaseKanbanOperations.set(orderId, operation);
  return operation;
}

// Verifica se a operação informada ainda é a mais recente para o pedido
function isCurrentReleaseKanbanOperation(orderId = "", operation = null) {
  return Boolean(orderId && operation && releaseKanbanOperations.get(orderId)?.id === operation.id);
}

// Encerra o controle de operação em andamento do pedido
function finishReleaseKanbanOperation(orderId = "", operation = null) {
  if (isCurrentReleaseKanbanOperation(orderId, operation)) releaseKanbanOperations.delete(orderId);
}

// Remove cards duplicados do mesmo pedido no quadro
function removeReleaseKanbanDuplicateCards(orderId = "", keepCard = null) {
  if (!orderId) return;
  document.querySelectorAll(`.release-kanban-card[data-order="${CSS.escape(orderId)}"]`).forEach((card) => {
    if (card !== keepCard) card.remove();
  });
}

// Insere o card na coluna evitando duplicidade
function placeReleaseKanbanCardOnce(card, zone) {
  if (!card || !zone) return;
  removeReleaseKanbanDuplicateCards(card.dataset.order || "", card);
  zone.appendChild(card);
}

// Monta o card de pedido finalizado na liberação
function releaseFinalizedCard(group = []) {
  const first = group[0] || {};
  const key = orderGroupKey(first);
  const totalItems = group.length;
  const totalRequested = group.reduce((sum, item) => sum + Number(item.quantidade_solicitada || 0), 0);
  const totalReleased = group.reduce((sum, item) => sum + Number(item.quantidade_liberada || 0), 0);
  const finishedAt = moneyDate(first.retirada_em || first.liberado_em || first.criado_em || first.data_hora || new Date().toISOString());
  return `
    <article class="release-finalized-card"
      data-finalized-order="${esc(first.codigo_pedido || "")}"
      data-order-key="${esc(key)}">
      <div class="release-finalized-card-main">
        <strong>Pedido ${esc(first.codigo_pedido || "")}</strong>
        <span>${esc(first.pdv || "PDV")}</span>
        <small>${esc(first.solicitante || "Solicitante")} | ${esc(finishedAt)}</small>
      </div>
      <div class="release-finalized-card-meta">
        ${statusPill("Finalizado")}
        ${orderEditedBadge(first)}
        <span>${totalItems} item${totalItems === 1 ? "" : "s"}</span>
        <span>${totalRequested} solicitado${totalRequested === 1 ? "" : "s"}</span>
        <span>${totalReleased} liberado${totalReleased === 1 ? "" : "s"}</span>
      </div>
      <div class="release-finalized-card-actions">
        <button class="btn secondary open-release-detail" type="button">Visualizar</button>
        <button class="btn secondary print-release-finalized" type="button">Imprimir</button>
      </div>
    </article>`;
}

// Liga os eventos da lista de pedidos finalizados
function bindReleaseFinalizedList(from, to, pdvId, q, groupsByKey = new Map()) {
  const list = document.querySelector("#release-finalized-list");
  if (!list) return;
  list.querySelectorAll("[data-finalized-order]").forEach((card) => {
    if (card.dataset.bound === "true") return;
    const key = card.dataset.orderKey || "";
    const group = groupsByKey.get(key);
    if (!group) return;
    card.dataset.bound = "true";
    card.querySelector(".open-release-detail")?.addEventListener("click", () => openReleaseDetailPanel(group, { from, to, pdvId, q, mode: "finalized" }));
    card.querySelector(".print-release-finalized")?.addEventListener("click", async () => {
      await printReleaseOrderGroup(group);
    });
  });
}

// Exclui um pedido pelo código na tela de liberação
async function deleteReleaseOrderByCode(orderCode = "", triggerButton = null) {
  const code = String(orderCode || "").trim();
  if (!code || triggerButton?.classList.contains("is-processing")) return false;
  const confirmation = await confirmOrderDeleteSystem(code);
  if (!confirmation.confirmed) return false;
  const previousText = triggerButton?.textContent || "";
  if (triggerButton) {
    triggerButton.classList.add("is-processing");
    triggerButton.disabled = true;
    triggerButton.textContent = "Excluindo...";
  }
  try {
    await request("/api/admin/orders", {
      method: "DELETE",
      body: JSON.stringify({
        codigo_pedido: code,
        confirmation_code: code,
        justificativa: confirmation.justification
      })
    });
    clearReleaseDraft(code);
    document.querySelectorAll(`[data-order="${CSS.escape(code)}"]`).forEach((orderCardNode) => orderCardNode.remove());
    document.querySelectorAll(`[data-finalized-order="${CSS.escape(code)}"]`).forEach((orderCardNode) => orderCardNode.remove());
    closeReleaseDetailOverlay();
    updateReleaseKanbanColumnEmptyStates();
    updateReleaseKanbanCounts();
    toast("Pedido excluído.");
    return true;
  } catch (error) {
    toast(error.message || "Não foi possível excluir o pedido.", "error");
    return false;
  } finally {
    if (triggerButton) {
      triggerButton.classList.remove("is-processing");
      triggerButton.disabled = false;
      triggerButton.textContent = previousText;
    }
  }
}

// Carrega os detalhes de um pedido para o painel de controle
async function loadReleaseOrderDetails(orderCode = "", context = {}) {
  const fallbackGroup = Array.isArray(context.group) ? context.group : [];
  if (!orderCode) return fallbackGroup;
  const buildParams = ({ includePeriod = true, includePdv = true } = {}) => {
    const params = new URLSearchParams({
      q: orderCode,
      limit: "120"
    });
    if (includePeriod) {
      params.set("from", context.from || weekAgo());
      params.set("to", context.to || today());
    }
    if (includePdv && context.pdvId) params.set("pdvId", context.pdvId);
    if (context.mode === "finalized") {
      params.set("status", "Finalizado");
    } else {
      params.set("active", "1");
    }
    return params;
  };
  const fetchRows = async (params) => {
    const data = await request(`/api/admin/orders?${params.toString()}`, { silentLoading: true });
    return Array.isArray(data?.orders) ? data.orders.filter((row) => row.codigo_pedido === orderCode) : [];
  };
  let rows = await fetchRows(buildParams());
  if (!rows.length) rows = await fetchRows(buildParams({ includePeriod: false }));
  if (!rows.length && context.pdvId) rows = await fetchRows(buildParams({ includePeriod: false, includePdv: false }));
  return rows.length ? rows : fallbackGroup;
}

// Fecha o painel do pedido e devolve a rolagem à página
function closeReleaseDetailOverlay() {
  document.querySelector(".release-detail-overlay")?.remove();
  document.body.classList.remove("has-order-panel");
}

// Etapas do fluxo mostradas na trilha do painel do pedido
const releasePanelSteps = ["Pendente", "Em Andamento", "Aguardando Retirada", "Finalizado"];

// Lista as transições de status permitidas a partir do status atual
function releaseAllowedTransitions(status = "") {
  if (!releaseKanbanStatuses.includes(status)) return [];
  return releaseKanbanStatuses.filter((nextStatus) => nextStatus !== status);
}

// Descreve em uma linha o que falta fazer no pedido
function releasePanelStepHint(status = "") {
  if (status === "Pendente") return "Inicie a separação para liberar os produtos deste PDV.";
  if (status === "Em Andamento") return "Informe quanto será liberado de cada produto e envie para retirada.";
  if (status === "Aguardando Retirada") return "Confirme a retirada com a assinatura do responsável.";
  return "Pedido finalizado. Reabra apenas se precisar corrigir algo.";
}

// Monta a trilha visual de etapas do pedido
function releasePanelStepsHtml(status = "") {
  const current = releasePanelSteps.indexOf(status);
  return releasePanelSteps.map((step, index) => {
    const state = current < 0 ? "" : index < current ? "is-done" : index === current ? "is-current" : "";
    return `<li class="${state}"><span aria-hidden="true">${index + 1}</span>${esc(orderStatusLabels[step] || step)}</li>`;
  }).join("");
}

// Normaliza um número de estoque vindo da API
function releasePanelStock(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

// Monta a tabela única de itens: editável na separação, somente leitura nas demais etapas
// Formata a coluna "Solicitado" do painel do Almoxarifado em embalagens, a partir do que está
// liberado (não do pedido original): assim o almoxarifado vê, ao lado do campo em unidades,
// quantas embalagens fechadas aquele valor representa (ex: liberar 15 un com fator 15 = 1,00 EMB).
function formatarSolicitadoEmbalagem(unidadesLiberadas, fator) {
  const valor = (Number(unidadesLiberadas) || 0) / fator;
  return `${valor.toFixed(2).replace(".", ",")} EMB`;
}

function releasePanelItemsTable(group = [], editable = false) {
  const draft = getReleaseDraft(group[0]?.codigo_pedido);
  const draftById = new Map((draft.items || []).map((item) => [String(item.id), item]));
  const rows = group.map((item) => {
    const central = centralStockValue(item);
    const requested = Number(item.quantidade_solicitada || 0);
    const saved = Number(item.quantidade_liberada || 0);
    const draftItem = draftById.get(String(item.id));
    const released = editable
      ? Number((draftItem?.quantidade_liberada ?? (saved > 0 ? saved : requested)) || 0)
      : saved;
    const missing = Math.max(requested - released, 0);
    // Produto pedido por embalagem: mostra "Solicitado" em EMB (derivado do liberado), nunca
    // com fator inválido/adivinhado — nesse caso a coluna continua em unidades, como sempre foi
    const fator = Number(item.fator_conversao);
    const fatorValido = item.fator_status !== "INVALIDO" && Number.isSafeInteger(fator) && fator > 1;
    const rowState = central < 0
      ? "release-item-negative"
      : central === 0
        ? "release-item-zero"
        : missing === 0
          ? "release-item-complete"
          : released > 0
            ? "release-item-partial"
            : "";
    const stockClass = central < 0 ? "negative" : central === 0 ? "zero" : "positive";
    return `
      <tr class="release-item-row ${rowState}"
        data-id="${esc(item.id)}"
        data-version="${esc(item.version || 1)}"
        data-requested="${esc(requested)}"
        data-released="${esc(released)}"
        data-product="${esc(item.produto || "")}"
        data-sku="${esc(item.sku_produto || item.sku || "")}">
        ${editable ? `<td class="order-panel-pick">
          <label class="release-select-control" title="Selecionar produto">
            <input class="bulk-order-item" type="checkbox" value="${esc(item.id)}" aria-label="Selecionar ${esc(item.produto || "")}">
            <span aria-hidden="true"></span>
          </label>
        </td>` : ""}
        <td class="order-panel-product">
          <strong class="release-product-name">${esc(item.produto || "-")}</strong>
          <small>${esc(item.sku_produto || item.sku || "sem SKU")}${item.item_origem === "ALMOX" ? ` <span class="order-source-badge">Almox</span>` : ""}</small>
          <small class="order-panel-pdv">PDV ${releasePanelStock(item.estoque_pdv)} · mín ${releasePanelStock(item.estoque_minimo)} · máx ${releasePanelStock(item.estoque_maximo)}</small>
        </td>
        <td class="release-number-cell"><span class="stock-badge ${stockClass}">${central}</span></td>
        <td class="release-number-cell" data-requested-value${fatorValido ? ` data-fator="${fator}"` : ""}>${fatorValido ? formatarSolicitadoEmbalagem(released, fator) : requested}</td>
        <td class="release-number-cell">${editable
          ? `<input class="liberada release-qty-input" type="number" min="0" step="1" inputmode="numeric" aria-label="Quantidade a liberar de ${esc(item.produto || "")}" value="${esc(released)}">`
          : released}</td>
        ${editable ? `<td class="release-number-cell release-missing-cell">${missing}</td>
        <td class="order-panel-row-action">
          <button class="release-remove-control delete-order-item" type="button" title="Excluir produto do pedido" aria-label="Excluir ${esc(item.produto || "")} do pedido">
            <span aria-hidden="true">&#128465;</span>
          </button>
        </td>` : ""}
      </tr>`;
  });
  // Na leitura, Liberado é a última coluna: é dela que o comprovante de retirada lê as quantidades
  const headers = editable
    ? ["", "Produto", "Estoque central", "Solicitado", "Liberar", "Falta", ""]
    : ["Produto", "Estoque central", "Solicitado", "Liberado"];
  const linhas = rows.length ? rows : [`<tr><td colspan="${headers.length}">Nenhum produto neste pedido.</td></tr>`];
  return table(headers, linhas).replace("table-wrap", "table-wrap order-panel-table");
}

// Monta o HTML completo do painel do pedido
function releasePanelHtml(group = []) {
  const first = group[0] || {};
  const status = first.status || "";
  const editable = status === "Em Andamento";
  const totalItems = group.length;
  const totalRequested = group.reduce((sum, item) => sum + Number(item.quantidade_solicitada || 0), 0);
  const totalReleased = group.reduce((sum, item) => sum + Number(item.quantidade_liberada || 0), 0);
  const unavailable = group.filter((item) => centralStockValue(item) <= 0).length;
  const canDelete = !["Finalizado", "Aguardando Retirada"].includes(status);
  const currentIndex = releaseKanbanStatuses.indexOf(status);
  // Ação principal de cada etapa: é sempre o próximo passo do fluxo
  const primaryAction = status === "Pendente"
    ? `<button class="btn order-panel-primary" type="button" data-panel-flow="true" data-status="Em Andamento">Iniciar separação</button>`
    : editable
      ? `<button class="btn order-panel-primary" type="button" data-panel-flow="true" data-status="Aguardando Retirada" data-release-mode="entered-only">Enviar para retirada</button>`
      : status === "Aguardando Retirada"
        ? `<button class="btn order-panel-primary order-panel-finalize" type="button">Finalizar com assinatura</button>`
        : `<button class="btn secondary order-panel-primary" type="button" data-panel-flow="true" data-status="Em Andamento">Reabrir para edição</button>`;
  // Só o retorno para a etapa imediatamente anterior, para não poluir com saltos de fluxo
  const previousStatus = currentIndex > 0 ? releaseKanbanStatuses[currentIndex - 1] : "";
  const backActions = previousStatus && releaseAllowedTransitions(status).includes(previousStatus)
    ? `<button class="btn secondary" type="button" data-panel-flow="true" data-status="${esc(previousStatus)}">
        Voltar para ${esc(orderStatusLabels[previousStatus] || previousStatus)}
      </button>`
    : "";
  return `
    <section class="order-panel" role="dialog" aria-modal="true" aria-label="Painel do pedido ${esc(first.codigo_pedido || "")}"
      data-order="${esc(first.codigo_pedido || "")}"
      data-order-status="${esc(status)}"
      data-order-version="${esc(first.version || 1)}">
      <header class="order-panel-head">
        <div class="order-panel-head-main">
          <h2>${esc(first.codigo_pedido || "")} ${statusPill(status)} ${orderEditedBadge(first)}</h2>
          <p class="order-panel-origin">${esc(first.pdv || "PDV")} · ${esc(first.solicitante || "Solicitante")} · ${esc(moneyDate(first.criado_em || first.data_hora || new Date().toISOString()))}</p>
        </div>
        <ol class="order-panel-steps">${releasePanelStepsHtml(status)}</ol>
        <button class="order-panel-timeline-open" type="button" aria-label="Histórico de edição do pedido" title="Histórico de edição do pedido">🕐</button>
        <button class="order-panel-close" type="button" aria-label="Fechar painel">&times;</button>
      </header>
      <div class="order-panel-content">
        <div class="order-panel-context">
          <div class="order-panel-metrics">
            <span><strong>${totalItems}</strong>produto${totalItems === 1 ? "" : "s"}</span>
            <span><strong>${totalRequested}</strong>solicitado</span>
            <span><strong>${totalReleased}</strong>liberado</span>
            <span class="${unavailable ? "is-warning" : ""}"><strong>${unavailable}</strong>sem estoque</span>
          </div>
          <p class="order-panel-hint">${esc(releasePanelStepHint(status))}</p>
        </div>
        ${first.observacao ? `<p class="order-panel-note"><strong>Observação do PDV</strong>${esc(first.observacao)}</p>` : ""}
        ${releasePanelItemsTable(group, editable)}
      </div>
      <footer class="order-panel-foot">
        <div class="order-panel-foot-left">
          ${editable ? `
            <span class="order-panel-selection" data-selected-count>0 produtos selecionados</span>
            <button class="btn secondary delete-selected-order-items" type="button" disabled>Excluir selecionados</button>
            <button class="btn secondary order-panel-fill" type="button">Liberar tudo</button>
            <button class="btn secondary save-release-draft" type="button">Salvar rascunho</button>
            <button class="btn secondary add-almox-product" type="button">+ Produto</button>` : ""}
          <button class="btn secondary order-panel-print" type="button">Imprimir</button>
          ${canDelete ? `<button class="btn danger order-panel-delete" type="button">Excluir pedido</button>` : ""}
        </div>
        <div class="order-panel-foot-right">
          <span class="order-panel-saving hidden">Salvando...</span>
          ${backActions}
          ${primaryAction}
        </div>
      </footer>
    </section>`;
}

// Traduz a ação registrada na auditoria para um rótulo legível na linha do tempo
function releaseTimelineLabel(acao = "") {
  if (acao === "status_alterado_kanban") return "Movido no quadro";
  if (acao === "status_alterado_painel") return "Movido no painel";
  if (acao === "retirada_confirmada") return "Retirada confirmada";
  if (acao === "pedido_excluido") return "Pedido excluído";
  return acao || "Alteração";
}

// Abre o relatório de edição do pedido (histórico de etapas) em um modal à parte,
// carregado sob demanda ao clicar no ícone de relógio — não ocupa espaço no painel principal
async function openReleaseTimelineModal(orderCode = "") {
  if (!orderCode) return;
  const modal = document.createElement("div");
  modal.className = "photo-viewer order-timeline-modal";
  modal.innerHTML = `
    <div class="photo-viewer-dialog" role="dialog" aria-modal="true" aria-label="Histórico de edição do pedido ${esc(orderCode)}">
      <div class="photo-viewer-head">
        <div>
          <p class="eyebrow">Relatório de edição</p>
          <h3>Pedido ${esc(orderCode)}</h3>
        </div>
        <button class="icon-btn close-order-timeline" type="button" aria-label="Fechar">&times;</button>
      </div>
      <div class="order-timeline-body">
        <p class="order-panel-timeline-loading">Carregando histórico...</p>
      </div>
    </div>`;
  const close = () => modal.remove();
  modal.querySelector(".close-order-timeline").addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.body.appendChild(modal);
  const body = modal.querySelector(".order-timeline-body");
  try {
    const data = await request(`/api/admin/order-timeline?codigo_pedido=${encodeURIComponent(orderCode)}`, { silentLoading: true });
    const linhas = Array.isArray(data?.timeline) ? data.timeline : [];
    if (!linhas.length) {
      body.innerHTML = `<p class="order-panel-timeline-empty">Nenhuma movimentação registrada para este pedido.</p>`;
      return;
    }
    body.innerHTML = `
      <ol class="order-panel-timeline-list">
        ${linhas.map((linha) => {
          const de = linha.dados?.status_anterior;
          const para = linha.dados?.novo_status;
          const caminho = de && para ? `${esc(de)} → ${esc(para)}` : para ? esc(para) : "";
          return `
          <li>
            <strong>${esc(releaseTimelineLabel(linha.acao))}</strong>
            ${caminho ? `<span class="order-panel-timeline-path">${caminho}</span>` : ""}
            <small>${esc(linha.usuario || "Almoxarifado")} · ${esc(moneyDate(linha.criado_em))}</small>
          </li>`;
        }).join("")}
      </ol>`;
  } catch (error) {
    body.innerHTML = `<p class="order-panel-timeline-empty">Não foi possível carregar o histórico. ${esc(error.message || "")}</p>`;
  }
}

// Abre o fluxo de finalizacao com assinatura a partir do grupo do pedido
function openReleaseWithdrawalFlow(group = [], context = {}) {
  if (!group?.length) {
    toast("Não foi possível carregar os produtos deste pedido.", "error");
    return false;
  }
  // O modal de retirada le os itens de um card renderizado, entao montamos um fora da tela
  const holder = document.createElement("div");
  holder.className = "release-withdrawal-buffer hidden";
  holder.innerHTML = orderCard(group);
  document.body.appendChild(holder);
  const card = holder.querySelector("[data-order]");
  const opened = openOrderWithdrawalModal(card, {
    from: context.from,
    to: context.to,
    pdvId: context.pdvId,
    onSuccess: async () => {
      holder.remove();
      closeReleaseDetailOverlay();
      await viewRelease({ from: context.from, to: context.to, pdvId: context.pdvId });
    },
    onClose: () => holder.remove()
  });
  if (!opened) holder.remove();
  return opened;
}

// Carrega os dados atualizados do pedido e abre a finalizacao com assinatura
async function finalizeReleaseOrder(orderCode = "", context = {}, trigger = null) {
  if (!orderCode) return;
  const previousText = trigger?.textContent;
  if (trigger) {
    trigger.disabled = true;
    trigger.textContent = "Abrindo...";
  }
  try {
    const group = await loadReleaseOrderDetails(orderCode, { ...context, mode: "active" });
    if (group[0]?.status !== "Aguardando Retirada") {
      toast("Só é possível finalizar pedidos em Aguardando Retirada.", "error");
      return;
    }
    openReleaseWithdrawalFlow(group, context);
  } catch (error) {
    toast(error.message || "Não foi possível abrir a finalização do pedido.", "error");
  } finally {
    if (trigger) {
      trigger.disabled = false;
      trigger.textContent = previousText;
    }
  }
}

// Liga todos os eventos do painel do pedido
function bindReleasePanel(overlay, group = [], context = {}) {
  const panel = overlay?.querySelector(".order-panel");
  if (!panel) return;
  const orderCode = panel.dataset.order || group[0]?.codigo_pedido || "";
  bindReleasePanelClose(overlay);
  // Toda a mecânica da tabela (quantidades, seleção, rascunho, excluir item, adicionar produto)
  bindReleaseInteractions(context.from, context.to, group[0]?.status || "Pendente", panel, context.pdvId, context.q);
  updateReleaseBulkActions(panel);

  // Os controles de exclusão em massa só aparecem quando há algo selecionado
  const syncSelection = () => {
    panel.classList.toggle("has-selection", releaseSelectedItemRows(panel).length > 0);
  };
  panel.addEventListener("change", (event) => {
    if (event.target?.classList?.contains("bulk-order-item")) syncSelection();
  });
  syncSelection();
  panel.querySelector(".order-panel-timeline-open")?.addEventListener("click", () => {
    openReleaseTimelineModal(orderCode);
  });

  const setSaving = (saving) => {
    panel.classList.toggle("is-saving", saving);
    panel.querySelector(".order-panel-saving")?.classList.toggle("hidden", !saving);
    panel.querySelectorAll(".order-panel-foot .btn").forEach((button) => {
      button.disabled = saving || (button.classList.contains("delete-selected-order-items") && !releaseSelectedItemRows(panel).length);
    });
  };

  // Imprime a partir de um card montado fora da tela, que tem o layout do comprovante
  panel.querySelector(".order-panel-print")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await printReleaseOrderGroup(group);
    } finally {
      button.disabled = false;
    }
  });

  panel.querySelector(".order-panel-delete")?.addEventListener("click", async (event) => {
    await deleteReleaseOrderByCode(orderCode, event.currentTarget);
  });

  panel.querySelector(".order-panel-finalize")?.addEventListener("click", () => {
    openReleaseWithdrawalFlow(group, context);
  });

  // Preenche todas as quantidades com o que foi solicitado
  panel.querySelector(".order-panel-fill")?.addEventListener("click", () => {
    let changed = 0;
    panel.querySelectorAll("tbody tr").forEach((row) => {
      const input = row.querySelector(".liberada");
      if (!input) return;
      const requested = row.dataset.requested || "0";
      if (String(input.value) !== String(requested)) changed += 1;
      input.value = requested;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    toast(changed ? "Quantidades preenchidas com o solicitado." : "As quantidades já estavam iguais ao solicitado.");
  });

  // Enter salta para o próximo produto e, no último, para a ação principal
  const inputs = [...panel.querySelectorAll(".liberada")];
  inputs.forEach((input, index) => {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const next = inputs[index + 1];
      if (next) {
        next.focus();
        next.select?.();
      } else {
        panel.querySelector(".order-panel-primary")?.focus();
      }
    });
  });

  // Avanços e retornos de etapa usam o mesmo envio de fluxo da tela de liberação
  panel.querySelectorAll("[data-panel-flow]").forEach((button) => {
    button.addEventListener("click", async () => {
      setSaving(true);
      try {
        const done = await submitOrderFlow(button, context);
        // O painel continua aberto e já mostra a etapa seguinte: quem fecha é só o X
        if (done) await reloadReleasePanel(overlay, orderCode, context);
      } finally {
        setSaving(false);
      }
    });
  });
}

// Recarrega o painel com os dados atuais do pedido, mantendo-o aberto
async function reloadReleasePanel(overlay, orderCode = "", context = {}) {
  if (!overlay?.isConnected) return;
  try {
    const group = await loadReleaseOrderDetails(orderCode, { ...context, group: [] });
    if (!group.length) {
      overlay.innerHTML = releasePanelShell(orderCode, `
        <div class="order-panel-message">
          <strong>Pedido não encontrado.</strong>
          <p>Ele pode ter sido alterado ou removido por outro usuário.</p>
        </div>`);
      bindReleasePanelClose(overlay);
      return;
    }
    renderReleasePanel(overlay, group, context);
  } catch (error) {
    toast(error.message || "Não foi possível atualizar o painel do pedido.", "error");
  }
}

// Renderiza o painel e devolve o foco para onde o trabalho continua
function renderReleasePanel(overlay, group = [], context = {}) {
  overlay.innerHTML = releasePanelHtml(group);
  bindReleasePanel(overlay, group, context);
  const firstInput = overlay.querySelector(".liberada");
  if (firstInput) {
    firstInput.focus();
    firstInput.select?.();
  } else {
    overlay.querySelector(".order-panel-primary, .order-panel-close")?.focus();
  }
}

// Liga o botão X, único jeito de fechar o painel
function bindReleasePanelClose(overlay) {
  overlay?.querySelectorAll(".order-panel-close").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", closeReleaseDetailOverlay);
  });
}

// Monta a casca do painel usada nos estados de carregamento e erro
function releasePanelShell(orderCode = "", inner = "") {
  return `
    <section class="order-panel" role="dialog" aria-modal="true" aria-label="Painel do pedido ${esc(orderCode)}">
      <header class="order-panel-head">
        <div class="order-panel-head-main">
          <p class="eyebrow">Liberação de pedido</p>
          <h2>${esc(orderCode)}</h2>
        </div>
        <button class="order-panel-close" type="button" aria-label="Fechar painel">&times;</button>
      </header>
      <div class="order-panel-content">${inner}</div>
    </section>`;
}

// Abre o painel do pedido em tela cheia
async function openReleaseDetailPanel(group = [], context = {}) {
  const first = Array.isArray(group) && group.length ? group[0] : {};
  const orderCode = context.orderCode || first.codigo_pedido || "";
  if (!orderCode || document.querySelector(".release-detail-overlay.is-loading")) return;
  closeReleaseDetailOverlay();
  const overlay = document.createElement("div");
  overlay.className = "release-detail-overlay order-panel-overlay is-loading";
  overlay.innerHTML = releasePanelShell(orderCode, `<div class="order-panel-loading">Carregando pedido...</div>`);
  document.body.appendChild(overlay);
  document.body.classList.add("has-order-panel");
  bindReleasePanelClose(overlay);
  overlay.querySelector(".order-panel-close")?.focus();

  try {
    const freshGroup = await loadReleaseOrderDetails(orderCode, { ...context, group });
    overlay.classList.remove("is-loading");
    if (!freshGroup.length) {
      overlay.innerHTML = releasePanelShell(orderCode, `
        <div class="order-panel-message">
          <strong>Pedido não encontrado.</strong>
          <p>Ele pode ter sido alterado ou removido por outro usuário.</p>
        </div>`);
      bindReleasePanelClose(overlay);
      return;
    }
    // Na separação o cursor já começa na primeira quantidade
    renderReleasePanel(overlay, freshGroup, context);
  } catch (error) {
    overlay.classList.remove("is-loading");
    overlay.innerHTML = releasePanelShell(orderCode, `
      <div class="order-panel-message">
        <strong>Não foi possível carregar o pedido.</strong>
        <p>${esc(error.message || "Verifique a conexão e tente novamente.")}</p>
      </div>`);
    bindReleasePanelClose(overlay);
  }
}

// Dispara a impressão do pedido a partir da liberação
async function printReleaseOrderGroup(group = []) {
  if (!group?.length) return;
  const holder = document.createElement("div");
  holder.className = "release-print-buffer";
  holder.innerHTML = orderCard(group);
  document.body.appendChild(holder);
  const card = holder.querySelector("[data-order]");
  try {
    await printOrder(card);
  } finally {
    setTimeout(() => holder.remove(), 3000);
  }
}

// Liga os eventos gerais do quadro Kanban de liberação
function bindReleaseKanban(from, to, pdvId, q, groupsByKey = new Map()) {
  const board = document.querySelector("#release-kanban-board");
  if (!board) return;
  board.__releaseContext = { from, to, pdvId, q, groupsByKey };

  board.querySelectorAll(".release-kanban-card").forEach((card) => {
    bindReleaseKanbanCard(card, { from, to, pdvId, q, groupsByKey });
    if (card.dataset.dragBound === "true") return;
    card.dataset.dragBound = "true";
    card.addEventListener("dragstart", (event) => {
      const orderId = card.dataset.order || "";
      if (card.dataset.saving === "true" || activeReleaseKanbanOperation(orderId)) {
        event.preventDefault();
        return;
      }
      board.__releaseDraggedCard = card;
      card.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.orderKey || "");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      board.__releaseDraggedCard = null;
    });
  });

  board.querySelectorAll(".release-kanban-dropzone").forEach((zone) => {
    zone.__releaseDropContext = { from, to, pdvId, q };
    if (zone.dataset.dropBound === "true") return;
    zone.dataset.dropBound = "true";
    zone.addEventListener("dragover", (event) => {
      const draggedCard = board.__releaseDraggedCard;
      if (!draggedCard) return;
      event.preventDefault();
      zone.classList.add("is-drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-drag-over"));
    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      zone.classList.remove("is-drag-over");
      const draggedCard = board.__releaseDraggedCard;
      const card = draggedCard || board.querySelector(`[data-order-key="${CSS.escape(event.dataTransfer.getData("text/plain") || "")}"]`);
      if (!card) return;
      if (activeReleaseKanbanOperation(card.dataset.order || "")) return;
      await moveReleaseKanbanCard(card, zone.dataset.releaseDropzone, zone.__releaseDropContext || board.__releaseContext || {});
    });
  });
}

// Liga os eventos (arrastar, clique) de um card do Kanban
function bindReleaseKanbanCard(card, context = {}) {
  if (!card) return;
  const { from, to, pdvId, q, groupsByKey = new Map() } = context;
  const openDetail = () => {
    const key = card.dataset.orderKey || "";
    const orderCode = card.dataset.order || "";
    const group = groupsByKey.get(key) || [];
    const fallbackGroup = group.length ? group : [{
      codigo_pedido: orderCode,
      status: card.dataset.orderStatus || "",
      version: card.dataset.version || 1
    }];
    openReleaseDetailPanel(fallbackGroup, { from, to, pdvId, q, mode: "active", orderCode });
  };
  const detailButton = card.querySelector(".open-release-detail");
  if (detailButton && detailButton.dataset.bound !== "true") {
    detailButton.dataset.bound = "true";
    detailButton.addEventListener("click", openDetail);
  }
  const advanceButton = card.querySelector(".release-card-advance");
  if (advanceButton && advanceButton.dataset.bound !== "true") {
    advanceButton.dataset.bound = "true";
    advanceButton.addEventListener("click", async () => {
      if (activeReleaseKanbanOperation(card.dataset.order || "")) return;
      await moveReleaseKanbanCard(card, advanceButton.dataset.nextStatus || "", context);
    });
  }
  const finalizeButton = card.querySelector(".release-card-finalize");
  if (finalizeButton && finalizeButton.dataset.bound !== "true") {
    finalizeButton.dataset.bound = "true";
    finalizeButton.addEventListener("click", async (event) => {
      const orderCode = card.dataset.order || "";
      if (activeReleaseKanbanOperation(orderCode)) return;
      const key = card.dataset.orderKey || "";
      await finalizeReleaseOrder(orderCode, { from, to, pdvId, q, group: groupsByKey.get(key) || [] }, event.currentTarget);
    });
  }
  if (card.dataset.keyboardBound !== "true") {
    card.dataset.keyboardBound = "true";
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });
  }
  const select = card.querySelector(".release-card-status-select");
  if (select && select.dataset.bound !== "true") {
    select.dataset.bound = "true";
    select.addEventListener("change", async (event) => {
      const currentSelect = event.currentTarget;
      const previous = card.dataset.orderStatus || "";
      const next = currentSelect.value;
      if (previous === next) return;
      if (activeReleaseKanbanOperation(card.dataset.order || "")) {
        currentSelect.value = previous;
        return;
      }
      const moved = await moveReleaseKanbanCard(card, next, context);
      if (!moved) currentSelect.value = previous;
    });
  }
}

// Envia PATCH de status do pedido com controle de versão otimista
async function atualizarStatusPedido({ pedidoCodigo, statusAnterior, novoStatus, versao, signal } = {}) {
  const endpoint = "/api/admin/orders/status";
  const method = "PATCH";
  const expectedStatusCode = orderStatusCodes[statusAnterior] || statusAnterior;
  const nextStatusCode = orderStatusCodes[novoStatus] || novoStatus;
  try {
    return await request(endpoint, {
      method,
      signal,
      body: JSON.stringify({
        codigo_pedido: pedidoCodigo,
        expected_status: expectedStatusCode,
        status: nextStatusCode,
        version: versao ? Number(versao) : undefined
      })
    });
  } catch (error) {
    console.error("Falha ao atualizar status do pedido", {
      endpoint,
      method,
      httpStatus: error?.status,
      pedidoCodigo,
      statusAnterior: expectedStatusCode,
      novoStatus: nextStatusCode
    });
    throw error;
  }
}

// Traduz o erro da API de status em mensagem amigável
function releaseStatusErrorMessage(error) {
  const technicalMessage = String(error?.details?.error || error?.details?.message || error?.message || "");
  if (error?.status === 404 && /rota n[aã]o encontrada/i.test(technicalMessage)) {
    return "A rota de atualização de status não respondeu neste ambiente. Reinicie o servidor local ou atualize a versão publicada e tente novamente.";
  }
  if (error?.status === 404 && /pedido n[aã]o encontrado/i.test(technicalMessage)) {
    return "Pedido não encontrado. Atualize as solicitações para sincronizar o quadro.";
  }
  if (error?.status === 404) return technicalMessage || "Não foi possível localizar o pedido informado.";
  if (error?.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (error?.status === 403) return "Seu usuário não tem permissão para alterar este pedido.";
  if (error?.status === 409) return "Este pedido foi alterado por outro usuário. Atualize as solicitações.";
  if (error?.status === 422) return "Esta movimentação de status não é permitida.";
  if (error?.status >= 500) return "O servidor não conseguiu salvar o status agora. Tente novamente.";
  return error?.message || "Não foi possível mover o pedido.";
}

// Move um card para outro status, com atualização otimista e rollback
async function moveReleaseKanbanCard(card, nextStatus, context = {}) {
  const previousStatus = card?.dataset.orderStatus || "";
  const orderCode = card?.dataset.order || "";
  if (!card || !orderCode || !nextStatus || previousStatus === nextStatus) return false;
  if (!releaseKanbanStatuses.includes(previousStatus) || !releaseKanbanStatuses.includes(nextStatus)) return false;
  if (!releaseAllowedTransitions(previousStatus).includes(nextStatus)) {
    const now = Date.now();
    const lastInvalidToast = Number(card.dataset.lastInvalidMoveToast || 0);
    if (now - lastInvalidToast > 1200) {
      card.dataset.lastInvalidMoveToast = String(now);
      toast("Movimentação não permitida para este status.", "error");
    }
    return false;
  }
  if (card.dataset.saving === "true" || activeReleaseKanbanOperation(orderCode)) return false;
  const operation = beginReleaseKanbanOperation(orderCode);
  if (!operation) return false;

  const previousZone = card.closest("[data-release-dropzone]");
  const nextZone = document.querySelector(`[data-release-dropzone="${CSS.escape(nextStatus)}"]`);
  const placeholder = document.createComment("release-card-position");
  previousZone?.insertBefore(placeholder, card.nextSibling);
  card.dataset.saving = "true";
  card.dataset.operationId = String(operation.id);
  card.classList.add("is-saving");
  placeReleaseKanbanCardOnce(card, nextZone);
  updateReleaseKanbanColumnEmptyStates();
  updateReleaseKanbanCounts();

  try {
    const resultado = await atualizarStatusPedido({
      pedidoCodigo: orderCode,
      statusAnterior: previousStatus,
      novoStatus: nextStatus,
      versao: card.dataset.version,
      signal: operation.controller.signal
    });
    if (!isCurrentReleaseKanbanOperation(orderCode, operation)) return false;
    card.dataset.orderStatus = nextStatus;
    const optimisticVersion = Number(card.dataset.version || 1) + 1;
    card.dataset.version = String(optimisticVersion);
    rememberReleaseKanbanState(orderCode, nextStatus, optimisticVersion);
    card.querySelector(".release-card-status-select").value = nextStatus;
    // Arrastar para Aguardando Retirada libera a quantidade total solicitada; avisa o usuário
    const liberadoNoQuadro = Number(resultado?.quantidade_liberada || 0);
    toast(nextStatus === "Aguardando Retirada" && liberadoNoQuadro > 0
      ? `Pedido movido para Aguardando Retirada com ${liberadoNoQuadro} unidade(s) liberada(s).`
      : `Pedido movido para ${orderStatusLabels[nextStatus] || nextStatus}.`);
    const refreshedCard = await refreshReleaseKanbanCard(orderCode, context, operation);
    if (refreshedCard) card = refreshedCard;
    return true;
  } catch (error) {
    if (isCurrentReleaseKanbanOperation(orderCode, operation)) {
      removeReleaseKanbanDuplicateCards(orderCode, card);
      placeholder.parentNode?.insertBefore(card, placeholder);
    }
    toast(releaseStatusErrorMessage(error), "error");
    updateReleaseKanbanColumnEmptyStates();
    updateReleaseKanbanCounts();
    return false;
  } finally {
    placeholder.remove();
    if (isCurrentReleaseKanbanOperation(orderCode, operation)) {
      finishReleaseKanbanOperation(orderCode, operation);
      const currentCard = document.querySelector(`.release-kanban-card[data-order="${CSS.escape(orderCode)}"]`) || card;
      currentCard.dataset.saving = "false";
      delete currentCard.dataset.operationId;
      currentCard.classList.remove("is-saving");
      removeReleaseKanbanDuplicateCards(orderCode, currentCard);
      updateReleaseKanbanColumnEmptyStates();
      updateReleaseKanbanCounts();
    }
  }
}

// Recarrega os dados de um card específico do Kanban
async function refreshReleaseKanbanCard(orderCode, context = {}, operation = null) {
  if (!orderCode) return null;
  if (operation && !isCurrentReleaseKanbanOperation(orderCode, operation)) return null;
  const params = new URLSearchParams({ from: context.from || weekAgo(), to: context.to || today(), active: "1", q: orderCode, limit: "10" });
  if (context.pdvId) params.set("pdvId", context.pdvId);
  try {
    const data = await request(`/api/admin/orders?${params.toString()}`, {
      silentLoading: true,
      signal: operation?.controller?.signal
    });
    if (operation && !isCurrentReleaseKanbanOperation(orderCode, operation)) return null;
    const grouped = Object.values((data.orders || []).reduce((acc, row) => {
      const key = orderGroupKey(row);
      acc[key] ||= [];
      acc[key].push(row);
      return acc;
    }, {}));
    const group = grouped.find((items) => items[0]?.codigo_pedido === orderCode);
    if (!group) return null;
    rememberReleaseKanbanState(orderCode, group[0]?.status || "", releaseKanbanGroupVersion(group));
    const card = document.querySelector(`.release-kanban-card[data-order="${CSS.escape(orderCode)}"]`);
    if (!card) return null;
    const oldKey = card.dataset.orderKey || "";
    const wrapper = document.createElement("div");
    wrapper.innerHTML = releaseKanbanCard(group);
    const nextCard = wrapper.firstElementChild;
    if (operation && isCurrentReleaseKanbanOperation(orderCode, operation)) {
      nextCard.dataset.saving = "true";
      nextCard.dataset.operationId = String(operation.id);
      nextCard.classList.add("is-saving");
    }
    if (context.groupsByKey) {
      if (oldKey) context.groupsByKey.delete(oldKey);
      context.groupsByKey.set(orderGroupKey(group[0]), group);
    }
    removeReleaseKanbanDuplicateCards(orderCode, card);
    card.replaceWith(nextCard);
    bindReleaseKanbanCard(nextCard, context);
    bindReleaseKanban(context.from, context.to, context.pdvId, context.q, context.groupsByKey || new Map([[orderGroupKey(group[0]), group]]));
    return nextCard;
  } catch {
    return null;
  }
}

// Sincroniza o quadro Kanban inteiro com os dados recebidos
function syncReleaseKanbanBoard(byStatus, from, to, pdvId, q) {
  const groupsByKey = new Map();
  const groupsByOrder = new Map();
  const statusByOrder = new Map();

  releaseKanbanStatuses.forEach((status) => {
    (byStatus[status] || []).forEach((group) => {
      const first = group[0] || {};
      const orderId = releaseKanbanOrderId(first);
      if (!orderId || groupsByOrder.has(orderId)) return;
      if (isStaleReleaseKanbanGroup(orderId, group)) return;
      groupsByOrder.set(orderId, group);
      statusByOrder.set(orderId, status);
      groupsByKey.set(orderGroupKey(first), group);
      rememberReleaseKanbanState(orderId, status, releaseKanbanGroupVersion(group));
    });
  });

  releaseKanbanStatuses.forEach((status) => {
    const zone = document.querySelector(`[data-release-dropzone="${CSS.escape(status)}"]`);
    if (!zone) return;
    zone.querySelectorAll(".release-kanban-card").forEach((card) => {
      const orderId = card.dataset.order || "";
      if (card.dataset.saving === "true" || activeReleaseKanbanOperation(orderId)) return;
      const recent = releaseKanbanRecentStatuses.get(orderId);
      if (!statusByOrder.has(orderId) && recent && Date.now() - recent.at <= 12000) return;
      if (statusByOrder.get(orderId) !== status) card.remove();
    });
  });

  groupsByOrder.forEach((group, orderId) => {
    if (activeReleaseKanbanOperation(orderId)) return;
    const status = statusByOrder.get(orderId);
    const zone = document.querySelector(`[data-release-dropzone="${CSS.escape(status)}"]`);
    if (!zone) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = releaseKanbanCard(group);
    const nextCard = wrapper.firstElementChild;
    const existingCard = document.querySelector(`.release-kanban-card[data-order="${CSS.escape(orderId)}"]`);
    if (existingCard) {
      removeReleaseKanbanDuplicateCards(orderId, existingCard);
      existingCard.replaceWith(nextCard);
    } else {
      removeReleaseKanbanDuplicateCards(orderId);
      zone.appendChild(nextCard);
    }
  });

  updateReleaseKanbanColumnEmptyStates();
  updateReleaseKanbanCounts();
  bindReleaseKanban(from, to, pdvId, q, groupsByKey);
}

// Atualiza o estado visual das colunas vazias do Kanban
function updateReleaseKanbanColumnEmptyStates() {
  document.querySelectorAll(".release-kanban-dropzone").forEach((zone) => {
    const hasCards = Boolean(zone.querySelector(".release-kanban-card"));
    zone.querySelectorAll(".release-kanban-empty").forEach((empty) => empty.remove());
    if (!hasCards) zone.insertAdjacentHTML("beforeend", `<div class="release-kanban-empty">Nenhum pedido nesta coluna.</div>`);
  });
}

// Atualiza a contagem de cards por coluna do Kanban
function updateReleaseKanbanCounts() {
  document.querySelectorAll("[data-release-column]").forEach((column) => {
    const status = column.dataset.releaseColumn;
    const total = new Set([...column.querySelectorAll(".release-kanban-card")]
      .map((card) => card.dataset.order)
      .filter(Boolean)).size;
    column.querySelector("[data-release-count]") && (column.querySelector("[data-release-count]").textContent = total);
    const globalCount = document.querySelector(`.release-kanban-summary [data-release-count="${CSS.escape(status)}"]`);
    if (globalCount) globalCount.textContent = total;
  });
}

// Gera a chave de armazenamento do rascunho do pedido
function releaseDraftKey(orderCode) {
  return `acpark_release_draft_${orderCode || ""}`;
}

// Recupera o rascunho salvo de um pedido
function getReleaseDraft(orderCode) {
  try {
    return JSON.parse(localStorage.getItem(releaseDraftKey(orderCode)) || "{}");
  } catch {
    return {};
  }
}

// Salva o rascunho das alterações do pedido
function saveReleaseDraft(card) {
  const orderCode = card?.dataset.order;
  if (!orderCode) return;
  const items = [...card.querySelectorAll("tbody tr")].map((tr) => ({
    id: tr.dataset.id,
    quantidade_liberada: tr.querySelector(".liberada")?.value || "0",
    remover: Boolean(tr.querySelector(".remover")?.checked)
  }));
  localStorage.setItem(releaseDraftKey(orderCode), JSON.stringify({ items, savedAt: new Date().toISOString() }));
}

// Remove o rascunho salvo de um pedido
function clearReleaseDraft(orderCode) {
  if (orderCode) localStorage.removeItem(releaseDraftKey(orderCode));
}

// Remove itens específicos do rascunho de um pedido
function removeReleaseDraftItems(orderCode, removedIds = []) {
  if (!orderCode) return;
  const removed = new Set(removedIds.map(String));
  const draft = getReleaseDraft(orderCode);
  const items = Array.isArray(draft.items)
    ? draft.items.filter((item) => !removed.has(String(item.id)))
    : [];
  if (!items.length) {
    clearReleaseDraft(orderCode);
    return;
  }
  localStorage.setItem(releaseDraftKey(orderCode), JSON.stringify({ ...draft, items, savedAt: new Date().toISOString() }));
}

// Atualiza o estado visual da linha de item do pedido
function updateReleaseItemRowState(row) {
  if (!row) return;
  const parseQty = (value) => {
    const normalized = String(value ?? "0").replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const requestedCell = row.querySelector("[data-requested-value]");
  const requested = parseQty(row.dataset.requested || requestedCell?.textContent);
  const released = parseQty(row.querySelector(".liberada")?.value);
  const saldo = Number(row.querySelector(".stock-badge")?.textContent || 0);
  const missing = Math.max(requested - released, 0);
  const missingCell = row.querySelector(".release-missing-cell");
  if (missingCell) missingCell.textContent = missing;
  // Produto com fator de conversão válido: "Solicitado" acompanha em embalagens o que está
  // digitado em "Liberar" (unidades), ao vivo, a cada tecla — não fica preso ao pedido original
  const fator = Number(requestedCell?.dataset.fator);
  if (requestedCell && Number.isSafeInteger(fator) && fator > 1) {
    requestedCell.textContent = formatarSolicitadoEmbalagem(released, fator);
  }
  row.classList.toggle("is-marked-remove", Boolean(row.querySelector(".remover")?.checked));
  row.classList.toggle("release-item-negative", saldo < 0);
  row.classList.toggle("release-item-zero", saldo === 0);
  row.classList.toggle("release-item-complete", saldo > 0 && missing === 0);
  row.classList.toggle("release-item-partial", saldo > 0 && missing > 0 && released > 0);
  row.classList.toggle("release-item-invalid", !Number.isFinite(released) || released < 0);
}

// Retorna as linhas de itens selecionadas no card
function releaseSelectedItemRows(card) {
  return [...(card?.querySelectorAll(".bulk-order-item:checked") || [])]
    .map((input) => input.closest("tr"))
    .filter(Boolean);
}

// Resume os itens selecionados (quantidade/total)
function releaseSelectedItemsSummary(rows = []) {
  return rows.map((row) => ({
    id: row.dataset.id,
    version: row.dataset.version || "1",
    produto: row.dataset.product || row.querySelector(".release-product-name")?.textContent?.trim() || "Produto",
    quantidade: row.dataset.requested || row.querySelector(".release-number-cell")?.textContent?.trim() || "0",
    liberada: row.querySelector(".liberada")?.value ?? row.dataset.released ?? "0"
  })).filter((item) => item.id);
}

// Atualiza a visibilidade das ações em lote conforme seleção
function updateReleaseBulkActions(card) {
  if (!card) return;
  const selected = releaseSelectedItemRows(card);
  const count = card.querySelector("[data-selected-count]");
  const button = card.querySelector(".delete-selected-order-items");
  if (count) count.textContent = `${selected.length} produto${selected.length === 1 ? "" : "s"} selecionado${selected.length === 1 ? "" : "s"}`;
  if (button) button.disabled = selected.length === 0 || button.classList.contains("is-processing");
}

// Liga os eventos de edição/rascunho dos pedidos
function bindReleaseDrafts(root = document) {
  const cards = [
    ...(root.matches?.("[data-order]") ? [root] : []),
    ...root.querySelectorAll("[data-order]")
  ];
  cards.forEach((card) => {
    card.querySelectorAll(".liberada, .remover, .bulk-order-item").forEach((input) => {
      if (input.dataset.draftBound === "true") return;
      input.dataset.draftBound = "true";
      input.addEventListener("input", () => {
        updateReleaseItemRowState(input.closest("tr"));
        saveReleaseDraft(card);
        updateReleaseBulkActions(card);
      });
      input.addEventListener("change", () => {
        updateReleaseItemRowState(input.closest("tr"));
        saveReleaseDraft(card);
        updateReleaseBulkActions(card);
      });
      updateReleaseItemRowState(input.closest("tr"));
    });
    requestAnimationFrame(() => {
      card.querySelectorAll("tbody tr").forEach(updateReleaseItemRowState);
      updateReleaseBulkActions(card);
    });
  });
}

// Monta o card de um pedido para exibição
function orderCard(group) {
  const first = group[0];
  const draft = getReleaseDraft(first.codigo_pedido);
  const draftById = new Map((draft.items || []).map((item) => [String(item.id), item]));
  const visibleItems = orderDisplayItemsForStatus(group);
  const hiddenCompletedItems = [];
  const tableItems = [...visibleItems, ...hiddenCompletedItems];
  const unavailableItems = visibleItems.filter((item) => Number(item.saldo) <= 0);
  const isWithdrawalStatus = first.status === "Aguardando Retirada";
  const isEditableStatus = first.status === "Em Andamento";
  const canRemoveProducts = first.status === "Em Andamento";
  const stockValue = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const statusTime = first.status === "Pendente"
    ? `Pendente desde ${moneyDate(first.criado_em)}`
    : first.status === "Em Andamento"
      ? `Em andamento desde ${moneyDate(first.em_andamento_em || first.criado_em)}`
      : isWithdrawalStatus
        ? `${first.status} desde ${moneyDate(first.pronto_retirada_em || first.liberado_em || first.criado_em)}`
        : `Finalizado em ${moneyDate(first.retirada_em || first.liberado_em || first.criado_em)}`;
  const actions = first.status === "Pendente"
    ? `<button class="btn flow" data-status="Em Andamento">Enviar para em andamento</button>`
    : first.status === "Em Andamento"
      ? `<button class="btn secondary flow" data-status="Pendente">Voltar para pendente</button><button class="btn secondary save-release-draft" type="button">Salvar rascunho</button><button class="btn secondary add-almox-product" type="button">+ Produto</button><button class="btn flow" data-status="Aguardando Retirada" data-release-mode="entered-only">Enviar para retirada</button>`
      : first.status === "Aguardando Retirada" && !first.retirada_assinatura
        ? `<button class="btn secondary flow" data-status="Em Andamento">Voltar para em andamento</button><button class="btn confirm-order-withdrawal-open" type="button">Confirmar retirada com assinatura</button>`
        : first.status === "Finalizado"
          ? `<button class="btn secondary flow" data-status="Em Andamento">Voltar para em andamento</button>${first.retirada_assinatura ? `<button class="btn secondary view-order-withdrawal" type="button" data-order="${esc(first.codigo_pedido)}" data-signature="${esc(first.retirada_assinatura)}" data-responsible="${esc(first.retirada_responsavel || "")}" data-date="${esc(first.retirada_em ? moneyDate(first.retirada_em) : "")}" data-user="${esc(first.retirada_usuario_almoxarifado || "")}" data-pdv="${esc(first.pdv || "")}" data-items='${withdrawalItemsAttribute(orderReleasedItems(group))}'>Visualizar comprovante de retirada</button>` : ""}`
        : first.retirada_assinatura
          ? `<button class="btn secondary view-order-withdrawal" type="button" data-order="${esc(first.codigo_pedido)}" data-signature="${esc(first.retirada_assinatura)}" data-responsible="${esc(first.retirada_responsavel || "")}" data-date="${esc(first.retirada_em ? moneyDate(first.retirada_em) : "")}" data-user="${esc(first.retirada_usuario_almoxarifado || "")}" data-pdv="${esc(first.pdv || "")}" data-items='${withdrawalItemsAttribute(orderReleasedItems(group))}'>Visualizar comprovante de retirada</button>`
          : "";
  const canDeleteOrder = !["Finalizado", "Aguardando Retirada"].includes(first.status);
  return `<article class="card order-accordion" data-order="${esc(first.codigo_pedido)}" data-order-status="${esc(first.status)}" data-order-key="${esc(orderGroupKey(first))}">
    <button class="order-accordion-head" type="button" data-toggle-order aria-expanded="false">
      <span class="order-arrow">&#9662;</span>
      <span>
        <strong>Pedido ${esc(first.codigo_pedido)} - ${esc(first.pdv)}</strong>
        <small>${esc(first.solicitante)} | ${esc(statusTime)}</small>
      </span>
      <span class="order-head-status">
        ${statusPill(first.status)}
        ${orderEditedBadge(first)}
      </span>
    </button>
    <div class="order-accordion-body hidden">
      <div class="order-card-actions no-print">
        <button class="btn secondary print-order" type="button">Imprimir pedido</button>
        ${canDeleteOrder ? `<button class="btn danger delete-order" type="button">Excluir pedido</button>` : ""}
      </div>
      ${first.observacao ? `<p class="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">${esc(first.observacao)}</p>` : ""}
      ${unavailableItems.length ? `<div class="release-alert stock-unavailable-alert">
        <strong>Produtos com estoque indisponível</strong>
      </div>` : ""}
      ${!isEditableStatus ? `<div class="release-alert card no-print"><strong>Pedido bloqueado para edição.</strong><p>Envie o pedido para Em andamento para alterar produtos ou quantidades.</p></div>` : ""}
      ${!isEditableStatus
        ? table(["Produto", "Estoque central", "Estoque PDV", "Min", "Max", "Quantidade solicitada", "Quantidade liberada"], visibleItems.map((o) => `
        <tr data-id="${o.id}" data-version="${o.version || 1}" data-requested="${o.quantidade_solicitada}" data-released="${o.quantidade_liberada || 0}">
          <td>${esc(o.produto)} ${o.item_origem === "ALMOX" ? `<span class="order-source-badge">Almox</span>` : ""}</td>
          <td class="release-number-cell">${centralStockValue(o)}</td>
          <td class="release-number-cell">${stockValue(o.estoque_pdv)}</td>
          <td class="release-number-cell">${stockValue(o.estoque_minimo)}</td>
          <td class="release-number-cell">${stockValue(o.estoque_maximo)}</td>
          <td class="release-number-cell">${o.quantidade_solicitada}</td>
          <td class="release-number-cell">${o.quantidade_liberada}</td>
        </tr>`)).replace("table-wrap", "table-wrap release-items-table-wrap")
        : table(["Selecionar", "Produto", "Estoque PDV", "Min", "Max", "Solicitado", "Liberar", "Falta enviar", "Estoque central"], tableItems.map((o) => {
        const draftItem = draftById.get(String(o.id));
        const requestedQty = Number(o.quantidade_solicitada || 0);
        const savedReleaseQty = Number(o.quantidade_liberada || 0);
        const releasedQty = Number((draftItem?.quantidade_liberada ?? (savedReleaseQty > 0 ? savedReleaseQty : requestedQty)) || 0);
        // Mesma regra do painel do pedido: "Solicitado" mostra em embalagens o que está em
        // "Liberar" (unidades), quando o produto tiver fator de conversão válido
        const fatorKanban = Number(o.fator_conversao);
        const fatorKanbanValido = o.fator_status !== "INVALIDO" && Number.isSafeInteger(fatorKanban) && fatorKanban > 1;
        const missingQty = Math.max(requestedQty - releasedQty, 0);
        const saldo = centralStockValue(o);
        const isRemoved = canRemoveProducts && Boolean(draftItem?.remover);
        const hiddenCompleted = false;
        const rowState = saldo < 0
          ? "release-item-negative"
          : saldo === 0
            ? "release-item-zero"
            : missingQty === 0
              ? "release-item-complete"
              : releasedQty > 0
                ? "release-item-partial"
                : "";
        const saldoClass = saldo < 0 ? "negative" : saldo === 0 ? "zero" : "positive";
        const saldoLabel = saldo < 0 ? "Saldo negativo" : saldo === 0 ? "Saldo zerado" : "Saldo disponível";
        const canBulkDeleteItem = canRemoveProducts;
        return `
        <tr data-id="${o.id}" data-version="${o.version || 1}" data-requested="${o.quantidade_solicitada}" data-product="${esc(o.produto)}" data-sku="${esc(o.sku_produto || "")}" data-released="${esc(releasedQty)}" class="release-item-row ${rowState} ${isRemoved ? "is-marked-remove" : ""} ${hiddenCompleted ? "hidden" : ""}">
          <td class="release-remove-cell">
            <label class="release-select-control" title="${canBulkDeleteItem ? "Selecionar produto para exclusão" : "Produto bloqueado para exclusão"}">
              <input class="bulk-order-item" type="checkbox" value="${esc(o.id)}" ${canBulkDeleteItem ? "" : "disabled"} aria-label="Selecionar ${esc(o.produto)} para exclusão">
              <span aria-hidden="true"></span>
            </label>
            <button class="release-remove-control delete-order-item" type="button" title="Excluir produto do pedido" aria-label="Excluir ${esc(o.produto)} do pedido" ${canBulkDeleteItem ? "" : "disabled"}>
              <span aria-hidden="true">&#128465;</span>
            </button>
          </td>
          <td class="release-product-name">${esc(o.produto)} ${o.item_origem === "ALMOX" ? `<span class="order-source-badge">Almox</span>` : ""}</td>
          <td class="release-number-cell">${stockValue(o.estoque_pdv)}</td>
          <td class="release-number-cell">${stockValue(o.estoque_minimo)}</td>
          <td class="release-number-cell">${stockValue(o.estoque_maximo)}</td>
          <td class="release-number-cell" data-requested-value${fatorKanbanValido ? ` data-fator="${fatorKanban}"` : ""}>${fatorKanbanValido ? formatarSolicitadoEmbalagem(releasedQty, fatorKanban) : requestedQty}</td>
          <td>
            <input class="liberada release-qty-input" type="number" min="0" step="1" inputmode="numeric" aria-label="Quantidade a liberar de ${esc(o.produto)}" value="${esc(releasedQty)}">
          </td>
          <td class="release-missing-cell">${missingQty}</td>
          <td><span class="stock-badge ${saldoClass}" title="${esc(saldoLabel)}">${saldo}</span></td>
        </tr>`;
      })).replace("table-wrap", "table-wrap release-items-table-wrap")}
      ${isEditableStatus ? `<div class="release-bulk-actions no-print">
        <span class="release-bulk-count" data-selected-count>0 produtos selecionados</span>
        <button class="btn danger delete-selected-order-items" type="button" disabled>Excluir selecionados</button>
      </div>` : ""}
      <div class="order-card-actions no-print">${actions}</div>
    </div>
  </article>`;
}

// Liga os eventos de expandir/recolher dos cards de pedido
function bindOrderToggles(root = document) {
  root.querySelectorAll("[data-toggle-order]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
    const card = button.closest(".order-accordion");
    const body = card?.querySelector(".order-accordion-body");
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", expanded ? "false" : "true");
    body?.classList.toggle("hidden", expanded);
    card?.classList.toggle("is-open", !expanded);
    });
  });
}

// Aguarda o conteúdo estar pronto antes de imprimir
function waitForPrintReady(target) {
  const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const images = [...(target?.querySelectorAll("img") || [])].map((img) => {
    if (img.complete && img.naturalWidth !== 0) return Promise.resolve();
    if (typeof img.decode === "function") return img.decode().catch(() => {});
    return new Promise((resolve) => {
      img.addEventListener("load", resolve, { once: true });
      img.addEventListener("error", resolve, { once: true });
    });
  });
  return Promise.all([waitFrame(), ...images]);
}

// Agenda a limpeza dos elementos temporários após a impressão
function schedulePrintCleanup(cleanup) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    window.removeEventListener("afterprint", run);
    cleanup();
  };
  window.addEventListener("afterprint", run, { once: true });
  setTimeout(run, 3500);
}

// Dispara a impressão de um pedido
async function printOrder(card, options = {}) {
  if (!card) return;
  const orderCode = card.dataset.order || "";
  const orderStatus = card.dataset.orderStatus || "";
  // Pendente ainda não tem liberação decidida (imprime o solicitado); a partir de Em Andamento
  // o cupom passa a mostrar o que o almoxarifado está de fato liberando/enviando/entregue
  const printReleasedQty = orderStatus === "Em Andamento" || orderStatus === "Aguardando Retirada" || orderStatus === "Finalizado";
  const headerText = card.querySelector(".order-accordion-head strong")?.textContent?.trim() || "";
  const pdv = headerText.replace(/^Pedido\s+/i, "").replace(orderCode, "").replace(/^\s*-\s*/, "").trim();
  const smallText = card.querySelector(".order-accordion-head small")?.textContent?.trim() || "";
  const [requesterText, ...statusParts] = smallText.split("|").map((part) => part.trim()).filter(Boolean);
  const observation = card.querySelector(".order-accordion-body > p")?.textContent?.trim() || "";
  const statusTime = statusParts.join(" | ") || smallText || "";
  const rows = [...card.querySelectorAll("tbody tr:not(.hidden)")].map((row) => {
    const cells = [...row.querySelectorAll("td")];
    const product = row.querySelector(".release-product-name")?.textContent?.trim()
      || cells[0]?.textContent?.trim()
      || cells[1]?.textContent?.trim()
      || "";
    const requestedQty = row.dataset.requested
      || row.querySelector("[data-requested-value]")?.textContent?.trim()
      || (cells.length >= 6 ? cells[5]?.textContent?.trim() : cells[2]?.textContent?.trim())
      || "0";
    // Prioriza o valor ao vivo do campo "Liberar" (caso o usuário tenha acabado de digitar e ainda
    // não salvo), depois o atributo do servidor, depois a célula da tabela somente-leitura
    const releasedCandidates = [
      row.querySelector(".liberada")?.value,
      row.dataset.released,
      cells[cells.length - 1]?.textContent?.trim()
    ];
    const releasedQty = releasedCandidates.find((value) => value !== undefined && value !== null && String(value).trim() !== "") ?? "0";
    return { product, requested: printReleasedQty ? releasedQty : requestedQty };
  }).filter((item) => item.product && item.product !== "Nenhum registro encontrado.");

  // Sem isso o cupom herdava o @page A4 global e imprimia como folha cheia, não como recibo estreito
  const printStyle = document.createElement("style");
  printStyle.id = "receipt-80mm-print-style";
  printStyle.textContent = `
    @media print {
      @page {
        size: 80mm auto;
        margin: 0;
      }
    }
  `;
  const receipt = document.createElement("section");
  receipt.className = "receipt-print-target order-request-print-target";
  receipt.innerHTML = `
    <div class="receipt-head">
      <strong>ACPark Pedidos</strong>
      <small>${esc(orderCode)}</small>
      <small>${esc([pdv, requesterText].filter(Boolean).join(" - ") || "-")}</small>
    </div>
    <div class="receipt-note"><strong>Obs:</strong> ${esc(observation || "-")}</div>
    <div class="receipt-line"></div>
    <div class="receipt-items">
      <div class="receipt-row receipt-row-head">
        <span>Produto</span>
        <span>QTD</span>
      </div>
      <div class="receipt-item-dash"></div>
      ${rows.map((item) => `
        <div class="receipt-row">
          <span>${esc(item.product)}</span>
          <span>${esc(item.requested)}</span>
        </div>
        <div class="receipt-item-dash"></div>
      `).join("") || `<div class="receipt-note">Nenhum produto informado.</div>`}
    </div>
    <div class="receipt-foot">${esc(statusTime || `Emitido em ${moneyDate(new Date().toISOString())}`)}</div>
  `;
  document.head.appendChild(printStyle);
  document.body.appendChild(receipt);
  document.body.classList.add("printing-receipt");
  await waitForPrintReady(receipt);
  window.print();
  schedulePrintCleanup(() => {
    document.body.classList.remove("printing-receipt");
    printStyle.remove();
    receipt.remove();
  });
  return { method: "Navegador", printer: "Navegador" };
}

// Extrai os itens de retirada a partir do card do pedido
function orderWithdrawalItemsFromCard(card) {
  return [...card.querySelectorAll("tbody tr:not(.hidden)")].map((row) => {
    const cells = row.querySelectorAll("td");
    const releasedCandidates = [
      row.querySelector(".liberada")?.value,
      cells[cells.length - 1]?.textContent?.trim(),
      row.dataset.released
    ];
    const releasedQty = releasedCandidates
      .map((value) => Number(String(value ?? "").replace(",", ".")))
      .find((value) => Number.isFinite(value) && value > 0) || 0;
    return {
      produto: row.querySelector(".release-product-name")?.textContent?.trim() || cells[0]?.textContent?.trim() || cells[1]?.textContent?.trim() || "",
      liberada: releasedQty
    };
  }).filter((item) => item.produto && item.produto !== "Nenhum registro encontrado." && Number(item.liberada || 0) > 0);
}

// Extrai os itens de retirada a partir do grupo do pedido
function orderWithdrawalItemsFromGroup(group = []) {
  return orderReleasedItems(group).map((item) => ({
    produto: item.produto,
    liberada: item.quantidade_liberada || 0
  })).filter((item) => item.produto);
}

// Serializa os itens de retirada para um atributo HTML
function withdrawalItemsAttribute(items = []) {
  return esc(JSON.stringify(orderWithdrawalItemsFromGroup(items).length ? orderWithdrawalItemsFromGroup(items) : items));
}

// Extrai os itens de retirada a partir do botão acionado
function orderWithdrawalItemsFromButton(button, card) {
  try {
    const parsed = JSON.parse(button?.dataset.items || "[]");
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return orderWithdrawalItemsFromCard(card);
}

// Dispara a impressão do recibo de retirada do pedido
async function printWithdrawalReceipt({ orderCode, pdv, responsible, date, user, signature, items = [] }) {
  const printStyle = document.createElement("style");
  printStyle.id = "receipt-a4-print-style";
  printStyle.textContent = `
    @media print {
      @page {
        size: A4 portrait;
        margin: 14mm;
      }
    }
  `;
  const receipt = document.createElement("section");
  receipt.className = "receipt-print-target";
  receipt.innerHTML = `
    <div class="receipt-head">
      <strong>ACPark Gestão</strong>
      <span>Comprovante de retirada</span>
      <small>Pedido ${esc(orderCode || "")}</small>
      <small>${esc(pdv || "-")} | ${esc(date || "-")}</small>
    </div>
    <div class="receipt-note"><strong>Responsável:</strong> ${esc(responsible || "-")}</div>
    <div class="receipt-note"><strong>Entregue por:</strong> ${esc(user || "-")}</div>
    <div class="receipt-line"></div>
    <div class="receipt-items">
      <div class="receipt-row receipt-row-head">
        <span>Produto</span>
        <span>Qtd</span>
      </div>
      ${items.map((item) => `
        <div class="receipt-row">
          <span>${esc(item.produto)}</span>
          <span>${esc(item.liberada)}</span>
        </div>`).join("") || `<div class="receipt-note">Nenhum produto informado.</div>`}
    </div>
    <div class="receipt-line"></div>
    ${signature ? `<img class="receipt-signature" src="${esc(signature)}" alt="Assinatura do responsável" />` : ""}
    <div class="receipt-foot">${moneyDate(new Date().toISOString())}</div>
  `;
  document.head.appendChild(printStyle);
  document.body.appendChild(receipt);
  document.body.classList.add("printing-receipt");
  document.body.classList.add("printing-withdrawal-receipt");
  await waitForPrintReady(receipt);
  window.print();
  schedulePrintCleanup(() => {
    document.body.classList.remove("printing-receipt");
    document.body.classList.remove("printing-withdrawal-receipt");
    printStyle.remove();
    receipt.remove();
  });
}

// Abre a visualização do recibo de retirada
function openOrderWithdrawalReceipt({ orderCode, pdv, responsible, date, user, signature, items = [] }) {
  if (!signature) {
    toast("Este pedido ainda não possui comprovante de retirada.", "error");
    return;
  }
  const modal = document.createElement("div");
  modal.className = "photo-viewer";
  const close = () => modal.remove();
  modal.innerHTML = `
    <div class="photo-viewer-dialog damage-signature-viewer" role="dialog" aria-modal="true" aria-label="Comprovante de retirada">
      <div class="photo-viewer-head">
        <div>
          <p class="eyebrow">Comprovante de retirada</p>
          <h3>Pedido ${esc(orderCode || "")}</h3>
          <p>${esc(pdv || "-")} | ${esc(date || "-")}</p>
        </div>
        <button class="icon-action close-photo-viewer" type="button" aria-label="Fechar">&times;</button>
      </div>
      <div class="damage-detail-grid">
        <p><strong>Responsável:</strong> ${esc(responsible || "-")}</p>
        <p><strong>Entregue por:</strong> ${esc(user || "-")}</p>
      </div>
      ${table(["Produto", "Qtd retirada"], items.map((item) => `<tr><td>${esc(item.produto)}</td><td>${esc(item.liberada)}</td></tr>`))}
      <div class="order-card-actions no-print">
        <button class="btn secondary print-withdrawal-receipt" type="button">Imprimir comprovante</button>
      </div>
      <div class="photo-viewer-body signature-viewer-body">
        <img src="${esc(signature)}" alt="Assinatura do responsável pela retirada" />
      </div>
    </div>`;
  modal.querySelector(".close-photo-viewer").addEventListener("click", close);
  modal.querySelector(".print-withdrawal-receipt").addEventListener("click", () => {
    printWithdrawalReceipt({ orderCode, pdv, responsible, date, user, signature, items });
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.body.appendChild(modal);
}

// Abre o modal de confirmação de retirada do pedido (com assinatura)
function openOrderWithdrawalModal(card, { from, to, pdvId = "", onSuccess, onClose } = {}) {
  const orderCode = card?.dataset.order || "";
  const currentStatus = card?.dataset.orderStatus || "";
  const headText = card?.querySelector(".order-accordion-head strong")?.textContent || `Pedido ${orderCode}`;
  const meta = card?.querySelector(".order-accordion-head small")?.textContent || "";
  const items = orderWithdrawalItemsFromCard(card);
  if (!items.length) {
    toast("Não há produtos com quantidade liberada para confirmar retirada.", "error");
    return false;
  }
  const modal = document.createElement("div");
  modal.className = "damage-status-modal";
  modal.innerHTML = `
    <div class="damage-status-dialog order-withdrawal-dialog" role="dialog" aria-modal="true" aria-label="Confirmar retirada com assinatura">
      <div class="damage-status-dialog-head">
        <div>
          <p class="eyebrow">Confirmar retirada com assinatura</p>
          <h3>${esc(headText)}</h3>
          <p>${esc(meta)}</p>
        </div>
        <button class="icon-action close-order-withdrawal" type="button" aria-label="Fechar">&times;</button>
      </div>
      <p class="damage-status-warning">Declaro que conferi e recebi os produtos relacionados neste pedido.</p>
      ${table(["Produto", "Quantidade liberada"], items.map((item) => `<tr><td>${esc(item.produto)}</td><td>${esc(item.liberada)}</td></tr>`))}
      <label>Nome do responsável pela retirada
        <input name="responsavel_retirada" placeholder="Nome completo" autocomplete="off" />
      </label>
      <label>Observação
        <textarea name="observacao" rows="2" placeholder="Opcional"></textarea>
      </label>
      <canvas class="signature-pad order-withdrawal-signature" width="720" height="220" aria-label="Área para assinatura do responsável pela retirada"></canvas>
      <input name="assinatura" type="hidden" />
      <div class="signature-actions">
        <button class="btn secondary clear-order-withdrawal-signature" type="button">Limpar assinatura</button>
        <button class="btn secondary close-order-withdrawal" type="button">Cancelar</button>
        <button class="btn confirm-order-withdrawal" type="button" disabled>Confirmar retirada</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const canvas = modal.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const hidden = modal.querySelector("[name='assinatura']");
  const responsible = modal.querySelector("[name='responsavel_retirada']");
  const confirm = modal.querySelector(".confirm-order-withdrawal");
  let drawing = false;
  const prepareSignatureContext = () => {
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#063f48";
  };
  const clearSignatureCanvas = () => {
    drawing = false;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    prepareSignatureContext();
    ctx.beginPath();
    hidden.value = "";
    updateConfirm();
  };
  const resizeSignatureCanvas = () => {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, Math.floor(rect.width * ratio));
    canvas.height = Math.max(160, Math.floor(rect.height * ratio));
    clearSignatureCanvas();
  };
  const close = () => {
    modal.remove();
    onClose?.();
  };
  const updateConfirm = () => {
    confirm.disabled = !(responsible.value.trim() && hidden.value.length > 1200);
  };
  const pos = (event) => {
    const rect = canvas.getBoundingClientRect();
    const pointer = event.touches?.[0] || event;
    return { x: pointer.clientX - rect.left, y: pointer.clientY - rect.top };
  };
  const start = (event) => {
    drawing = true;
    const p = pos(event);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#063f48";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    event.preventDefault();
  };
  const move = (event) => {
    if (!drawing) return;
    const p = pos(event);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#063f48";
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hidden.value = canvas.toDataURL("image/png");
    updateConfirm();
    event.preventDefault();
  };
  const stop = () => {
    if (!drawing) return;
    drawing = false;
    hidden.value = canvas.toDataURL("image/png");
    updateConfirm();
  };
  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", stop);
  requestAnimationFrame(resizeSignatureCanvas);
  responsible.addEventListener("input", updateConfirm);
  modal.querySelector(".clear-order-withdrawal-signature").addEventListener("click", () => {
    clearSignatureCanvas();
  });
  modal.querySelectorAll(".close-order-withdrawal").forEach((button) => button.addEventListener("click", close));
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    const previousText = confirm.textContent;
    confirm.textContent = "Confirmando...";
    try {
      const resultado = await request("/api/admin/order-withdrawal", {
        method: "POST",
        body: JSON.stringify({
          codigo_pedido: orderCode,
          status: currentStatus,
          responsavel_retirada: responsible.value,
          observacao: modal.querySelector("[name='observacao']")?.value || "",
          assinatura: hidden.value
        })
      });
      toast("Retirada confirmada com sucesso. O pedido foi finalizado.");
      // A sobra não vira pendência: o usuário é avisado do que ficou sem atendimento
      const sobras = resultado?.sobras || [];
      if (sobras.length) {
        const naoAtendidas = sobras.reduce((soma, item) => soma + Number(item.nao_atendida || 0), 0);
        toast(`${naoAtendidas} unidade${naoAtendidas === 1 ? "" : "s"} do pedido não ${naoAtendidas === 1 ? "foi atendida" : "foram atendidas"}. Não geram pendência.`);
      }
      // Saldo central negativo não bloqueia a retirada, mas precisa ser visível
      const negativos = resultado?.saldos_negativos || [];
      if (negativos.length) {
        toast(`Estoque central negativo em ${negativos.length} produto${negativos.length === 1 ? "" : "s"} (ex: ${negativos[0].nome || negativos[0].sku} = ${negativos[0].saldo}).`, "error");
      }
      close();
      if (typeof onSuccess === "function") {
        await onSuccess();
      } else {
        await viewRelease({ from, to, pdvId, status: "Finalizado" });
      }
    } catch (error) {
      toast(error.message || "Não foi possível confirmar a retirada.", "error");
      confirm.disabled = false;
      confirm.textContent = previousText;
    }
  });
  return true;
}

// Normaliza os filtros usados na consulta de histórico
function normalizeHistoryFilters(filters = {}) {
  return {
    status: filters.status || "",
    from: filters.from || "",
    to: filters.to || "",
    pdvId: filters.pdvId || ""
  };
}

// Gera uma assinatura única para os filtros aplicados no histórico
function historyFilterSignature(filters = {}) {
  return JSON.stringify(normalizeHistoryFilters(filters));
}

// Monta os parâmetros de query da consulta de histórico
function historyQueryParams(autoOnly, filters = {}, options = {}) {
  const { includePoint = true } = options;
  const normalized = normalizeHistoryFilters(filters);
  const params = new URLSearchParams({ auto: autoOnly ? "1" : "0" });
  if (normalized.status) params.set("status", normalized.status);
  if (normalized.from) params.set("from", normalized.from);
  if (normalized.to) params.set("to", normalized.to);
  if (includePoint && normalized.pdvId) params.set("pdvId", normalized.pdvId);
  return params;
}

// View de histórico de pedidos
async function viewHistory(autoOnly, filters = {}, options = {}) {
  document.querySelectorAll(".history-actions-dropdown").forEach((menu) => menu.remove());
  const activeFilters = normalizeHistoryFilters(filters);
  const activeStatus = activeFilters.status;
  const from = activeFilters.from;
  const to = activeFilters.to;
  const pdvId = activeFilters.pdvId;
  const statuses = ["", ...orderStatuses];
  const params = historyQueryParams(autoOnly, activeFilters);
  const data = await request(`/api/admin/history?${params.toString()}`);
  const grouped = groupHistoryByPointAndDate(data.history || []);
  const periodLabel = from || to ? `${from ? moneyDate(from) : "Início"} até ${to ? moneyDate(to) : "Hoje"}` : "Todos os períodos";
  const selectedPdv = (state.pdvs || []).find((pdv) => String(pdv.id) === String(pdvId));
  const pointLabel = selectedPdv?.nome || "Todos os pontos";
  shell(`
    <section class="release-screen">
      <section class="card">
        <form id="history-filter" class="filter-panel history-filter">
          <div class="filter-copy">
            <p class="eyebrow">Histórico</p>
            <h3 class="section-title text-xl font-black">${autoOnly ? "Histórico de autopedidos" : "Histórico geral"}</h3>
          </div>
          <label class="field-select">Status
            <select name="status">
              ${statuses.map((status) => `<option value="${esc(status)}" ${status === activeStatus ? "selected" : ""}>${status || "Todos"}</option>`).join("")}
            </select>
          </label>
          <label class="field-select">Ponto
            <select name="pdvId">
              <option value="">Todos os pontos</option>
              ${(state.pdvs || []).map((pdv) => `<option value="${esc(pdv.id)}" ${String(pdv.id) === String(pdvId) ? "selected" : ""}>${esc(pdv.nome)}</option>`).join("")}
            </select>
          </label>
          <label class="field-date">De
            <input name="from" type="date" value="${esc(from)}" />
          </label>
          <label class="field-date">Até
            <input name="to" type="date" value="${esc(to)}" />
          </label>
          <div class="filter-actions history-menu-actions">
            <button class="btn" type="submit">Filtrar</button>
            <div class="history-actions-menu">
              <button class="history-actions-toggle" id="history-actions-toggle" type="button" aria-label="Opções do relatório" aria-expanded="false" aria-controls="history-actions-dropdown">
                <span></span>
                <span></span>
                <span></span>
              </button>
              <div class="sheet-actions-menu history-actions-dropdown hidden" id="history-actions-dropdown">
                <button class="btn secondary" id="export-history-current" type="button">${pdvId ? "Exportar ponto" : "Exportar planilha"}</button>
                <button class="btn secondary" id="export-history-all" type="button">Exportar todos os pontos</button>
                ${!autoOnly ? `<button class="btn secondary" id="print-history" type="button">Imprimir relatório</button>` : ""}
                ${!autoOnly ? `<button class="btn secondary" id="print-history-grouped" type="button">Imprimir agrupado por PDV</button>` : ""}
                ${!autoOnly ? `<button class="btn secondary" id="export-history-grouped" type="button">Exportar agrupado por PDV</button>` : ""}
              </div>
            </div>
          </div>
        </form>
      </section>
      <section class="grid gap-4 print-history-area">
        <div class="print-logo-header">
          <img src="/logo-print.png" alt="Aguas Correntes Park" />
          <div>
            <p class="eyebrow">Aguas Correntes Park</p>
            <h2 class="section-title text-xl font-black">${autoOnly ? "Histórico de autopedidos" : "Histórico geral"}</h2>
            <p class="text-sm font-bold text-[color:var(--ac-teal-dark)]">${esc(periodLabel)} | ${esc(pointLabel)}${activeStatus ? ` | ${esc(activeStatus)}` : ""}</p>
          </div>
        </div>
        <div class="history-screen-groups">
          ${renderHistoryPointGroups(grouped)}
        </div>
        ${renderHistoryPrintReport(grouped)}
        ${renderHistoryGroupedPrintReport(data.history || [], { periodLabel, pointLabel, statusLabel: activeStatus || "Todos" })}
      </section>
    </section>`);
  const historyForm = document.querySelector("#history-filter");
  const historyActionsToggle = document.querySelector("#history-actions-toggle");
  const historyActionsDropdown = document.querySelector("#history-actions-dropdown");
  if (historyActionsDropdown) document.body.appendChild(historyActionsDropdown);
  const formFilters = () => normalizeHistoryFilters(Object.fromEntries(new FormData(historyForm)));
  let closeHistoryActionsOnOutside = null;
  const positionHistoryActions = () => {
    if (!historyActionsToggle || !historyActionsDropdown) return;
    const rect = historyActionsToggle.getBoundingClientRect();
    const menuRect = historyActionsDropdown.getBoundingClientRect();
    const menuWidth = Math.max(menuRect.width || 270, 270);
    const left = Math.min(Math.max(12, rect.right - menuWidth), window.innerWidth - menuWidth - 12);
    const top = Math.min(rect.bottom + 8, window.innerHeight - 12);
    historyActionsDropdown.style.left = `${left}px`;
    historyActionsDropdown.style.right = "auto";
    historyActionsDropdown.style.top = `${top}px`;
  };
  const closeHistoryActions = () => {
    historyActionsDropdown?.classList.add("hidden");
    historyActionsToggle?.setAttribute("aria-expanded", "false");
    historyActionsDropdown?.removeAttribute("style");
    if (closeHistoryActionsOnOutside) {
      document.removeEventListener("click", closeHistoryActionsOnOutside);
      window.removeEventListener("resize", positionHistoryActions);
      window.removeEventListener("scroll", positionHistoryActions, true);
      closeHistoryActionsOnOutside = null;
    }
  };
  const printRenderedHistory = async ({ groupedReport = false } = {}) => {
    document.body.classList.add("printing-history");
    document.body.classList.toggle("printing-history-grouped", groupedReport);
    await waitForPrintReady(document.querySelector(".print-history-area"));
    window.print();
    schedulePrintCleanup(() => {
      document.body.classList.remove("printing-history");
      document.body.classList.remove("printing-history-grouped");
    });
  };

  historyActionsToggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isClosed = historyActionsDropdown.classList.contains("hidden");
    if (!isClosed) {
      closeHistoryActions();
      return;
    }
    historyActionsDropdown.classList.remove("hidden");
    historyActionsToggle.setAttribute("aria-expanded", "true");
    positionHistoryActions();
    requestAnimationFrame(positionHistoryActions);
    closeHistoryActionsOnOutside = (outsideEvent) => {
      if (historyActionsDropdown.contains(outsideEvent.target) || historyActionsToggle.contains(outsideEvent.target)) return;
      closeHistoryActions();
    };
    setTimeout(() => document.addEventListener("click", closeHistoryActionsOnOutside), 0);
    window.addEventListener("resize", positionHistoryActions);
    window.addEventListener("scroll", positionHistoryActions, true);
  });

  historyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await viewHistory(autoOnly, formFilters());
  });
  document.querySelector("#print-history")?.addEventListener("click", async () => {
    closeHistoryActions();
    const selectedFilters = formFilters();
    if (historyFilterSignature(selectedFilters) !== historyFilterSignature(activeFilters)) {
      await viewHistory(autoOnly, selectedFilters, { printAfterRender: true });
      return;
    }
    await printRenderedHistory();
  });
  document.querySelector("#print-history-grouped")?.addEventListener("click", async () => {
    closeHistoryActions();
    const selectedFilters = formFilters();
    if (historyFilterSignature(selectedFilters) !== historyFilterSignature(activeFilters)) {
      await viewHistory(autoOnly, selectedFilters, { printGroupedAfterRender: true });
      return;
    }
    await printRenderedHistory({ groupedReport: true });
  });
  document.querySelector("#export-history-current")?.addEventListener("click", async () => {
    closeHistoryActions();
    const selectedFilters = formFilters();
    const selectedPoint = (state.pdvs || []).find((pdv) => String(pdv.id) === String(selectedFilters.pdvId));
    const selectedPointLabel = selectedPoint?.nome || "Todos os pontos";
    const selectedData = historyFilterSignature(selectedFilters) === historyFilterSignature(activeFilters)
      ? data
      : await request(`/api/admin/history?${historyQueryParams(autoOnly, selectedFilters).toString()}`);
    exportHistoryReport(selectedData.history || [], {
      filename: selectedFilters.pdvId ? `historico_${slugFileName(selectedPointLabel)}.xlsx` : "historico_todos_os_pontos.xlsx",
      title: selectedFilters.pdvId ? `Histórico do ponto ${selectedPointLabel}` : "Histórico de todos os pontos"
    });
  });
  document.querySelector("#export-history-all")?.addEventListener("click", async () => {
    closeHistoryActions();
    const selectedFilters = formFilters();
    const allParams = historyQueryParams(autoOnly, selectedFilters, { includePoint: false });
    const allData = await request(`/api/admin/history?${allParams.toString()}`);
    exportHistoryReport(allData.history || [], { filename: "historico_todos_os_pontos.xlsx", title: "Histórico de todos os pontos" });
  });
  document.querySelector("#export-history-grouped")?.addEventListener("click", async () => {
    closeHistoryActions();
    const selectedFilters = formFilters();
    const selectedData = historyFilterSignature(selectedFilters) === historyFilterSignature(activeFilters)
      ? data
      : await request(`/api/admin/history?${historyQueryParams(autoOnly, selectedFilters).toString()}`);
    exportGroupedHistoryReport(selectedData.history || [], { filename: "historico_agrupado_por_pdv.xlsx" });
  });
  bindOrderToggles();
  if (options.printAfterRender) await printRenderedHistory();
  if (options.printGroupedAfterRender) await printRenderedHistory({ groupedReport: true });
}

// Gera a chave de data usada para agrupar o histórico
function historyDateKey(row = {}) {
  return String(row.retirada_em || row.data_hora || "").slice(0, 10) || "Sem data";
}

// Formata o rótulo de data exibido no histórico
function historyDateLabel(dateKey) {
  if (!dateKey || dateKey === "Sem data") return "Sem data";
  return moneyDate(dateKey);
}

// Agrupa os registros de histórico por ponto de venda e data
function groupHistoryByPointAndDate(rows = []) {
  const points = new Map();
  for (const row of rows) {
    const pointName = row.pdv || "Sem ponto";
    if (!points.has(pointName)) {
      points.set(pointName, { pdv: pointName, dates: new Map() });
    }
    const point = points.get(pointName);
    const dateKey = historyDateKey(row);
    if (!point.dates.has(dateKey)) {
      point.dates.set(dateKey, { dateKey, orders: new Map() });
    }
    const dateGroup = point.dates.get(dateKey);
    const orderKey = orderGroupKey(row);
    if (!dateGroup.orders.has(orderKey)) dateGroup.orders.set(orderKey, []);
    dateGroup.orders.get(orderKey).push(row);
  }
  return [...points.values()]
    .sort((left, right) => left.pdv.localeCompare(right.pdv, "pt-BR"))
    .map((point) => ({
      ...point,
      dates: [...point.dates.values()]
        .sort((left, right) => String(right.dateKey).localeCompare(String(left.dateKey)))
        .map((dateGroup) => ({
          ...dateGroup,
          orders: [...dateGroup.orders.values()].sort((left, right) => {
            const leftTime = new Date(left[0]?.retirada_em || left[0]?.data_hora || 0).getTime();
            const rightTime = new Date(right[0]?.retirada_em || right[0]?.data_hora || 0).getTime();
            return rightTime - leftTime;
          })
        }))
    }));
}

// Renderiza os grupos de histórico por ponto de venda
function renderHistoryPointGroups(pointGroups = []) {
  if (!pointGroups.length) return `<div class="card">Nenhum pedido encontrado.</div>`;
  return pointGroups.map((point) => `
    <section class="history-point-group">
      <div class="category-product-list-head">
        <strong>${esc(point.pdv)}</strong>
      </div>
      <div class="grid gap-3">
        ${point.dates.map((dateGroup) => `
          <section class="history-date-group">
            <p class="eyebrow">${esc(historyDateLabel(dateGroup.dateKey))}</p>
            <div class="grid gap-3">
              ${dateGroup.orders.map((group) => historyOrderCard(group)).join("")}
            </div>
          </section>`).join("")}
      </div>
    </section>`).join("");
}

// Formata o rótulo de horário exibido no histórico
function historyTimeLabel(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return moneyDate(value);
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Monta os metadados de cabeçalho para impressão do histórico
function historyOrderPrintMeta(first = {}) {
  const parts = [
    first.solicitante || "-",
    historyTimeLabel(first.data_hora),
    first.status || "-"
  ];
  if (first.retirada_usuario_almoxarifado) parts.push(`Almox: ${first.retirada_usuario_almoxarifado}`);
  if (first.retirada_em) parts.push(`Finalizado em ${moneyDate(first.retirada_em)}`);
  return parts.join(" | ");
}

// Monta as linhas de impressão de um pedido do histórico
function historyOrderPrintRows(group = []) {
  const first = group[0] || {};
  const observation = first.observacao
    ? `<div class="history-print-observation">Obs.: ${esc(String(first.observacao).slice(0, 180))}${String(first.observacao).length > 180 ? "..." : ""}</div>`
    : "";
  return `
    <tr class="pedido-header-row">
      <td colspan="4">
        <strong>Pedido ${esc(first.codigo_pedido || "-")} - ${esc(first.pdv || "-")}</strong>
        <span>${esc(historyOrderPrintMeta(first))}</span>
        ${observation}
      </td>
    </tr>
    ${group.map((item) => `
      <tr class="pedido-product-row">
        <td>${esc(item.produto || "-")}</td>
        <td>${esc(item.quantidade_solicitada ?? 0)}</td>
        <td>${esc(item.quantidade_liberada ?? 0)}</td>
        <td>${esc(item.status || "-")}</td>
      </tr>`).join("")}`;
}

// Monta o HTML do relatório de histórico para impressão
function renderHistoryPrintReport(pointGroups = []) {
  if (!pointGroups.length) return `<div class="history-print-report card">Nenhum pedido encontrado.</div>`;
  return `<div class="history-print-report">
    ${pointGroups.map((point) => `
      <section class="history-print-point">
        <h3>${esc(point.pdv)}</h3>
        ${point.dates.map((dateGroup) => `
          <section class="history-print-date">
            <table class="historico-pedidos-print">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Solicitado</th>
                  <th>Liberado</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr class="history-print-date-row">
                  <td colspan="4">${esc(historyDateLabel(dateGroup.dateKey))}</td>
                </tr>
                ${dateGroup.orders.map((group) => historyOrderPrintRows(group)).join("")}
              </tbody>
            </table>
          </section>`).join("")}
      </section>`).join("")}
  </div>`;
}

// Gera a chave de agrupamento por produto no histórico
function historyProductGroupKey(row = {}) {
  return `${String(row.sku_produto || "").trim()}::${String(row.produto || "").trim().toUpperCase()}`;
}

// Agrupa os produtos do histórico por PDV
function groupHistoryProductsByPdv(rows = []) {
  const points = new Map();
  for (const row of rows) {
    const pointName = row.pdv || "Sem ponto";
    if (!points.has(pointName)) points.set(pointName, { pdv: pointName, products: new Map(), orders: new Set() });
    const point = points.get(pointName);
    if (row.codigo_pedido) point.orders.add(row.codigo_pedido);
    const productKey = historyProductGroupKey(row);
    if (!point.products.has(productKey)) {
      point.products.set(productKey, {
        sku: row.sku_produto || "",
        produto: row.produto || "-",
        categoria: row.categoria || row.categoria_nome || "",
        quantidadeSolicitada: 0,
        quantidadeLiberada: 0,
        pedidos: new Set()
      });
    }
    const product = point.products.get(productKey);
    product.quantidadeSolicitada += Number(row.quantidade_solicitada || 0);
    product.quantidadeLiberada += Number(row.quantidade_liberada || 0);
    if (row.codigo_pedido) product.pedidos.add(row.codigo_pedido);
  }

  return [...points.values()]
    .sort((left, right) => left.pdv.localeCompare(right.pdv, "pt-BR"))
    .map((point) => ({
      pdv: point.pdv,
      totalPedidos: point.orders.size,
      products: [...point.products.values()]
        .sort((left, right) => left.produto.localeCompare(right.produto, "pt-BR"))
        .map((product) => ({
          ...product,
          totalPedidos: product.pedidos.size
        }))
    }));
}

// Monta o HTML do relatório de histórico agrupado por PDV para impressão
function renderHistoryGroupedPrintReport(rows = [], meta = {}) {
  const grouped = groupHistoryProductsByPdv(rows);
  if (!grouped.length) return `<div class="history-grouped-print-report card">Nenhum produto encontrado.</div>`;
  const totalPedidos = new Set(rows.map((row) => row.codigo_pedido).filter(Boolean)).size;
  const totalProdutos = rows.reduce((sum, row) => sum + Number(row.quantidade_solicitada || 0), 0);
  return `<div class="history-grouped-print-report">
    <div class="history-grouped-summary">
      <strong>Relatório agrupado por PDV</strong>
      <span>Período: ${esc(meta.periodLabel || "Todos os períodos")} | Ponto: ${esc(meta.pointLabel || "Todos os pontos")} | Status: ${esc(meta.statusLabel || "Todos")}</span>
      <span>Total de pedidos: ${esc(totalPedidos)} | Quantidade solicitada total: ${esc(totalProdutos)}</span>
    </div>
    ${grouped.map((point) => {
      const pointTotal = point.products.reduce((sum, product) => sum + product.quantidadeSolicitada, 0);
      return `
        <section class="history-print-point history-grouped-point">
          <h3>${esc(point.pdv)}</h3>
          <p class="history-grouped-point-meta">${esc(point.totalPedidos)} pedido(s) considerado(s) | ${esc(pointTotal)} unidade(s) solicitada(s)</p>
          <table class="historico-pedidos-print historico-agrupado-print">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Qtd total</th>
                <th>Qtd liberada</th>
                <th>Pedidos</th>
              </tr>
            </thead>
            <tbody>
              ${point.products.map((product) => `
                <tr class="pedido-product-row">
                  <td>${esc(product.produto)}${product.sku ? `<small>SKU ${esc(product.sku)}</small>` : ""}</td>
                  <td>${esc(product.quantidadeSolicitada)}</td>
                  <td>${esc(product.quantidadeLiberada)}</td>
                  <td>${esc(product.totalPedidos)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </section>`;
    }).join("")}
  </div>`;
}

// Normaliza um nome de arquivo removendo acentos e caracteres especiais
function slugFileName(value = "relatorio") {
  return String(value || "relatorio")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "relatorio";
}

// Garante que o nome do arquivo termine com a extensão .xlsx
function ensureXlsxFilename(filename = "relatorio.xlsx") {
  return String(filename || "relatorio.xlsx").replace(/\.(csv|tsv)$/i, ".xlsx").replace(/\.xlsx$/i, "") + ".xlsx";
}

// Formata a data para exportação do histórico
function historyExportDate(value) {
  const dateKey = historyDateKey(value);
  return dateKey || "";
}

// Formata o horário para exportação do histórico
function historyExportTime(value) {
  if (!value) return "";
  return historyTimeLabel(value);
}

// Gera e baixa uma planilha (workbook) a partir das definições de abas
function downloadWorkbook(filename, sheetDefinitions = []) {
  if (!window.XLSX?.utils?.book_new || !window.XLSX?.writeFile) {
    const firstSheet = sheetDefinitions[0];
    if (firstSheet?.rows?.length) downloadCsv(filename.replace(/\.xlsx$/i, ".csv"), firstSheet.rows);
    return;
  }

  const workbook = window.XLSX.utils.book_new();
  sheetDefinitions.forEach((definition) => {
    const rows = definition.rows || [];
    const sheet = window.XLSX.utils.aoa_to_sheet(rows);
    const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const maxRows = rows.length;
    if (definition.headerRow && maxRows >= definition.headerRow) {
      const headerIndex = definition.headerRow - 1;
      sheet["!autofilter"] = {
        ref: window.XLSX.utils.encode_range({
          s: { r: headerIndex, c: 0 },
          e: { r: Math.max(maxRows - 1, headerIndex), c: Math.max(maxCols - 1, 0) }
        })
      };
    }
    if (definition.cols?.length) sheet["!cols"] = definition.cols.map((width) => ({ wch: width }));
    window.XLSX.utils.book_append_sheet(workbook, sheet, definition.name.slice(0, 31));
  });

  window.XLSX.writeFile(workbook, ensureXlsxFilename(filename), { compression: true });
}

// Monta as linhas de dados para exportação do histórico
function buildHistoryExportRows(rows = []) {
  const headers = [
    "PDV",
    "Data",
    "Hora",
    "Pedido",
    "Status",
    "Solicitante",
    "SKU/Código",
    "Produto",
    "Categoria",
    "Quantidade solicitada",
    "Quantidade liberada",
    "Responsável retirada",
    "Data retirada",
    "Usuário almoxarifado",
    "Observação"
  ];
  const dataRows = [...rows]
    .sort((left, right) => {
      const pointDiff = String(left.pdv || "").localeCompare(String(right.pdv || ""), "pt-BR");
      if (pointDiff) return pointDiff;
      const dateDiff = String(historyDateKey(right)).localeCompare(String(historyDateKey(left)));
      if (dateDiff) return dateDiff;
      return String(left.codigo_pedido || "").localeCompare(String(right.codigo_pedido || ""));
    })
    .map((row) => [
      row.pdv || "",
      historyExportDate(row),
      historyExportTime(row.data_hora),
      row.codigo_pedido || "",
      row.status || "",
      row.solicitante || "",
      row.sku_produto || row.sku || "",
      row.produto || "",
      row.categoria || row.categoria_nome || "",
      row.quantidade_solicitada || 0,
      row.quantidade_liberada || 0,
      row.retirada_responsavel || "",
      row.retirada_em ? moneyDate(row.retirada_em) : "",
      row.retirada_usuario_almoxarifado || "",
      row.observacao || ""
    ]);
  return [headers, ...dataRows];
}

// Monta as linhas de resumo para exportação do histórico
function buildHistorySummaryRows(rows = [], title = "Histórico geral") {
  const orders = new Set(rows.map((row) => row.codigo_pedido).filter(Boolean));
  const points = new Set(rows.map((row) => row.pdv).filter(Boolean));
  const requested = rows.reduce((sum, row) => sum + Number(row.quantidade_solicitada || 0), 0);
  const released = rows.reduce((sum, row) => sum + Number(row.quantidade_liberada || 0), 0);
  return [
    ["Resumo gerencial"],
    [title],
    [],
    ["Indicador", "Valor"],
    ["Pedidos", orders.size],
    ["Pontos", points.size],
    ["Linhas de produto", rows.length],
    ["Quantidade solicitada", requested],
    ["Quantidade liberada", released]
  ];
}

// Monta as linhas de instruções da planilha exportada
function buildHistoryInstructionsRows() {
  return [
    ["Modelo ACPARK - Histórico Geral"],
    ["Use os filtros dos cabeçalhos para gerenciar por PDV, pedido, status, produto e data."],
    ["A aba Histórico Geral mostra cada produto em uma linha própria."],
    ["A aba Agrupado por PDV soma os produtos por ponto de venda, sem misturar pontos diferentes."],
    ["SKUs e códigos podem conter letras e devem ser mantidos como texto."]
  ];
}

// Exporta o relatório de histórico em planilha
function exportHistoryReport(rows = [], { filename = "historico_pedidos.xlsx", title = "Histórico geral" } = {}) {
  const historyRows = buildHistoryExportRows(rows);
  const groupedRows = buildGroupedHistoryExportRows(rows);
  downloadWorkbook(filename, [
    { name: "Instruções", rows: buildHistoryInstructionsRows(), cols: [70] },
    { name: "Histórico Geral", rows: [["Histórico geral ACPARK"], ["Pedidos exportados conforme filtros aplicados."], [], ...historyRows], headerRow: 4, cols: [18, 12, 10, 28, 22, 24, 18, 42, 22, 18, 18, 28, 22, 28, 42] },
    { name: "Agrupado por PDV", rows: [["Pedidos agrupados por PDV"], ["Produtos somados por ponto de venda."], [], ...groupedRows], headerRow: 4, cols: [18, 18, 42, 22, 20, 20, 20] },
    { name: "Resumo", rows: buildHistorySummaryRows(rows, title), headerRow: 4, cols: [34, 16] }
  ]);
}

// Monta as linhas de exportação do histórico agrupado por PDV
function buildGroupedHistoryExportRows(rows = []) {
  const headers = [
    "PDV",
    "SKU/Código",
    "Produto",
    "Categoria",
    "Quantidade solicitada total",
    "Quantidade liberada total",
    "Pedidos considerados"
  ];
  const dataRows = groupHistoryProductsByPdv(rows).flatMap((point) =>
    point.products.map((product) => [
      point.pdv,
      product.sku || "",
      product.produto || "",
      product.categoria || "",
      product.quantidadeSolicitada || 0,
      product.quantidadeLiberada || 0,
      product.totalPedidos || 0
    ])
  );
  return [headers, ...dataRows];
}

// Exporta o relatório de histórico agrupado por PDV em planilha
function exportGroupedHistoryReport(rows = [], { filename = "historico_agrupado_por_pdv.xlsx" } = {}) {
  const groupedRows = buildGroupedHistoryExportRows(rows);
  downloadWorkbook(filename, [
    { name: "Instruções", rows: buildHistoryInstructionsRows(), cols: [70] },
    { name: "Agrupado por PDV", rows: [["Pedidos agrupados por PDV"], ["Totalização por produto e ponto de venda."], [], ...groupedRows], headerRow: 4, cols: [18, 18, 42, 22, 20, 20, 20] },
    { name: "Histórico Geral", rows: [["Histórico geral ACPARK"], ["Base linha a linha usada para agrupamento."], [], ...buildHistoryExportRows(rows)], headerRow: 4, cols: [18, 12, 10, 28, 22, 24, 18, 42, 22, 18, 18, 28, 22, 28, 42] },
    { name: "Resumo", rows: buildHistorySummaryRows(rows, "Histórico agrupado por PDV"), headerRow: 4, cols: [34, 16] }
  ]);
}

// Monta o card de um pedido no histórico
function historyOrderCard(group) {
  const first = group[0];
  return `<article class="card order-accordion" data-order="${esc(first.codigo_pedido)}">
    <button class="order-accordion-head" type="button" data-toggle-order aria-expanded="false">
      <span class="order-arrow">&#9662;</span>
      <span>
        <strong>Pedido ${esc(first.codigo_pedido)} - ${esc(first.pdv)}</strong>
        <small>${esc(first.solicitante || "-")} | ${moneyDate(first.data_hora)}</small>
      </span>
      ${statusPill(first.status)}
    </button>
    <div class="order-accordion-body hidden">
      ${first.observacao ? `<p class="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-900">${esc(first.observacao)}</p>` : ""}
      ${table(["Produto", "Solicitado", "Liberado", "Status"], group.map((h) => `
        <tr>
          <td>${esc(h.produto)}</td>
          <td>${h.quantidade_solicitada}</td>
          <td>${h.quantidade_liberada}</td>
          <td>${statusPill(h.status)}</td>
        </tr>`))}
    </div>
  </article>`;
}

// View de configurações (usuários, categorias, integrações)
async function viewConfigV2() {
  const categories = categoryOptions();
  const categorySelect = (id) => `
    <div class="category-picker">
      <p class="text-sm font-bold">Categorias permitidas para este PDV</p>
      <div class="pdv-category-multi" id="${id}">
        <button class="pdv-category-toggle" id="${id}-toggle" type="button" aria-expanded="false" aria-controls="${id}-dropdown">
          <span id="${id}-summary">${categories.length ? "Selecionar categorias" : "Nenhuma categoria cadastrada"}</span>
          <span aria-hidden="true">?</span>
        </button>
        <div class="pdv-category-dropdown hidden" id="${id}-dropdown">
          <div class="pdv-category-dropdown-head">
            <label class="pdv-category-option pdv-category-option-all">
              <input id="${id}-select-all" type="checkbox" ${categories.length ? "" : "disabled"} />
              <span>Selecionar todas</span>
            </label>
            <strong id="${id}-checked-count">0 categorias selecionadas</strong>
          </div>
          <div class="pdv-category-options">
            ${categories.length
              ? categories.map((category) => `
                <label class="pdv-category-option">
                  <input type="checkbox" value="${esc(category)}" data-category-option />
                  <span>${esc(category)}</span>
                </label>`).join("")
              : `<p class="text-sm text-slate-500">Cadastre categorias nos produtos para aparecerem aqui.</p>`}
          </div>
          <div class="pdv-category-dropdown-actions">
            <button class="btn secondary" id="${id}-clear" type="button">Limpar</button>
            <button class="btn" id="${id}-add" type="button" ${categories.length ? "" : "disabled"}>Adicionar selecionadas</button>
          </div>
        </div>
      </div>
      <div class="category-picker-list" id="${id}-list">
        ${categories.length ? `<p class="text-sm text-slate-500">Nenhuma categoria adicionada ainda.</p>` : `<p class="text-sm text-slate-500">Cadastre categorias nos produtos para aparecerem aqui.</p>`}
      </div>
    </div>`;

  shell(`
    <section class="config-tabs-shell">
      <div class="config-tabs" role="tablist" aria-label="Configurações do sistema">
        <button class="config-tab is-active" type="button" data-config-tab="manage" role="tab" aria-selected="true">Gerenciar PDVs</button>
        <button class="config-tab" type="button" data-config-tab="pdv" role="tab" aria-selected="false">Criar PDV</button>
        <button class="config-tab" type="button" data-config-tab="alerts" role="tab" aria-selected="false">Alertas</button>
        <button class="config-tab" type="button" data-config-tab="security" role="tab" aria-selected="false">Segurança</button>
        <button class="config-tab" type="button" data-config-tab="apis" role="tab" aria-selected="false">APIs</button>
      </div>

      <div class="config-tab-panels">
        <section class="config-panel is-active" data-config-panel="manage" role="tabpanel">
          <form id="pdv-edit-form" class="card product-side-panel grid gap-3 hidden">
            <input name="id" type="hidden" />
            <div class="panel-head">
              <h3 class="text-xl font-black" id="pdv-edit-title">Editar PDV</h3>
              <button class="icon-action" id="close-pdv-edit-panel" type="button" title="Fechar" aria-label="Fechar">&times;</button>
            </div>
            <input name="nome" placeholder="Nome do PDV" required />
            <input name="senha" type="password" placeholder="Nova senha (opcional)" />            ${categorySelect("edit-pdv-category")}
            <div class="form-actions">
              <button class="btn secondary" id="cancel-pdv-edit" type="button">Cancelar edição</button>
              <button class="btn" type="submit">Salvar alterações</button>
            </div>
          </form>
          <section class="card mt-4">
            <div class="mb-3">
              <p class="eyebrow">Gestão</p>
              <h3 class="text-xl font-black">Gerenciar PDVs</h3>
            </div>
            ${table(["PDV", "Categorias", "Ações"], state.pdvs.map((p) => `<tr><td>${esc(p.nome)}</td><td><button class="btn secondary category-table-action" type="button" data-view-pdv-categories="${p.id}">VER</button></td><td><div class="table-actions"><button class="icon-action" type="button" data-edit-pdv="${p.id}" title="Editar PDV" aria-label="Editar PDV">&#9998;</button><button class="icon-action danger" type="button" data-delete-pdv="${p.id}" title="Excluir PDV" aria-label="Excluir PDV">&times;</button></div></td></tr>`))}
          </section>
          <section id="pdv-categories-panel" class="card product-side-panel hidden">
            <div class="panel-head">
              <div>
                <p class="eyebrow">Categorias permitidas</p>
                <h3 class="text-xl font-black" id="pdv-categories-title">PDV</h3>
              </div>
              <button class="icon-action" id="close-pdv-categories-panel" type="button" title="Fechar" aria-label="Fechar">&times;</button>
            </div>
            <div class="category-picker-list" id="pdv-categories-view"></div>
          </section>
        </section>

        <section class="config-panel hidden" data-config-panel="pdv" role="tabpanel">
          <form id="pdv-create-form" class="card grid gap-3">
            <h3 class="text-xl font-black">Criar PDV</h3>
            <input name="nome" placeholder="Nome do PDV" required />
            <input name="senha" type="password" placeholder="Senha" required />            ${categorySelect("create-pdv-category")}
            <button class="btn">Criar PDV</button>
          </form>
        </section>

        <section class="config-panel hidden" data-config-panel="alerts" role="tabpanel">
          ${renderOrderAlertSettings()}
        </section>

        <section class="config-panel hidden" data-config-panel="security" role="tabpanel">
          <form id="security-form" class="card grid gap-3">
            <h3 class="text-xl font-black">Segurança do almoxarifado</h3>
            <label class="grid gap-1 text-sm font-bold">Senha atual
              <input name="currentAdminPassword" type="password" placeholder="Digite a senha atual" autocomplete="current-password" required />
            </label>
            <label class="grid gap-1 text-sm font-bold">Nova senha
              <input name="adminPassword" type="password" placeholder="Digite a nova senha" autocomplete="new-password" minlength="4" required />
            </label>
            <label class="grid gap-1 text-sm font-bold">Confirmar nova senha
              <input name="confirmAdminPassword" type="password" placeholder="Repita a nova senha" autocomplete="new-password" minlength="4" required />
            </label>
            <button class="btn">Alterar senha</button>
          </form>
        </section>

        <section class="config-panel hidden" data-config-panel="apis" role="tabpanel">
          <form id="apis-form" class="card grid gap-3">
            <h3 class="text-xl font-black">APIs e integrações</h3>
            <p class="text-sm text-slate-500">Cadastre OMIE e outras APIs na tela Integrações. As credenciais são criptografadas e não aparecem nas respostas da API.</p>
            <button class="btn" id="open-integrations-center" type="button">Abrir central de integrações</button>
          </form>
        </section>
      </div>
    </section>`);

  const setConfigTab = (tabId) => {
    document.querySelectorAll("[data-config-tab]").forEach((button) => {
      const active = button.dataset.configTab === tabId;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll("[data-config-panel]").forEach((panel) => {
      const active = panel.dataset.configPanel === tabId;
      panel.classList.toggle("is-active", active);
      panel.classList.toggle("hidden", !active);
    });
  };
  document.querySelectorAll("[data-config-tab]").forEach((button) => button.addEventListener("click", () => setConfigTab(button.dataset.configTab)));
  document.querySelector("#open-integrations-center")?.addEventListener("click", () => route("integrations"));
  bindOrderAlertSettings();

  const categoryPickers = {};
  const setupCategoryPicker = (id, initial = []) => {
    const selected = [...initial];
    const picker = document.querySelector(`#${id}`);
    const toggle = document.querySelector(`#${id}-toggle`);
    const dropdown = document.querySelector(`#${id}-dropdown`);
    const summary = document.querySelector(`#${id}-summary`);
    const checkedCount = document.querySelector(`#${id}-checked-count`);
    const selectAll = document.querySelector(`#${id}-select-all`);
    const addButton = document.querySelector(`#${id}-add`);
    const clearButton = document.querySelector(`#${id}-clear`);
    const optionInputs = () => [...document.querySelectorAll(`#${id}-dropdown [data-category-option]`)];
    const list = document.querySelector(`#${id}-list`);
    const checkedValues = () => optionInputs()
      .filter((input) => input.checked)
      .map((input) => String(input.value || "").trim())
      .filter(Boolean);
    const close = () => {
      dropdown.classList.add("hidden");
      toggle.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      dropdown.classList.remove("hidden");
      toggle.setAttribute("aria-expanded", "true");
    };
    const clearChecks = () => {
      optionInputs().forEach((input) => {
        input.checked = false;
      });
      if (selectAll) selectAll.checked = false;
      updateCheckedState();
    };
    const updateCheckedState = () => {
      const checked = checkedValues();
      const available = optionInputs();
      if (checkedCount) {
        checkedCount.textContent = `${checked.length} ${checked.length === 1 ? "categoria selecionada" : "categorias selecionadas"}`;
      }
      if (selectAll) {
        selectAll.checked = available.length > 0 && checked.length === available.length;
        selectAll.indeterminate = checked.length > 0 && checked.length < available.length;
      }
      if (addButton) addButton.disabled = checked.length === 0;
    };
    const render = () => {
      if (summary) {
        summary.textContent = selected.length
          ? `${selected.length} ${selected.length === 1 ? "categoria adicionada" : "categorias adicionadas"}`
          : (categories.length ? "Selecionar categorias" : "Nenhuma categoria cadastrada");
      }
      list.innerHTML = selected.length
        ? selected.map((category) => `<label class="category-chip selected-chip"><input name="categorias" type="hidden" value="${esc(category)}"><span>${esc(category)}</span><button class="chip-remove" type="button" data-category="${esc(category)}" aria-label="Remover categoria">x</button></label>`).join("")
        : `<p class="text-sm text-slate-500">Nenhuma categoria adicionada ainda.</p>`;
      list.querySelectorAll(".chip-remove").forEach((button) => button.addEventListener("click", () => {
        const index = selected.indexOf(button.dataset.category);
        if (index >= 0) selected.splice(index, 1);
        render();
      }));
      updateCheckedState();
    };
    toggle?.addEventListener("click", () => {
      if (dropdown.classList.contains("hidden")) open();
      else close();
    });
    selectAll?.addEventListener("change", () => {
      const checked = selectAll.checked;
      optionInputs().forEach((input) => {
        input.checked = checked;
      });
      updateCheckedState();
    });
    optionInputs().forEach((input) => input.addEventListener("change", updateCheckedState));
    clearButton?.addEventListener("click", clearChecks);
    addButton?.addEventListener("click", () => {
      const values = checkedValues();
      const added = values.filter((value) => !selected.includes(value));
      selected.push(...added);
      clearChecks();
      close();
      render();
      toast(added.length
        ? `${added.length} ${added.length === 1 ? "categoria adicionada" : "categorias adicionadas"}.`
        : "As categorias selecionadas já estavam adicionadas."
      );
    });
    document.addEventListener("click", (event) => {
      if (!picker?.contains(event.target)) close();
    });
    categoryPickers[id] = {
      set(values) {
        selected.splice(0, selected.length, ...[...new Set((values || []).filter(Boolean))]);
        clearChecks();
        render();
      }
    };
    updateCheckedState();
    render();
  };
  setupCategoryPicker("create-pdv-category");
  setupCategoryPicker("edit-pdv-category");

  const pdvEditForm = document.querySelector("#pdv-edit-form");
  const pdvCategoriesPanel = document.querySelector("#pdv-categories-panel");
  const resetPdvEdit = () => {
    pdvEditForm.reset();
    pdvEditForm.classList.add("hidden");
    categoryPickers["edit-pdv-category"].set([]);
  };
  document.querySelector("#close-pdv-edit-panel").addEventListener("click", resetPdvEdit);
  document.querySelector("#close-pdv-categories-panel").addEventListener("click", () => pdvCategoriesPanel.classList.add("hidden"));
  document.querySelectorAll("[data-view-pdv-categories]").forEach((button) => button.addEventListener("click", () => {
    const pdv = state.pdvs.find((item) => String(item.id) === button.dataset.viewPdvCategories);
    if (!pdv) return;
    document.querySelector("#pdv-categories-title").textContent = pdv.nome;
    document.querySelector("#pdv-categories-view").innerHTML = (pdv.categorias || []).length
      ? pdv.categorias.map((category) => `<span class="category-chip selected-chip">${esc(category)}</span>`).join("")
      : `<p class="text-sm text-slate-500">Nenhuma categoria permitida.</p>`;
    pdvCategoriesPanel.classList.remove("hidden");
    pdvCategoriesPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll("[data-edit-pdv]").forEach((button) => button.addEventListener("click", () => {
    const pdv = state.pdvs.find((item) => String(item.id) === button.dataset.editPdv);
    if (!pdv) return;
    pdvEditForm.classList.remove("hidden");
    pdvEditForm.querySelector('[name="id"]').value = pdv.id;
    pdvEditForm.querySelector('[name="nome"]').value = pdv.nome || "";
    pdvEditForm.querySelector('[name="senha"]').value = "";    document.querySelector("#pdv-edit-title").textContent = `Editar PDV: ${pdv.nome}`;
    categoryPickers["edit-pdv-category"].set(pdv.categorias || []);
    setConfigTab("manage");
    pdvEditForm.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.querySelectorAll("[data-delete-pdv]").forEach((button) => button.addEventListener("click", async () => {
    const pdv = state.pdvs.find((item) => String(item.id) === button.dataset.deletePdv);
    if (!pdv) return;
    const confirmed = await confirmSystem({
      title: "Excluir PDV",
      message: `Excluir o PDV ${pdv.nome}?`,
      consequence: "Essa ação remove o acesso do ponto de venda ao sistema.",
      confirmLabel: "Excluir PDV",
      danger: true
    });
    if (!confirmed) return;
    await request("/api/admin/pdvs", { method: "DELETE", body: JSON.stringify({ id: pdv.id }) });
    toast("PDV excluído.");
    await loadBootstrap();
    route("config");
  }));
  document.querySelector("#cancel-pdv-edit").addEventListener("click", resetPdvEdit);
  pdvEditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = Object.fromEntries(formData);
    form.categorias = formData.getAll("categorias");
    await request("/api/admin/pdvs", { method: "PATCH", body: JSON.stringify(form) });
    toast("PDV atualizado.");
    await loadBootstrap();
    route("config");
  });
  document.querySelector("#pdv-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = Object.fromEntries(formData);
    form.categorias = formData.getAll("categorias");
    await request("/api/admin/pdvs", { method: "POST", body: JSON.stringify(form) });
    toast("PDV criado.");
    await loadBootstrap();
    route("config");
  });
  document.querySelector("#security-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    if (form.adminPassword !== form.confirmAdminPassword) {
      toast("A confirmação da nova senha não confere.", "error");
      return;
    }
    try {
      await request("/api/admin/config", { method: "POST", body: JSON.stringify(form) });
      toast("Senha do almoxarifado atualizada. Use a nova senha no próximo login.");
      event.currentTarget.reset();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  document.querySelector("#apis-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const form = Object.fromEntries(formData);
    await request("/api/admin/config", { method: "POST", body: JSON.stringify(form) });
    toast("APIs salvas.");
    await loadBootstrap();
  });
}

initializeAuth({ loadBootstrap, route });






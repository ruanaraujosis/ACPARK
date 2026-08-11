import { request } from "../../api/api-client.js";
import { app, state } from "../../state/app-state.js";
import { stopAutoRefresh } from "../../ui/auto-refresh.js";
import { toast } from "../../ui/notifications.js";
import { esc } from "../../ui.js";
import { parseProductsFile } from "../../utils/spreadsheets.js";

// Callbacks injetados pelo app principal (mesmo padrão do módulo de auth), evita import circular
let loadBootstrapCallback = null;
let routeCallback = null;

// Registra as funções de bootstrap e roteamento usadas ao concluir o assistente
export function configureSetup({ loadBootstrap, route }) {
  loadBootstrapCallback = loadBootstrap;
  routeCallback = route;
}

// Consulta o backend para saber se esta é uma instalação nova (sem senha do almoxarifado ainda).
// Em caso de erro de rede, assume que não precisa do assistente — não trava a tela de login à toa.
export async function verificarSetupNecessario() {
  try {
    const data = await request("/api/setup/status", { silentLoading: true });
    return Boolean(data.precisaConfigurar);
  } catch {
    return false;
  }
}

// Casca visual compartilhada pelas etapas do assistente, no mesmo estilo da tela de login
function wizardShell({ etapa, total, titulo, subtitulo, corpo }) {
  app.innerHTML = `
    <main class="login-shell grid min-h-screen place-items-center px-4 py-8">
      <section class="login-card w-full max-w-2xl overflow-hidden">
        <div class="p-6 md:p-8">
          <p class="eyebrow">Primeira configuração &middot; Etapa ${etapa} de ${total}</p>
          <h2 class="section-title mt-1 text-3xl font-black">${esc(titulo)}</h2>
          <p class="mt-2 text-slate-600">${esc(subtitulo)}</p>
          <div class="mt-6">${corpo}</div>
        </div>
      </section>
    </main>`;
}

// Ponto de entrada do assistente: sempre começa pela definição da senha do almoxarifado
export function renderSetupWizard() {
  stopAutoRefresh();
  renderPassoSenhaAdmin();
}

// Etapa 1: define a senha do almoxarifado e já autentica com ela em seguida
function renderPassoSenhaAdmin() {
  wizardShell({
    etapa: 1,
    total: 3,
    titulo: "Bem-vindo ao MyEstoque",
    subtitulo: "Esta é uma instalação nova. Antes de tudo, defina a senha de acesso do Almoxarifado.",
    corpo: `
      <form id="setup-senha-form" class="grid gap-4">
        <label class="grid gap-1 text-sm font-bold">Senha do Almoxarifado
          <input name="senha" type="password" minlength="4" required autofocus />
        </label>
        <label class="grid gap-1 text-sm font-bold">Confirmar senha
          <input name="confirmarSenha" type="password" minlength="4" required />
        </label>
        <button class="btn" type="submit">Definir senha e continuar</button>
      </form>`
  });

  document.querySelector("#setup-senha-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await request("/api/setup/senha-admin", { method: "POST", body: JSON.stringify(form) });
      // Loga automaticamente com a senha recém-definida, para seguir o assistente já autenticado
      const login = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ profile: "admin", password: form.senha })
      });
      state.user = login.user;
      renderPassoPrimeiroPdv();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

// Etapa 2: cadastra o primeiro ponto de venda — obrigatória, o sistema não é útil sem nenhum PDV
function renderPassoPrimeiroPdv() {
  wizardShell({
    etapa: 2,
    total: 3,
    titulo: "Cadastre o primeiro PDV",
    subtitulo: "Ponto de venda que vai solicitar produtos ao Almoxarifado. Você pode cadastrar outros depois.",
    corpo: `
      <form id="setup-pdv-form" class="grid gap-4">
        <label class="grid gap-1 text-sm font-bold">Nome do PDV
          <input name="nome" type="text" required autofocus placeholder="Ex: CENTRAL" />
        </label>
        <label class="grid gap-1 text-sm font-bold">Senha do PDV
          <input name="senha" type="password" minlength="4" required />
        </label>
        <button class="btn" type="submit">Cadastrar e continuar</button>
      </form>`
  });

  document.querySelector("#setup-pdv-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await request("/api/admin/pdvs", {
        method: "POST",
        body: JSON.stringify({ nome: form.nome, senha: form.senha, categorias: [] })
      });
      toast("PDV cadastrado.");
      renderPassoImportarProdutos();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

// Envia os produtos parseados da planilha em lotes, igual ao fluxo já usado na tela de produtos
async function importarProdutosEmLotes(items) {
  const tamanhoLote = 250;
  let importados = 0;
  for (let indice = 0; indice < items.length; indice += tamanhoLote) {
    const lote = items.slice(indice, indice + tamanhoLote);
    const numeroLote = Math.floor(indice / tamanhoLote) + 1;
    const totalLotes = Math.ceil(items.length / tamanhoLote);
    const data = await request("/api/admin/products/import", {
      method: "POST",
      loadingMessage: `Importando planilha... lote ${numeroLote} de ${totalLotes}`,
      body: JSON.stringify({ items: lote })
    });
    importados += Number(data.imported || lote.length);
  }
  return importados;
}

// Etapa 3: importar produtos/categorias por planilha — opcional, reaproveita o parser já existente
function renderPassoImportarProdutos() {
  wizardShell({
    etapa: 3,
    total: 3,
    titulo: "Importar produtos (opcional)",
    subtitulo: "Envie uma planilha (.xlsx, .xls, .csv) com os produtos e categorias, ou pule esta etapa e cadastre depois.",
    corpo: `
      <div class="grid gap-4">
        <label class="grid gap-1 text-sm font-bold">Planilha de produtos
          <input id="setup-import-file" type="file" accept=".xlsx,.xls,.csv,.tsv" />
        </label>
        <div class="flex gap-3">
          <button class="btn secondary" id="setup-import-skip" type="button">Pular esta etapa</button>
        </div>
      </div>`
  });

  document.querySelector("#setup-import-skip").addEventListener("click", renderConclusao);

  document.querySelector("#setup-import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const items = await parseProductsFile(file);
      if (!items.length) {
        toast("Nenhum produto reconhecido nessa planilha. Confira o cabeçalho das colunas.", "error");
        return;
      }
      const importados = await importarProdutosEmLotes(items);
      toast(`${importados} produto${importados === 1 ? "" : "s"} importado${importados === 1 ? "" : "s"}.`);
      renderConclusao();
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

// Etapa final: encerra o assistente e entra no sistema já autenticado
function renderConclusao() {
  wizardShell({
    etapa: 3,
    total: 3,
    titulo: "Tudo pronto!",
    subtitulo: "A configuração inicial foi concluída. Você já pode começar a usar o sistema.",
    corpo: `<button class="btn" id="setup-concluir" type="button">Entrar no sistema</button>`
  });

  document.querySelector("#setup-concluir").addEventListener("click", async () => {
    await loadBootstrapCallback();
    routeCallback("dashboard");
  });
}

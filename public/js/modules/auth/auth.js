import { request } from "../../api/api-client.js";
import { app, state } from "../../state/app-state.js";
import { stopAutoRefresh } from "../../ui/auto-refresh.js";
import { toast } from "../../ui/notifications.js";
import { esc } from "../../ui.js";
import { configureSetup, renderSetupWizard, verificarSetupNecessario } from "../setup/setup.js";

// Callbacks injetados pelo app principal para evitar dependência circular com o roteador
let loadBootstrapCallback = null;
let routeCallback = null;

// Registra as funções de bootstrap e roteamento usadas após o login
export function configureAuth({ loadBootstrap, route }) {
  loadBootstrapCallback = loadBootstrap;
  routeCallback = route;
}

// Renderiza a tela de login (perfil PDV/Almoxarifado) e liga os eventos do formulário
export async function renderLogin() {
  stopAutoRefresh();
  const publicPdvs = await request("/api/public/pdvs").catch(() => ({ pdvs: [] }));
  app.innerHTML = `
    <main class="login-shell grid min-h-screen place-items-center px-4 py-8">
      <section class="login-card w-full max-w-5xl overflow-hidden">
        <div class="grid md:grid-cols-[1fr_0.85fr]">
          <div class="relative min-h-[320px] bg-[linear-gradient(90deg,rgba(0,63,72,.72),rgba(0,123,135,.2)),var(--ac-hero)] bg-cover bg-center p-8 text-white">
            <div class="brand-logo mb-8 rounded-3xl bg-white/95 p-4 shadow-xl"></div>
            <p class="text-sm font-black uppercase tracking-widest text-orange-200">ACPark Gest\u00e3o</p>
            <h1 class="mt-2 text-4xl font-black leading-tight md:text-5xl">Abastecimento com controle de ponta a ponta.</h1>
            <p class="mt-4 max-w-md text-white/90">PDVs solicitam, Almoxarifado libera e o estoque acompanha vendas, devoluções e reposições automáticas.</p>
          </div>
          <div class="p-6 md:p-8">
        <p class="eyebrow">Acesso protegido</p>
        <h2 class="section-title mt-1 text-3xl font-black">Entrar no sistema</h2>
        <p class="mt-2 text-slate-600">Use o perfil do PDV ou o acesso do Almoxarifado para continuar.</p>
        <form id="login-form" class="mt-6 grid gap-4">
          <label class="grid gap-1 text-sm font-bold">Perfil
            <select name="profile" id="profile">
              <option value="pdv">PDV</option>
              <option value="admin">Almoxarifado</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm font-bold" id="pdv-field">Ponto de venda
            <select name="pdvId">${publicPdvs.pdvs.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join("")}</select>
          </label>
          <label class="grid gap-1 text-sm font-bold">Senha
            <span class="password-field">
              <input name="password" id="login-password" type="password" required />
              <button class="password-toggle" id="toggle-login-password" type="button" aria-label="Mostrar senha" title="Mostrar senha">&#128065;</button>
            </span>
          </label>
          <button class="btn" type="submit">Entrar</button>
        </form>
          </div>
        </div>
      </section>
    </main>`;

  // Esconde o seletor de PDV quando o perfil escolhido é Almoxarifado (admin)
  document.querySelector("#profile").addEventListener("change", (event) => {
    document.querySelector("#pdv-field").style.display = event.target.value === "admin" ? "none" : "grid";
  });

  // Alterna a visibilidade da senha digitada
  document.querySelector("#toggle-login-password").addEventListener("click", () => {
    const input = document.querySelector("#login-password");
    const button = document.querySelector("#toggle-login-password");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.setAttribute("aria-label", showing ? "Mostrar senha" : "Ocultar senha");
    button.setAttribute("title", showing ? "Mostrar senha" : "Ocultar senha");
  });

  // Envia as credenciais e, se aceitas, carrega os dados iniciais e navega por perfil
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const data = await request("/api/auth/login", { method: "POST", body: JSON.stringify(form) });
      state.user = data.user;
      await loadBootstrapCallback();
      routeCallback(state.user.role === "admin" ? "dashboard" : "order");
    } catch (error) {
      toast(error.message, "error");
    }
  });
}

// Ponto de entrada da autenticação: numa instalação nova mostra o assistente de primeiro uso;
// senão, tenta recuperar a sessão atual e decide entre app ou tela de login normal
export async function initializeAuth(callbacks) {
  configureAuth(callbacks);
  configureSetup(callbacks);

  const precisaConfigurar = await verificarSetupNecessario();
  if (precisaConfigurar) {
    return renderSetupWizard();
  }

  return request("/api/auth/me")
    .then(async ({ user }) => {
      state.user = user;
      if (user) {
        await loadBootstrapCallback();
        routeCallback(user.role === "admin" ? "dashboard" : "order");
      } else {
        renderLogin();
      }
    })
    .catch(renderLogin);
}



// MyControl — front da Fase 1: assistente de primeiro uso, login, casca com menu e
// Configurações > Usuários. Página própria (/mycontrol), com sessão própria (cookie mc_session),
// reaproveitando styles.css, fontes, Tailwind local e os módulos de public/js (cliente da API,
// toast, esc/table). A tela só esconde botões: toda permissão é checada de novo no servidor.
//
// Celular é requisito, não adaptação: tudo funciona a partir de 360px sem rolagem lateral da
// página (a lista de usuários vira cartões e os formulários abrem em tela cheia no celular).
import { request } from "../js/api/api-client.js";
import { toast } from "../js/ui/notifications.js";
import { esc, table } from "../js/ui.js";
// Mesmo núcleo de assinatura do MyEstoque (avaria e inventário); versão igual à dos assets daqui
import { ligarQuadroDeAssinatura } from "../js/ui/assinatura.js?v=20260925-mycontrol-fase2b";

const app = document.querySelector("#app");

// Permissão que abre Configurações > Usuários (mesma chave do catálogo no servidor)
const GERENCIAR_USUARIOS = "usuario.gerenciar";

// Cadastros da Fase 2: caminho na tela, caminho na API e permissão (a mesma checada no servidor)
const CADASTROS = {
  colaborador: { caminho: "/mycontrol/colaboradores", api: "colaboradores", permissao: "colaborador.gerenciar", singular: "colaborador", plural: "Colaboradores", secundario: "matricula" },
  ferramenta: { caminho: "/mycontrol/ferramentas", api: "ferramentas", permissao: "ferramenta.gerenciar", singular: "ferramenta", plural: "Ferramentas", secundario: "identificador" },
  veiculo: { caminho: "/mycontrol/veiculos", api: "veiculos", permissao: "veiculo.gerenciar", singular: "veículo", plural: "Veículos", secundario: "placa" }
};

// Abas de Configurações, cada uma visível só com a própria permissão
const ABAS_CONFIGURACAO = [
  { id: "usuarios", caminho: "/mycontrol/configuracoes/usuarios", titulo: "Usuários", permissao: GERENCIAR_USUARIOS },
  { id: "cargos", caminho: "/mycontrol/configuracoes/cargos", titulo: "Cargos", permissao: "cargo.gerenciar" },
  { id: "campos", caminho: "/mycontrol/configuracoes/campos", titulo: "Campos", permissao: "campos.configurar" }
];

// Estado da página: usuário logado, catálogo de permissões e lista da tela de usuários
const estado = {
  usuario: null,
  catalogo: [],
  senhaMinima: 6,
  usuarios: []
};

// Telas por caminho. Só existem as telas já feitas -- nada de tela vazia para fases futuras.
const TELAS = {
  "/mycontrol": { id: "inicio", titulo: "Início" },
  ...Object.fromEntries(Object.entries(CADASTROS).map(([entidade, c]) => [c.caminho, { id: "cadastro", entidade, titulo: c.plural, permissao: c.permissao }])),
  ...Object.fromEntries(ABAS_CONFIGURACAO.map((aba) => [aba.caminho, { id: "configuracao", aba: aba.id, titulo: "Configurações", permissao: aba.permissao }]))
};

// Itens do menu lateral: início, cadastros permitidos e Configurações (primeira aba permitida)
function itensDoMenu() {
  const itens = [["/mycontrol", "Início"]];
  for (const cadastro of Object.values(CADASTROS)) if (pode(cadastro.permissao)) itens.push([cadastro.caminho, cadastro.plural]);
  const primeiraAba = ABAS_CONFIGURACAO.find((aba) => pode(aba.permissao));
  if (primeiraAba) itens.push([primeiraAba.caminho, "Configurações"]);
  return itens;
}

// Datas de colunas TIMESTAMPTZ, sempre no horário de Brasília: completa no desktop, curta no celular
const formatoLongo = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
const formatoCurto = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Monta as duas versões da data; o CSS mostra a longa no desktop e a curta (25/09 14:32) no celular
function dataHtml(valor) {
  const data = valor ? new Date(valor) : null;
  if (!data || Number.isNaN(data.getTime())) return "—";
  return `<span class="mc-data-longa">${esc(formatoLongo.format(data))}</span><span class="mc-data-curta">${esc(formatoCurto.format(data).replace(",", ""))}</span>`;
}

// O usuário logado tem a permissão?
function pode(permissao) {
  return Boolean(estado.usuario?.permissoes?.includes(permissao));
}

// Chama a API; sessão expirada ou usuário desativado (401) volta para o login
async function api(caminho, opcoes = {}) {
  try {
    return await request(caminho, opcoes);
  } catch (erro) {
    if (erro.status === 401 && estado.usuario) {
      estado.usuario = null;
      erro.tratado = true;
      fecharModal();
      toast("Sua sessão do MyControl terminou. Entre novamente.", "error");
      history.replaceState(null, "", "/mycontrol");
      renderLogin();
    }
    throw erro;
  }
}

// Mostra o erro ao usuário, a menos que a volta ao login já tenha avisado
function avisarErro(erro) {
  if (!erro.tratado) toast(erro.message, "error");
}

// Guarda o usuário e o catálogo vindos do servidor
function guardarSessao(dados) {
  estado.usuario = dados.usuario || null;
  if (Array.isArray(dados.catalogo)) estado.catalogo = dados.catalogo;
  if (dados.senhaMinima) estado.senhaMinima = dados.senhaMinima;
}

// Rótulo legível de cada chave de permissão, a partir do catálogo do servidor
function rotuloDaPermissao(chave) {
  for (const grupo of estado.catalogo) {
    const achada = grupo.permissoes.find((p) => p.chave === chave);
    if (achada) return achada.rotulo;
  }
  return chave;
}

// Campo de texto com rótulo acima (uma coluna no celular)
function campoTexto({ nome, rotulo, ajuda = "", extra = "" }) {
  return `
    <label class="mc-campo">
      <span class="mc-rotulo">${esc(rotulo)}</span>
      <input name="${nome}" type="text" required ${extra} />
      ${ajuda ? `<small class="mc-ajuda">${esc(ajuda)}</small>` : ""}
    </label>`;
}

// Campo do login (usuário): gravado em minúsculo, então sem maiúscula automática nem corretor
function campoLogin({ autocomplete }) {
  return campoTexto({
    nome: "usuario",
    rotulo: "Usuário (login)",
    extra: `maxlength="40" autocomplete="${autocomplete}" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="text"`
  });
}

// Campo de senha com botão de mostrar/ocultar, igual ao do login do MyEstoque
function campoSenha({ nome, rotulo, autocomplete = "new-password", minimo = 0 }) {
  return `
    <label class="mc-campo">
      <span class="mc-rotulo">${esc(rotulo)}</span>
      <span class="password-field">
        <input name="${nome}" type="password" required autocomplete="${autocomplete}" autocapitalize="none" autocorrect="off" spellcheck="false" ${minimo ? `minlength="${minimo}"` : ""} />
        <button class="password-toggle" type="button" data-alternar-senha aria-label="Mostrar senha" title="Mostrar senha">&#128065;</button>
      </span>
    </label>`;
}

// Liga os botões de mostrar/ocultar senha dentro do elemento informado
function ligarAlternarSenha(raiz = document) {
  raiz.querySelectorAll("[data-alternar-senha]").forEach((botao) => {
    botao.addEventListener("click", () => {
      const input = botao.parentElement.querySelector("input");
      const mostrando = input.type === "text";
      input.type = mostrando ? "password" : "text";
      botao.setAttribute("aria-label", mostrando ? "Mostrar senha" : "Ocultar senha");
      botao.setAttribute("title", mostrando ? "Mostrar senha" : "Ocultar senha");
    });
  });
}

// Casca das telas sem sessão (assistente e login), no mesmo visual do login do MyEstoque
function telaDeAcesso({ eyebrow, titulo, subtitulo, corpo }) {
  app.innerHTML = `
    <main class="login-shell grid min-h-screen place-items-center px-4 py-8">
      <section class="login-card w-full max-w-5xl overflow-hidden">
        <div class="grid md:grid-cols-[1fr_0.85fr]">
          <div class="mc-acesso-hero relative bg-[linear-gradient(90deg,rgba(0,63,72,.72),rgba(0,123,135,.2)),var(--ac-hero)] bg-cover bg-center text-white">
            <div class="brand-logo mb-6 rounded-3xl bg-white/95 p-4 shadow-xl"></div>
            <p class="text-sm font-black uppercase tracking-widest text-orange-200">MyControl</p>
            <h1 class="mc-acesso-titulo mt-2 font-black leading-tight">Controle interno com acesso por usuário.</h1>
            <p class="mt-4 max-w-md text-white/90">Cada pessoa entra com o próprio usuário e só vê o que suas permissões liberam.</p>
          </div>
          <div class="mc-acesso-corpo">
            <p class="eyebrow">${esc(eyebrow)}</p>
            <h2 class="section-title mt-1 text-3xl font-black">${esc(titulo)}</h2>
            <p class="mt-2 text-slate-600">${esc(subtitulo)}</p>
            <div class="mt-6">${corpo}</div>
            <p class="mt-6"><a class="mc-link-discreto" href="/">Ir para o MyEstoque</a></p>
          </div>
        </div>
      </section>
    </main>`;
  ligarAlternarSenha(app);
}

// Assistente de primeiro uso: cria o primeiro usuário (com todas as permissões) e já entra
function renderAssistente() {
  telaDeAcesso({
    eyebrow: "Primeira configuração",
    titulo: "Bem-vindo ao MyControl",
    subtitulo: "Ainda não existe nenhum usuário. Crie o primeiro: ele terá todas as permissões e poderá cadastrar os demais.",
    corpo: `
      <form id="mc-assistente-form" class="mc-form">
        ${campoTexto({ nome: "nome", rotulo: "Nome", extra: 'maxlength="120" autocomplete="name" autocapitalize="words" autofocus' })}
        ${campoLogin({ autocomplete: "username" })}
        ${campoSenha({ nome: "senha", rotulo: `Senha (mínimo ${estado.senhaMinima} caracteres)`, minimo: estado.senhaMinima })}
        ${campoSenha({ nome: "confirmarSenha", rotulo: "Confirmar senha", minimo: estado.senhaMinima })}
        <button class="btn mc-botao-cheio" type="submit">Criar usuário e entrar</button>
      </form>`
  });

  document.querySelector("#mc-assistente-form").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = evento.currentTarget.querySelector("button[type=submit]");
    const dados = Object.fromEntries(new FormData(evento.currentTarget));
    if (dados.senha !== dados.confirmarSenha) return toast("A confirmação da senha não confere.", "error");
    botao.disabled = true;
    try {
      guardarSessao(await request("/api/mycontrol/setup/primeiro-usuario", { method: "POST", body: JSON.stringify(dados) }));
      toast("Usuário criado. Bem-vindo ao MyControl!");
      navegar("/mycontrol/configuracoes/usuarios", { substituir: true });
    } catch (erro) {
      toast(erro.message, "error");
      // Se outra pessoa concluiu o assistente antes, a tela certa agora é o login
      if (erro.status === 403) renderLogin();
    } finally {
      botao.disabled = false;
    }
  });
}

// Tela de login do MyControl (usuário e senha próprios, independentes do MyEstoque)
function renderLogin() {
  telaDeAcesso({
    eyebrow: "Acesso protegido",
    titulo: "Entrar no MyControl",
    subtitulo: "Use o usuário e a senha cadastrados no MyControl.",
    corpo: `
      <form id="mc-login-form" class="mc-form">
        ${campoLogin({ autocomplete: "username" })}
        ${campoSenha({ nome: "senha", rotulo: "Senha", autocomplete: "current-password" })}
        <button class="btn mc-botao-cheio" type="submit">Entrar</button>
      </form>`
  });

  document.querySelector("#mc-login-form").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const dados = Object.fromEntries(new FormData(evento.currentTarget));
    try {
      guardarSessao(await request("/api/mycontrol/auth/login", { method: "POST", body: JSON.stringify(dados) }));
      renderizarRota();
    } catch (erro) {
      toast(erro.message, "error");
    }
  });
}

// Casca das telas logadas: barra do topo e menu lateral no mesmo padrão do MyEstoque.
// O botão "MyEstoque" fica no cabeçalho, ao lado das 3 barras, e abre na mesma janela.
function casca(conteudo) {
  const itens = itensDoMenu();
  app.innerHTML = `
    <div class="app-shell min-h-screen">
      <nav class="site-topbar sticky top-0 z-30">
        <div class="app-topbar-inner flex items-center justify-between gap-3 px-4 py-2">
          <div class="flex min-w-0 items-center gap-3">
            <div class="brand-logo" aria-label="Aguas Correntes Park"></div>
            <div class="hidden sm:block">
              <p class="eyebrow">Sistema interno</p>
              <h1 class="text-xl font-black text-[color:var(--ac-teal-dark)]">MyControl</h1>
            </div>
          </div>
          <div class="menu-wrap">
            <a class="troca-sistema" href="/" title="Abrir o MyEstoque" aria-label="Abrir o MyEstoque"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 8h13l-3.5-3.5"/><path d="M20 16H7l3.5 3.5"/></svg><span>MyEstoque</span></a>
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
            <h3 class="section-title text-xl font-black">MyControl</h3>
          </div>
          <button class="side-close" id="side-close" type="button" aria-label="Fechar menu">&times;</button>
        </div>
        <div class="side-user">
          <span>Conectado</span>
          <strong class="mc-nome">${esc(estado.usuario.nome)}</strong>
        </div>
        <div class="side-menu-list">
          ${itens.map(([caminho, titulo]) => `<button class="side-link nav-btn" type="button" data-caminho="${caminho}">${esc(titulo)}</button>`).join("")}
        </div>
        <button class="btn danger side-logout" id="logout" type="button">Sair</button>
      </aside>
      <main class="app-main app-main-internal mc-main py-5">
        <div class="mb-4">
          <p class="eyebrow">Conectado como</p>
          <h2 class="section-title mc-nome text-2xl font-black">${esc(estado.usuario.nome)}</h2>
        </div>
        ${conteudo}
      </main>
    </div>`;

  const menu = document.querySelector("#nav-menu");
  const fundo = document.querySelector("#sidebar-backdrop");
  const alternar = document.querySelector("#menu-toggle");
  // Abre/fecha o menu lateral
  const abrirMenu = (abrir) => {
    menu.classList.toggle("is-open", abrir);
    menu.setAttribute("aria-hidden", abrir ? "false" : "true");
    fundo.classList.toggle("hidden", !abrir);
    alternar.classList.toggle("is-open", abrir);
    alternar.setAttribute("aria-expanded", abrir ? "true" : "false");
  };
  alternar.addEventListener("click", () => abrirMenu(!menu.classList.contains("is-open")));
  document.querySelector("#side-close").addEventListener("click", () => abrirMenu(false));
  fundo.addEventListener("click", () => abrirMenu(false));
  document.querySelectorAll("[data-caminho]").forEach((botao) => botao.addEventListener("click", () => {
    abrirMenu(false);
    navegar(botao.dataset.caminho);
  }));
  document.querySelector("#logout").addEventListener("click", sair);
}

// Encerra só a sessão do MyControl; o login do MyEstoque no mesmo navegador continua
async function sair() {
  try {
    await request("/api/mycontrol/auth/logout", { method: "POST" });
  } catch {
    // Mesmo sem resposta do servidor, a tela volta para o login
  }
  estado.usuario = null;
  history.replaceState(null, "", "/mycontrol");
  renderLogin();
}

// Selos de permissão (quebram de linha sem empurrar o layout); "todas" vira um selo só
function selosDePermissao(permissoes) {
  const total = estado.catalogo.reduce((soma, grupo) => soma + grupo.permissoes.length, 0);
  if (total && permissoes.length === total) return '<span class="mc-selo is-todas">Todas as permissões</span>';
  return permissoes.map((chave) => `<span class="mc-selo">${esc(rotuloDaPermissao(chave))}</span>`).join("");
}

// Tela inicial: quem está logado e o que o usuário pode fazer nesta versão
function renderInicio() {
  // Atalhos para as telas que a pessoa pode abrir (os mesmos itens do menu, menos o Início)
  const atalhos = itensDoMenu().slice(1);
  casca(`
    <section class="card mc-cartao">
      <p class="eyebrow">Início</p>
      <h3 class="mc-nome text-xl font-black">Olá, ${esc(estado.usuario.nome)}</h3>
      ${atalhos.length
        ? `<div class="mc-atalhos">${atalhos.map(([caminho, titulo]) => `<button class="btn secondary mc-atalho" type="button" data-atalho="${caminho}">${esc(titulo)}</button>`).join("")}</div>`
        : `<p class="text-slate-600">As telas liberadas pelas suas permissões aparecerão no menu conforme forem disponibilizadas.</p>`}
      <div>
        <p class="text-sm font-bold text-slate-600">Suas permissões</p>
        <div class="mc-selos mt-2">${estado.usuario.permissoes.map((chave) => `<span class="mc-selo">${esc(rotuloDaPermissao(chave))}</span>`).join("")}</div>
      </div>
    </section>`);
  document.querySelectorAll("[data-atalho]").forEach((botao) => botao.addEventListener("click", () => navegar(botao.dataset.atalho)));
}

// ===== Modal (criar usuário, editar, redefinir senha) =====
// Desktop: janela central com rolagem interna. Celular: tela cheia (100dvh), corpo rolando por
// dentro e rodapé de ações sempre visível, respeitando a área segura do aparelho.

// Fecha o modal aberto, se houver
function fecharModal() {
  document.querySelector(".mc-modal-fundo")?.remove();
  document.body.classList.remove("mc-modal-aberto");
  document.removeEventListener("keydown", fecharComEsc);
}

// Esc fecha o modal
function fecharComEsc(evento) {
  if (evento.key === "Escape") fecharModal();
}

// Abre o modal com um formulário; `aoEnviar(form)` devolve true para fechar
function abrirModal({ titulo, corpo, textoSalvar, aoEnviar, aoAbrir }) {
  fecharModal();
  const fundo = document.createElement("div");
  fundo.className = "mc-modal-fundo";
  fundo.innerHTML = `
    <form class="mc-modal" role="dialog" aria-modal="true" aria-labelledby="mc-modal-titulo">
      <header class="mc-modal-topo">
        <h3 class="mc-nome text-xl font-black" id="mc-modal-titulo">${esc(titulo)}</h3>
        <button class="mc-modal-fechar" type="button" data-fechar-modal title="Fechar" aria-label="Fechar">&times;</button>
      </header>
      <div class="mc-modal-corpo">${corpo}</div>
      <footer class="mc-modal-rodape">
        <button class="btn secondary" type="button" data-fechar-modal>Cancelar</button>
        <button class="btn" type="submit">${esc(textoSalvar)}</button>
      </footer>
    </form>`;
  document.body.appendChild(fundo);
  document.body.classList.add("mc-modal-aberto");
  document.addEventListener("keydown", fecharComEsc);
  const form = fundo.querySelector("form");
  fundo.querySelectorAll("[data-fechar-modal]").forEach((botao) => botao.addEventListener("click", fecharModal));
  ligarAlternarSenha(fundo);
  aoAbrir?.(form);
  form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const salvar = form.querySelector("button[type=submit]");
    salvar.disabled = true;
    try {
      if (await aoEnviar(form)) fecharModal();
    } catch (erro) {
      avisarErro(erro);
    } finally {
      salvar.disabled = false;
    }
  });
  form.querySelector("input:not([type=hidden]):not([disabled])")?.focus();
}

// Caixas de permissão agrupadas, com atalho "marcar todas". `travarGerenciar` desabilita a
// caixa de usuario.gerenciar quando a pessoa edita a si mesma (o servidor também recusa).
function blocoPermissoes(marcadas = [], { travarGerenciar = false } = {}) {
  return `
    <div class="mc-permissoes" data-permissoes>
      <div class="mc-permissoes-topo">
        <span class="mc-rotulo">Permissões</span>
        <label class="mc-marcar-todas"><input type="checkbox" data-marcar-todas /> <span>Marcar todas</span></label>
      </div>
      <div class="mc-permissoes-grupos">
        ${estado.catalogo.map((grupo) => `
          <fieldset class="mc-grupo">
            <legend>${esc(grupo.rotulo)}</legend>
            ${grupo.permissoes.map((permissao) => {
              const travada = travarGerenciar && permissao.chave === GERENCIAR_USUARIOS;
              return `
                <label class="mc-permissao">
                  <input type="checkbox" name="permissoes" value="${esc(permissao.chave)}" ${marcadas.includes(permissao.chave) ? "checked" : ""} ${travada ? "disabled" : ""} />
                  <span>${esc(permissao.rotulo)}${travada ? "<small>Você não pode tirar esta permissão de si mesmo.</small>" : ""}</span>
                </label>`;
            }).join("")}
          </fieldset>`).join("")}
      </div>
    </div>`;
}

// Liga o "marcar todas" de um bloco de permissões e mantém a caixa dele coerente
function ligarPermissoes(raiz) {
  const bloco = raiz.querySelector("[data-permissoes]");
  if (!bloco) return;
  const todas = bloco.querySelector("[data-marcar-todas]");
  const caixas = () => [...bloco.querySelectorAll('input[name="permissoes"]')];
  const sincronizar = () => {
    todas.checked = caixas().every((caixa) => caixa.checked);
  };
  todas.addEventListener("change", () => {
    caixas().filter((caixa) => !caixa.disabled).forEach((caixa) => {
      caixa.checked = todas.checked;
    });
    sincronizar();
  });
  caixas().forEach((caixa) => caixa.addEventListener("change", sincronizar));
  sincronizar();
}

// Permissões marcadas num formulário (caixa travada e marcada também conta: é a que se mantém)
function permissoesMarcadas(formulario) {
  return [...formulario.querySelectorAll('input[name="permissoes"]')].filter((caixa) => caixa.checked).map((caixa) => caixa.value);
}

// ===== Configurações > Usuários =====

// Busca a lista de usuários e o catálogo atualizados
async function carregarUsuarios() {
  const dados = await api("/api/mycontrol/usuarios");
  estado.usuarios = dados.usuarios;
  estado.catalogo = dados.catalogo;
  estado.senhaMinima = dados.senhaMinima || estado.senhaMinima;
}

// Relê a própria sessão (as permissões do usuário logado podem ter mudado nesta tela)
async function atualizarSessao() {
  guardarSessao(await api("/api/mycontrol/auth/me", { silentLoading: true }));
  if (!estado.usuario) renderLogin();
}

// Linha da lista de usuários. No desktop é uma linha de tabela; no celular o CSS a transforma
// em cartão: nome em destaque, login e situação logo abaixo, ações no rodapé.
function linhaUsuario(usuario) {
  const ehVoce = usuario.id === estado.usuario.id;
  return `
    <tr>
      <td class="mc-col-nome"><strong class="mc-nome">${esc(usuario.nome)}</strong>${ehVoce ? '<span class="mc-voce">(você)</span>' : ""}</td>
      <td class="mc-col-login"><span class="mc-login">${esc(usuario.usuario)}</span></td>
      <td class="mc-col-permissoes"><div class="mc-selos">${selosDePermissao(usuario.permissoes)}</div></td>
      <td class="mc-col-situacao">${usuario.ativo ? '<span class="mc-chip">Ativo</span>' : '<span class="mc-chip is-inativo">Desativado</span>'}</td>
      <td class="mc-col-acesso"><span class="mc-rotulo-cartao">Último acesso</span> ${dataHtml(usuario.ultimo_login_em)}</td>
      <td class="mc-col-acoes">
        <div class="mc-acoes">
          <button class="btn secondary mc-acao" type="button" data-editar="${usuario.id}">Editar</button>
          <button class="btn secondary mc-acao" type="button" data-senha="${usuario.id}">Senha</button>
          ${ehVoce ? "" : usuario.ativo
            ? `<button class="btn mc-acao mc-acao-perigo" type="button" data-ativo="${usuario.id}" data-valor="false">Desativar</button>`
            : `<button class="btn secondary mc-acao mc-acao-reativar" type="button" data-ativo="${usuario.id}" data-valor="true">Reativar</button>`}
        </div>
      </td>
    </tr>`;
}

// Modal de criação de usuário
function abrirCriarUsuario() {
  abrirModal({
    titulo: "Novo usuário",
    textoSalvar: "Criar usuário",
    corpo: `
      <div class="mc-form">
        <div class="mc-form-grade">
          ${campoTexto({ nome: "nome", rotulo: "Nome", extra: 'maxlength="120" autocomplete="off" autocapitalize="words"' })}
          ${campoTexto({
            nome: "usuario",
            rotulo: "Usuário (login)",
            ajuda: "De 3 a 40 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.",
            extra: 'maxlength="40" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"'
          })}
          ${campoSenha({ nome: "senha", rotulo: `Senha (mínimo ${estado.senhaMinima} caracteres)`, minimo: estado.senhaMinima })}
          ${campoSenha({ nome: "confirmarSenha", rotulo: "Confirmar senha", minimo: estado.senhaMinima })}
        </div>
        ${blocoPermissoes()}
      </div>`,
    aoAbrir: (form) => ligarPermissoes(form),
    aoEnviar: async (form) => {
      const dados = Object.fromEntries(new FormData(form));
      if (dados.senha !== dados.confirmarSenha) {
        toast("A confirmação da senha não confere.", "error");
        return false;
      }
      const permissoes = permissoesMarcadas(form);
      if (!permissoes.length) {
        toast("Marque pelo menos uma permissão.", "error");
        return false;
      }
      await api("/api/mycontrol/usuarios", {
        method: "POST",
        body: JSON.stringify({ nome: dados.nome, usuario: dados.usuario, senha: dados.senha, confirmarSenha: dados.confirmarSenha, permissoes })
      });
      toast("Usuário criado.");
      fecharModal();
      renderUsuarios();
      return true;
    }
  });
}

// Modal de edição (nome e permissões)
function abrirEditarUsuario(usuario) {
  const ehVoce = usuario.id === estado.usuario.id;
  abrirModal({
    titulo: `Editar ${usuario.nome}`,
    textoSalvar: "Salvar alterações",
    corpo: `
      <div class="mc-form">
        <p class="text-sm text-slate-600">Login: <span class="mc-login">${esc(usuario.usuario)}</span></p>
        ${campoTexto({ nome: "nome", rotulo: "Nome", extra: 'maxlength="120" autocomplete="off" autocapitalize="words"' })}
        ${blocoPermissoes(usuario.permissoes, { travarGerenciar: ehVoce && usuario.permissoes.includes(GERENCIAR_USUARIOS) })}
      </div>`,
    aoAbrir: (form) => {
      form.elements.nome.value = usuario.nome;
      ligarPermissoes(form);
    },
    aoEnviar: async (form) => {
      await api(`/api/mycontrol/usuarios/${usuario.id}`, {
        method: "PATCH",
        body: JSON.stringify({ nome: form.elements.nome.value, permissoes: permissoesMarcadas(form) })
      });
      toast("Usuário atualizado.");
      fecharModal();
      await atualizarSessao();
      // Se a própria pessoa perdeu o acesso a esta tela, volta para o início
      if (!pode(GERENCIAR_USUARIOS)) navegar("/mycontrol", { substituir: true });
      else renderUsuarios();
      return true;
    }
  });
}

// Modal de redefinição de senha
function abrirRedefinirSenha(usuario) {
  abrirModal({
    titulo: `Redefinir senha de ${usuario.nome}`,
    textoSalvar: "Redefinir senha",
    corpo: `
      <div class="mc-form">
        ${campoSenha({ nome: "senha", rotulo: `Nova senha (mínimo ${estado.senhaMinima} caracteres)`, minimo: estado.senhaMinima })}
        ${campoSenha({ nome: "confirmarSenha", rotulo: "Confirmar nova senha", minimo: estado.senhaMinima })}
      </div>`,
    aoEnviar: async (form) => {
      const dados = Object.fromEntries(new FormData(form));
      if (dados.senha !== dados.confirmarSenha) {
        toast("A confirmação da senha não confere.", "error");
        return false;
      }
      await api(`/api/mycontrol/usuarios/${usuario.id}/senha`, { method: "POST", body: JSON.stringify(dados) });
      toast("Senha redefinida.");
      return true;
    }
  });
}

// Desativa ou reativa, sempre com confirmação
async function alternarAtivo(usuario, ativar) {
  const pergunta = ativar
    ? `Reativar ${usuario.nome}? O acesso ao MyControl volta a funcionar.`
    : `Desativar ${usuario.nome}? O acesso ao MyControl é cortado imediatamente, mesmo se estiver com a tela aberta.`;
  if (!window.confirm(pergunta)) return;
  try {
    await api(`/api/mycontrol/usuarios/${usuario.id}/ativo`, { method: "POST", body: JSON.stringify({ ativo: ativar }) });
    toast(ativar ? "Usuário reativado." : "Usuário desativado.");
    renderUsuarios();
  } catch (erro) {
    avisarErro(erro);
  }
}

// Configurações > Usuários, no padrão visual de "Gerenciar PDVs" do MyEstoque
async function renderUsuarios() {
  try {
    await carregarUsuarios();
  } catch (erro) {
    avisarErro(erro);
    if (erro.status === 403) navegar("/mycontrol", { substituir: true });
    return;
  }

  casca(`
    ${abasDeConfiguracao("usuarios")}
    <section class="card mc-cartao mc-lista">
      <div class="mc-barra">
        <div class="mc-barra-titulo">
          <p class="eyebrow">Configurações</p>
          <h3 class="text-xl font-black">Usuários do MyControl</h3>
        </div>
        <button class="btn mc-botao-cheio-celular" type="button" id="mc-novo-usuario">Novo usuário</button>
        <p class="mc-barra-ajuda text-sm text-slate-500">Usuário não é excluído: desative para cortar o acesso na hora, sem perder o histórico.</p>
      </div>
      ${table(["Nome", "Usuário", "Permissões", "Situação", "Último acesso", "Ações"], estado.usuarios.map(linhaUsuario))}
    </section>`);

  const acharUsuario = (id) => estado.usuarios.find((usuario) => usuario.id === Number(id));
  document.querySelector("#mc-novo-usuario").addEventListener("click", abrirCriarUsuario);
  document.querySelectorAll("[data-editar]").forEach((botao) => botao.addEventListener("click", () => {
    const usuario = acharUsuario(botao.dataset.editar);
    if (usuario) abrirEditarUsuario(usuario);
  }));
  document.querySelectorAll("[data-senha]").forEach((botao) => botao.addEventListener("click", () => {
    const usuario = acharUsuario(botao.dataset.senha);
    if (usuario) abrirRedefinirSenha(usuario);
  }));
  document.querySelectorAll("[data-ativo]").forEach((botao) => botao.addEventListener("click", () => {
    const usuario = acharUsuario(botao.dataset.ativo);
    if (usuario) alternarAtivo(usuario, botao.dataset.valor === "true");
  }));
  ligarAbasDeConfiguracao();
}

// Troca de tela pela URL (/mycontrol/...), sem recarregar a página
function navegar(caminho, { substituir = false } = {}) {
  if (substituir) history.replaceState(null, "", caminho);
  else if (location.pathname !== caminho) history.pushState(null, "", caminho);
  renderizarRota();
}

// Decide a tela pela URL atual; caminho desconhecido ou sem permissão volta ao início
function renderizarRota() {
  fecharModal();
  if (!estado.usuario) return renderLogin();
  const caminho = location.pathname.replace(/\/+$/, "") || "/mycontrol";
  const tela = TELAS[caminho];
  if (!tela || (tela.permissao && !pode(tela.permissao))) {
    history.replaceState(null, "", "/mycontrol");
    return renderInicio();
  }
  if (tela.id === "cadastro") return renderCadastro(tela.entidade);
  if (tela.id === "configuracao" && tela.aba === "usuarios") return renderUsuarios();
  if (tela.id === "configuracao" && tela.aba === "cargos") return renderCargos();
  if (tela.id === "configuracao" && tela.aba === "campos") return renderCampos();
  return renderInicio();
}

// ===== Configurações: abas =====

// Abas de Configurações (só as permitidas), com a atual marcada
function abasDeConfiguracao(atual) {
  const visiveis = ABAS_CONFIGURACAO.filter((aba) => pode(aba.permissao));
  return `
    <nav class="config-tabs mc-abas" aria-label="Configurações do MyControl">
      ${visiveis.map((aba) => `<button class="config-tab ${aba.id === atual ? "is-active" : ""}" type="button" data-aba="${aba.caminho}" ${aba.id === atual ? 'aria-current="page"' : ""}>${esc(aba.titulo)}</button>`).join("")}
    </nav>`;
}

// Liga os cliques das abas (cada aba é uma URL própria)
function ligarAbasDeConfiguracao() {
  document.querySelectorAll("[data-aba]").forEach((botao) => botao.addEventListener("click", () => navegar(botao.dataset.aba)));
}

// Confirmação antes de ações que mudam situação (desativar, excluir)
function confirmar(pergunta) {
  return window.confirm(pergunta);
}

// ===== Configurações > Cargos =====

// Linha da lista de cargos (cartão no celular/tablet)
function linhaCargo(cargo) {
  const acoes = [`<button class="btn secondary mc-acao" type="button" data-cargo-editar="${cargo.id}">Editar</button>`];
  if (cargo.ativo) acoes.push(`<button class="btn mc-acao mc-acao-perigo" type="button" data-cargo-ativo="${cargo.id}" data-valor="false">Desativar</button>`);
  else acoes.push(`<button class="btn secondary mc-acao mc-acao-reativar" type="button" data-cargo-ativo="${cargo.id}" data-valor="true">Reativar</button>`);
  // Excluir só aparece para cargo nunca usado (em uso, o servidor recusa e orienta a desativar)
  if (!cargo.em_uso) acoes.push(`<button class="btn mc-acao mc-acao-perigo" type="button" data-cargo-excluir="${cargo.id}">Excluir</button>`);
  return `
    <tr>
      <td class="mc-col-nome"><strong class="mc-nome">${esc(cargo.nome)}</strong></td>
      <td class="mc-col-login"><span class="mc-rotulo-cartao">Abreviação</span> <span class="mc-login">${esc(cargo.abreviacao)}</span></td>
      <td class="mc-col-situacao">${cargo.ativo ? '<span class="mc-chip">Ativo</span>' : '<span class="mc-chip is-inativo">Desativado</span>'}</td>
      <td class="mc-col-acesso"><span class="mc-rotulo-cartao">Colaboradores</span> ${cargo.em_uso}</td>
      <td class="mc-col-acoes"><div class="mc-acoes">${acoes.join("")}</div></td>
    </tr>`;
}

// Modal de criar/editar cargo. Ao editar, avisa que as matrículas já geradas não mudam.
function abrirCargo(cargo = null) {
  abrirModal({
    titulo: cargo ? `Editar cargo ${cargo.nome}` : "Novo cargo",
    textoSalvar: cargo ? "Salvar alterações" : "Criar cargo",
    corpo: `
      <div class="mc-form">
        ${campoTexto({ nome: "nome", rotulo: "Nome do cargo", extra: 'maxlength="60" autocomplete="off" autocapitalize="words"' })}
        ${campoTexto({
          nome: "abreviacao",
          rotulo: "Abreviação (prefixo da matrícula)",
          ajuda: "De 2 a 6 letras, sem acento nem número. Ex.: MOT gera matrículas MOT-000123.",
          extra: 'maxlength="6" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"'
        })}
        ${cargo ? '<p class="mc-aviso">Trocar a abreviação vale só para colaboradores cadastrados daqui em diante. As matrículas já geradas não mudam.</p>' : ""}
      </div>`,
    aoAbrir: (form) => {
      if (!cargo) return;
      form.elements.nome.value = cargo.nome;
      form.elements.abreviacao.value = cargo.abreviacao;
    },
    aoEnviar: async (form) => {
      const corpo = JSON.stringify({ nome: form.elements.nome.value, abreviacao: form.elements.abreviacao.value });
      const resposta = cargo
        ? await api(`/api/mycontrol/cargos/${cargo.id}`, { method: "PATCH", body: corpo })
        : await api("/api/mycontrol/cargos", { method: "POST", body: corpo });
      toast(resposta.cargo?.abreviacao_mudou ? "Cargo salvo. As matrículas já geradas continuam como estavam." : "Cargo salvo.");
      fecharModal();
      renderCargos();
      return true;
    }
  });
}

// Configurações > Cargos
async function renderCargos() {
  let cargos;
  try {
    cargos = (await api("/api/mycontrol/cargos")).cargos;
  } catch (erro) {
    avisarErro(erro);
    return;
  }
  casca(`
    ${abasDeConfiguracao("cargos")}
    <section class="card mc-cartao mc-lista">
      <div class="mc-barra">
        <div class="mc-barra-titulo">
          <p class="eyebrow">Configurações</p>
          <h3 class="text-xl font-black">Cargos</h3>
        </div>
        <button class="btn mc-botao-cheio-celular" type="button" id="mc-novo-cargo">Novo cargo</button>
        <p class="mc-barra-ajuda text-sm text-slate-500">A abreviação vira o prefixo da matrícula. Cargo em uso não é excluído: desative para ele não aparecer em colaboradores novos.</p>
      </div>
      ${table(["Nome", "Abreviação", "Situação", "Colaboradores", "Ações"], cargos.map(linhaCargo))}
    </section>`);
  ligarAbasDeConfiguracao();
  const achar = (id) => cargos.find((cargo) => cargo.id === Number(id));
  document.querySelector("#mc-novo-cargo").addEventListener("click", () => abrirCargo());
  document.querySelectorAll("[data-cargo-editar]").forEach((botao) => botao.addEventListener("click", () => abrirCargo(achar(botao.dataset.cargoEditar))));
  document.querySelectorAll("[data-cargo-ativo]").forEach((botao) => botao.addEventListener("click", async () => {
    const cargo = achar(botao.dataset.cargoAtivo);
    const ativar = botao.dataset.valor === "true";
    if (!confirmar(ativar ? `Reativar o cargo ${cargo.nome}?` : `Desativar o cargo ${cargo.nome}? Ele deixa de aparecer para colaboradores novos; quem já está nele continua.`)) return;
    try {
      await api(`/api/mycontrol/cargos/${cargo.id}/ativo`, { method: "POST", body: JSON.stringify({ ativo: ativar }) });
      toast(ativar ? "Cargo reativado." : "Cargo desativado.");
      renderCargos();
    } catch (erro) {
      avisarErro(erro);
    }
  }));
  document.querySelectorAll("[data-cargo-excluir]").forEach((botao) => botao.addEventListener("click", async () => {
    const cargo = achar(botao.dataset.cargoExcluir);
    if (!confirmar(`Excluir o cargo ${cargo.nome}? Esta ação não pode ser desfeita.`)) return;
    try {
      await api(`/api/mycontrol/cargos/${cargo.id}/excluir`, { method: "POST", body: "{}" });
      toast("Cargo excluído.");
      renderCargos();
    } catch (erro) {
      avisarErro(erro);
    }
  }));
}

// ===== Configurações > Campos =====

// Entidade escolhida na tela de Campos (lembrada enquanto a página está aberta)
let entidadeDosCampos = "colaborador";

// Rótulo legível do tipo de um campo
function rotuloDoTipo(tipos, tipo) {
  const extras = { matricula: "Matrícula (automática)", cargo: "Cargo", placa: "Placa" };
  return tipos.find((t) => t.tipo === tipo)?.rotulo || extras[tipo] || tipo;
}

// Linha da lista de campos, com subir/descer (alternativa por toque ao arrastar)
function linhaCampo(campo, indice, total, tipos) {
  const selos = [];
  if (campo.obrigatorio) selos.push('<span class="mc-selo is-obrigatorio">Obrigatório</span>');
  if (campo.travado) selos.push('<span class="mc-selo">Travado</span>');
  else if (campo.sistema) selos.push('<span class="mc-selo">Do sistema</span>');
  const acoes = [
    `<button class="btn secondary mc-acao mc-acao-icone" type="button" data-campo-subir="${campo.id}" ${indice === 0 ? "disabled" : ""} aria-label="Subir ${esc(campo.rotulo)}" title="Subir">&uarr;</button>`,
    `<button class="btn secondary mc-acao mc-acao-icone" type="button" data-campo-descer="${campo.id}" ${indice === total - 1 ? "disabled" : ""} aria-label="Descer ${esc(campo.rotulo)}" title="Descer">&darr;</button>`,
    `<button class="btn secondary mc-acao" type="button" data-campo-editar="${campo.id}">Editar</button>`
  ];
  if (!campo.travado) {
    acoes.push(campo.ativo
      ? `<button class="btn mc-acao mc-acao-perigo" type="button" data-campo-ativo="${campo.id}" data-valor="false">Desativar</button>`
      : `<button class="btn secondary mc-acao mc-acao-reativar" type="button" data-campo-ativo="${campo.id}" data-valor="true">Reativar</button>`);
  }
  if (!campo.sistema) acoes.push(`<button class="btn mc-acao mc-acao-perigo" type="button" data-campo-excluir="${campo.id}">Excluir</button>`);
  return `
    <tr>
      <td class="mc-col-nome"><strong class="mc-nome">${esc(campo.rotulo)}</strong></td>
      <td class="mc-col-login">${esc(rotuloDoTipo(tipos, campo.tipo))}</td>
      <td class="mc-col-situacao">${campo.ativo ? '<span class="mc-chip">Ativo</span>' : '<span class="mc-chip is-inativo">Desativado</span>'}</td>
      <td class="mc-col-permissoes"><div class="mc-selos">${selos.join("")}</div></td>
      <td class="mc-col-acoes"><div class="mc-acoes">${acoes.join("")}</div></td>
    </tr>`;
}

// Modal de criar/editar campo. O tipo só é escolhido na criação (depois não muda).
function abrirCampo(tipos, campo = null) {
  const opcoesTipo = tipos.map((t) => `<option value="${esc(t.tipo)}">${esc(t.rotulo)}</option>`).join("");
  abrirModal({
    titulo: campo ? `Editar campo ${campo.rotulo}` : "Novo campo",
    textoSalvar: campo ? "Salvar alterações" : "Criar campo",
    corpo: `
      <div class="mc-form">
        ${campoTexto({ nome: "rotulo", rotulo: "Nome do campo", extra: 'maxlength="60" autocomplete="off" autocapitalize="sentences"' })}
        ${campo
          ? `<p class="text-sm text-slate-600">Tipo: <strong>${esc(rotuloDoTipo(tipos, campo.tipo))}</strong> (o tipo não muda depois de criado)</p>`
          : `<label class="mc-campo"><span class="mc-rotulo">Tipo</span><select name="tipo">${opcoesTipo}</select></label>`}
        <label class="mc-campo" data-bloco-opcoes>
          <span class="mc-rotulo">Opções da lista (uma por linha)</span>
          <textarea name="opcoes" rows="5" autocapitalize="sentences"></textarea>
        </label>
        <label class="mc-marcar-todas"><input type="checkbox" name="obrigatorio" ${campo?.obrigatorio_fixo ? "disabled" : ""} /> <span>Obrigatório${campo?.obrigatorio_fixo ? " (sempre, campo do sistema)" : ""}</span></label>
      </div>`,
    aoAbrir: (form) => {
      const blocoOpcoes = form.querySelector("[data-bloco-opcoes]");
      // Opções só fazem sentido para "Lista de opções"
      const atualizarOpcoes = () => blocoOpcoes.classList.toggle("hidden", (campo ? campo.tipo : form.elements.tipo.value) !== "selecao");
      form.elements.tipo?.addEventListener("change", atualizarOpcoes);
      if (campo) {
        form.elements.rotulo.value = campo.rotulo;
        form.elements.obrigatorio.checked = campo.obrigatorio;
        form.elements.opcoes.value = (campo.opcoes || []).join("\n");
      }
      atualizarOpcoes();
    },
    aoEnviar: async (form) => {
      const tipo = campo ? campo.tipo : form.elements.tipo.value;
      const corpo = { rotulo: form.elements.rotulo.value };
      if (!campo?.obrigatorio_fixo) corpo.obrigatorio = form.elements.obrigatorio.checked;
      if (tipo === "selecao") corpo.opcoes = form.elements.opcoes.value.split("\n");
      if (campo) await api(`/api/mycontrol/campos/${campo.id}`, { method: "PATCH", body: JSON.stringify(corpo) });
      else await api("/api/mycontrol/campos", { method: "POST", body: JSON.stringify({ ...corpo, entidade: entidadeDosCampos, tipo }) });
      toast("Campo salvo.");
      fecharModal();
      renderCampos();
      return true;
    }
  });
}

// Configurações > Campos
async function renderCampos() {
  let dados;
  try {
    dados = await api(`/api/mycontrol/campos?entidade=${entidadeDosCampos}`);
  } catch (erro) {
    avisarErro(erro);
    return;
  }
  const { campos, tipos, entidades } = dados;
  casca(`
    ${abasDeConfiguracao("campos")}
    <section class="card mc-cartao mc-lista">
      <div class="mc-barra">
        <div class="mc-barra-titulo">
          <p class="eyebrow">Configurações</p>
          <h3 class="text-xl font-black">Campos dos cadastros</h3>
        </div>
        <button class="btn mc-botao-cheio-celular" type="button" id="mc-novo-campo">Novo campo</button>
        <div class="mc-segmentado" role="group" aria-label="Cadastro">
          ${Object.entries(entidades).map(([id, e]) => `<button class="btn ${id === entidadeDosCampos ? "" : "secondary"}" type="button" data-entidade="${id}" aria-pressed="${id === entidadeDosCampos}">${esc(e.plural)}</button>`).join("")}
        </div>
        <p class="mc-barra-ajuda text-sm text-slate-500">Campos travados são do sistema: podem mudar de nome e de posição, mas não saem do cadastro. Excluir um campo esconde o campo; os valores já gravados continuam guardados.</p>
      </div>
      ${table(["Campo", "Tipo", "Situação", "Regras", "Ações"], campos.map((campo, i) => linhaCampo(campo, i, campos.length, tipos)))}
    </section>`);
  ligarAbasDeConfiguracao();
  const achar = (id) => campos.find((campo) => campo.id === Number(id));
  document.querySelectorAll("[data-entidade]").forEach((botao) => botao.addEventListener("click", () => {
    entidadeDosCampos = botao.dataset.entidade;
    renderCampos();
  }));
  document.querySelector("#mc-novo-campo").addEventListener("click", () => abrirCampo(tipos));
  document.querySelectorAll("[data-campo-editar]").forEach((botao) => botao.addEventListener("click", () => abrirCampo(tipos, achar(botao.dataset.campoEditar))));
  // Subir/descer: troca o campo de posição com o vizinho e grava a lista inteira
  const mover = async (id, passo) => {
    const ids = campos.map((campo) => campo.id);
    const de = ids.indexOf(Number(id));
    const para = de + passo;
    if (de < 0 || para < 0 || para >= ids.length) return;
    [ids[de], ids[para]] = [ids[para], ids[de]];
    try {
      await api("/api/mycontrol/campos/ordem", { method: "POST", body: JSON.stringify({ entidade: entidadeDosCampos, ids }) });
      renderCampos();
    } catch (erro) {
      avisarErro(erro);
    }
  };
  document.querySelectorAll("[data-campo-subir]").forEach((botao) => botao.addEventListener("click", () => mover(botao.dataset.campoSubir, -1)));
  document.querySelectorAll("[data-campo-descer]").forEach((botao) => botao.addEventListener("click", () => mover(botao.dataset.campoDescer, 1)));
  document.querySelectorAll("[data-campo-ativo]").forEach((botao) => botao.addEventListener("click", async () => {
    const campo = achar(botao.dataset.campoAtivo);
    const ativar = botao.dataset.valor === "true";
    if (!confirmar(ativar ? `Reativar o campo ${campo.rotulo}?` : `Desativar o campo ${campo.rotulo}? Ele some dos formulários; os valores já gravados ficam guardados.`)) return;
    try {
      await api(`/api/mycontrol/campos/${campo.id}/ativo`, { method: "POST", body: JSON.stringify({ ativo: ativar }) });
      renderCampos();
    } catch (erro) {
      avisarErro(erro);
    }
  }));
  document.querySelectorAll("[data-campo-excluir]").forEach((botao) => botao.addEventListener("click", async () => {
    const campo = achar(botao.dataset.campoExcluir);
    if (!confirmar(`Excluir o campo ${campo.rotulo}? Ele deixa de aparecer em todo lugar e não pode ser recuperado pela tela.`)) return;
    try {
      await api(`/api/mycontrol/campos/${campo.id}/excluir`, { method: "POST", body: "{}" });
      toast("Campo excluído.");
      renderCampos();
    } catch (erro) {
      avisarErro(erro);
    }
  }));
}

// ===== Fotos e assinaturas =====

// Reduz a foto no navegador antes de enviar: lado maior até `lado` px em JPEG, baixando a
// qualidade até caber no limite do servidor (UPLOAD_MAX_IMAGE_MB). Foto de celular chega a
// 5-12 MB; comprimida fica com algumas centenas de KB e a qualidade continua boa para cadastro.
async function comprimirImagem(arquivo, { lado = 1600, qualidade = 0.82, limite = 8 * 1024 * 1024 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(arquivo, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Não foi possível ler esta imagem neste navegador. Tire a foto de novo ou envie um JPG/PNG.");
  }
  const escala = Math.min(1, lado / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * escala));
  canvas.height = Math.max(1, Math.round(bitmap.height * escala));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  let q = qualidade;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
  while (blob && blob.size > limite * 0.9 && q > 0.4) {
    q -= 0.1;
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
  }
  if (!blob || blob.size > limite) throw new Error("A foto continua grande demais mesmo comprimida. Tente outra.");
  return blob;
}

// Envia uma imagem ao storage e devolve o id do arquivo (foto ganha também a miniatura)
async function enviarImagem(entidade, papel, blob, { original = null } = {}) {
  const { arquivo } = await api(`/api/mycontrol/arquivos/${entidade}?papel=${papel}`, {
    method: "POST",
    body: blob,
    headers: { "Content-Type": blob.type || "image/png" },
    loadingMessage: papel === "foto" ? "Enviando foto..." : "Enviando assinatura..."
  });
  if (papel === "foto" && original) {
    const miniatura = await comprimirImagem(original, { lado: 320, qualidade: 0.72, limite: 500 * 1024 });
    await api(`/api/mycontrol/arquivos/${entidade}/${arquivo.id}/miniatura`, {
      method: "POST",
      body: miniatura,
      headers: { "Content-Type": miniatura.type },
      silentLoading: true
    });
  }
  return arquivo.id;
}

// URL de um arquivo do MyControl (miniatura para listas; a foto grande só ao tocar)
function urlArquivo(id, { miniatura = false } = {}) {
  return `/api/mycontrol/arquivos/${id}${miniatura ? "?miniatura=1" : ""}`;
}

// Mostra a foto grande por cima da tela (fecha tocando no fundo, no X ou com Esc)
function abrirFotoGrande(id, titulo) {
  const fundo = document.createElement("div");
  fundo.className = "mc-modal-fundo mc-foto-grande";
  fundo.innerHTML = `
    <figure class="mc-foto-grande-caixa">
      <button class="mc-modal-fechar" type="button" aria-label="Fechar foto">&times;</button>
      <img src="${urlArquivo(id)}" alt="${esc(titulo)}" />
      <figcaption class="mc-nome">${esc(titulo)}</figcaption>
    </figure>`;
  const fechar = () => {
    fundo.remove();
    document.removeEventListener("keydown", tecla);
  };
  const tecla = (evento) => evento.key === "Escape" && fechar();
  fundo.addEventListener("click", (evento) => (evento.target === fundo || evento.target.closest(".mc-modal-fechar")) && fechar());
  document.addEventListener("keydown", tecla);
  document.body.appendChild(fundo);
}

// ===== Cadastros (colaboradores, ferramentas, veículos) =====

// Estado da tela de cadastro aberta
const cadastro = { entidade: null, itens: [], campos: [], cargos: [], total: 0, pagina: 1, q: "", situacao: "ativos", limite: 8 * 1024 * 1024 };

// Texto do valor secundário (matrícula, placa formatada ou identificador)
function valorSecundario(entidade, item) {
  if (entidade === "colaborador") return item.matricula;
  if (entidade === "veiculo") return item.placa_formatada;
  return item.valores.identificador;
}

// Linha da lista de cadastro: miniatura, nome, dado principal, pendências e ações
function linhaCadastro(entidade, item) {
  const nome = item.valores.nome || "—";
  const foto = item.foto_id
    ? `<button class="mc-miniatura" type="button" data-foto="${item.foto_id}" data-titulo="${esc(nome)}" aria-label="Ver foto de ${esc(nome)}"><img src="${urlArquivo(item.foto_id, { miniatura: true })}" alt="" loading="lazy" width="48" height="48" /></button>`
    : '<span class="mc-miniatura is-vazia" aria-hidden="true"></span>';
  const extra = entidade === "colaborador"
    ? `<span class="mc-rotulo-cartao">Cargo</span> ${esc(item.cargo.nome)}${item.cargo.ativo ? "" : " (desativado)"}`
    : entidade === "veiculo" ? `<span class="mc-rotulo-cartao">Chave</span> <span class="mc-login">${esc(item.valores.numero_chave)}</span>` : "";
  const pendencia = item.pendencias.length ? `<span class="mc-selo is-pendente">Falta preencher: ${esc(item.pendencias.join(", "))}</span>` : "";
  return `
    <tr>
      <td class="mc-col-foto">${foto}</td>
      <td class="mc-col-nome"><strong class="mc-nome">${esc(nome)}</strong>${pendencia ? `<div class="mc-selos mt-1">${pendencia}</div>` : ""}</td>
      <td class="mc-col-login"><span class="mc-login">${esc(valorSecundario(entidade, item) || "")}</span></td>
      ${entidade === "ferramenta" ? "" : `<td class="mc-col-acesso">${extra}</td>`}
      <td class="mc-col-situacao">${item.ativo ? '<span class="mc-chip">Ativo</span>' : '<span class="mc-chip is-inativo">Desativado</span>'}</td>
      <td class="mc-col-acoes">
        <div class="mc-acoes">
          <button class="btn secondary mc-acao" type="button" data-item-editar="${item.id}">Editar</button>
          ${item.ativo
            ? `<button class="btn mc-acao mc-acao-perigo" type="button" data-item-ativo="${item.id}" data-valor="false">Desativar</button>`
            : `<button class="btn secondary mc-acao mc-acao-reativar" type="button" data-item-ativo="${item.id}" data-valor="true">Reativar</button>`}
        </div>
      </td>
    </tr>`;
}

// Campo do formulário de cadastro conforme o tipo (rótulo sempre acima; teclado certo no celular)
function campoDoCadastro(campo, item) {
  const valor = item ? item.valores[campo.chave] : null;
  const rotulo = `${esc(campo.rotulo)}${campo.obrigatorio && !campo.gerado ? ' <span class="mc-obrigatorio" aria-label="obrigatório">*</span>' : ""}`;
  const nome = `v_${campo.chave}`;
  const abrir = `<label class="mc-campo"><span class="mc-rotulo">${rotulo}</span>`;
  switch (campo.tipo) {
    case "matricula":
      return `<div class="mc-campo"><span class="mc-rotulo">${esc(campo.rotulo)}</span><p class="mc-matricula">${item ? `<span class="mc-login">${esc(item.matricula)}</span> <small>gerada pelo sistema, não muda</small>` : "<small>Gerada automaticamente ao salvar.</small>"}</p></div>`;
    case "texto":
      return `${abrir}<input name="${nome}" type="text" maxlength="${campo.max}" autocomplete="off" ${campo.maiusculo ? 'autocapitalize="characters" autocorrect="off" spellcheck="false"' : 'autocapitalize="sentences"'} /></label>`;
    case "texto_longo":
      return `${abrir}<textarea name="${nome}" rows="3" maxlength="${campo.max}" autocapitalize="sentences"></textarea></label>`;
    case "numero":
      return `${abrir}<input name="${nome}" type="text" inputmode="decimal" autocomplete="off" /></label>`;
    case "data":
      return `${abrir}<input name="${nome}" type="date" /></label>`;
    case "telefone":
      return `${abrir}<input name="${nome}" type="tel" inputmode="tel" autocomplete="off" placeholder="(62) 99999-0000" /></label>`;
    case "placa":
      return `${abrir}<input name="${nome}" type="text" maxlength="8" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABC1D23" /></label>`;
    case "selecao":
      return `${abrir}<select name="${nome}"><option value="">Escolha...</option>${campo.opcoes.map((op) => `<option>${esc(op)}</option>`).join("")}${valor && !campo.opcoes.includes(valor) ? `<option>${esc(valor)}</option>` : ""}</select></label>`;
    case "sim_nao":
      return `${abrir}<select name="${nome}"><option value="">Escolha...</option><option value="sim">Sim</option><option value="nao">Não</option></select></label>`;
    case "cargo": {
      const opcoes = cadastro.cargos.filter((c) => c.ativo || c.id === valor);
      return `${abrir}<select name="${nome}"><option value="">Escolha o cargo...</option>${opcoes.map((c) => `<option value="${c.id}">${esc(c.nome)} (${esc(c.abreviacao)})${c.ativo ? "" : " — desativado"}</option>`).join("")}</select></label>`;
    }
    case "foto":
      return `
        <div class="mc-campo" data-foto-campo="${campo.chave}">
          <span class="mc-rotulo">${rotulo}</span>
          <div class="mc-foto-campo">
            <img class="mc-foto-previa ${valor ? "" : "hidden"}" alt="Prévia da foto" ${valor ? `src="${urlArquivo(valor, { miniatura: true })}"` : ""} />
            <div class="mc-acoes">
              <label class="btn secondary mc-acao mc-botao-arquivo">${valor ? "Trocar foto" : "Tirar ou escolher foto"}
                <input type="file" accept="image/*" capture="environment" data-foto-entrada />
              </label>
              <button class="btn secondary mc-acao ${valor ? "" : "hidden"}" type="button" data-foto-remover>Remover</button>
            </div>
          </div>
        </div>`;
    case "assinatura":
      return `
        <div class="mc-campo" data-assinatura-campo="${campo.chave}">
          <span class="mc-rotulo">${rotulo}</span>
          ${valor ? `<div class="mc-assinatura-atual"><img src="${urlArquivo(valor)}" alt="Assinatura atual" /><button class="btn secondary mc-acao" type="button" data-assinar-denovo>Assinar de novo</button></div>` : ""}
          <div class="mc-assinatura-quadro ${valor ? "hidden" : ""}">
            <canvas class="signature-pad" width="720" height="220" aria-label="Área para assinar com o dedo ou o mouse"></canvas>
            <div class="mc-acoes"><button class="btn secondary mc-acao" type="button" data-assinatura-limpar>Limpar assinatura</button></div>
          </div>
        </div>`;
    default:
      return "";
  }
}

// Preenche os campos simples do formulário com os valores atuais
function preencherFormulario(form, campos, item) {
  if (!item) return;
  for (const campo of campos) {
    const entrada = form.elements[`v_${campo.chave}`];
    const valor = item.valores[campo.chave];
    if (!entrada || valor === null || valor === undefined) continue;
    if (campo.tipo === "sim_nao") entrada.value = valor ? "sim" : "nao";
    else if (campo.tipo === "placa") entrada.value = item.placa_formatada || valor;
    else entrada.value = String(valor);
  }
}

// Liga foto (prévia, troca, remoção) e assinatura (quadro compartilhado) do formulário.
// Devolve uma função que, na hora de salvar, envia as imagens novas e diz o id de cada campo.
function ligarMidias(form, entidade, item) {
  const pendentes = {};
  form.querySelectorAll("[data-foto-campo]").forEach((bloco) => {
    const chave = bloco.dataset.fotoCampo;
    const entrada = bloco.querySelector("[data-foto-entrada]");
    const previa = bloco.querySelector(".mc-foto-previa");
    const remover = bloco.querySelector("[data-foto-remover]");
    let urlLocal = null;
    entrada.addEventListener("change", async () => {
      const arquivo = entrada.files?.[0];
      if (!arquivo) return;
      try {
        const comprimida = await comprimirImagem(arquivo, { limite: cadastro.limite });
        if (urlLocal) URL.revokeObjectURL(urlLocal);
        urlLocal = URL.createObjectURL(comprimida);
        previa.src = urlLocal;
        previa.classList.remove("hidden");
        remover.classList.remove("hidden");
        pendentes[chave] = { tipo: "foto", blob: comprimida, original: arquivo };
      } catch (erro) {
        toast(erro.message, "error");
      }
      entrada.value = "";
    });
    remover.addEventListener("click", () => {
      previa.classList.add("hidden");
      previa.removeAttribute("src");
      remover.classList.add("hidden");
      pendentes[chave] = { tipo: "remover" };
    });
  });
  form.querySelectorAll("[data-assinatura-campo]").forEach((bloco) => {
    const chave = bloco.dataset.assinaturaCampo;
    const quadroEl = bloco.querySelector(".mc-assinatura-quadro");
    let quadro = null;
    // O quadro só é ligado quando fica visível (o tamanho exibido entra na conversão de escala)
    const ligar = () => {
      quadroEl.classList.remove("hidden");
      quadro ||= ligarQuadroDeAssinatura(quadroEl.querySelector("canvas"));
      pendentes[chave] = { tipo: "assinatura", quadro: () => quadro };
    };
    bloco.querySelector("[data-assinar-denovo]")?.addEventListener("click", () => {
      bloco.querySelector(".mc-assinatura-atual").classList.add("hidden");
      ligar();
    });
    bloco.querySelector("[data-assinatura-limpar]").addEventListener("click", () => quadro?.limpar());
    if (!item?.valores[chave]) ligar();
  });
  // Na hora de salvar: sobe o que mudou e devolve { chave: id | null }
  return async () => {
    const resultado = {};
    for (const [chave, pendente] of Object.entries(pendentes)) {
      if (pendente.tipo === "remover") resultado[chave] = null;
      if (pendente.tipo === "foto") resultado[chave] = await enviarImagem(entidade, "foto", pendente.blob, { original: pendente.original });
      if (pendente.tipo === "assinatura") {
        const quadro = pendente.quadro();
        if (quadro.temTinta()) resultado[chave] = await enviarImagem(entidade, "assinatura", await quadro.comoBlob());
      }
    }
    return resultado;
  };
}

// Lê os valores do formulário no formato que o servidor valida
function lerFormulario(form, campos) {
  const valores = {};
  for (const campo of campos) {
    if (campo.gerado || campo.tipo === "foto" || campo.tipo === "assinatura") continue;
    const entrada = form.elements[`v_${campo.chave}`];
    if (!entrada) continue;
    const bruto = entrada.value;
    if (campo.tipo === "sim_nao") valores[campo.chave] = bruto === "" ? null : bruto === "sim";
    else if (campo.tipo === "cargo") valores[campo.chave] = bruto ? Number(bruto) : null;
    else valores[campo.chave] = bruto.trim() === "" ? null : bruto;
  }
  return valores;
}

// Modal de criar/editar um cadastro, montado a partir dos campos ativos
function abrirCadastro(entidade, item = null) {
  const config = CADASTROS[entidade];
  const campos = cadastro.campos.filter((campo) => campo.ativo);
  let enviarMidias = null;
  abrirModal({
    titulo: item ? `Editar ${item.valores.nome || config.singular}` : `Novo ${config.singular}`.replace("Novo ferramenta", "Nova ferramenta"),
    textoSalvar: item ? "Salvar alterações" : "Cadastrar",
    corpo: `<div class="mc-form mc-form-grade">${campos.map((campo) => campoDoCadastro(campo, item)).join("")}</div>`,
    aoAbrir: (form) => {
      preencherFormulario(form, campos, item);
      enviarMidias = ligarMidias(form, entidade, item);
    },
    aoEnviar: async (form) => {
      const valores = { ...lerFormulario(form, campos), ...(await enviarMidias()) };
      const caminho = item ? `/api/mycontrol/${config.api}/${item.id}` : `/api/mycontrol/${config.api}`;
      const resposta = await api(caminho, { method: item ? "PATCH" : "POST", body: JSON.stringify({ valores }) });
      toast(item ? "Cadastro atualizado." : entidade === "colaborador" ? `Colaborador cadastrado: matrícula ${resposta.item.matricula}.` : "Cadastro criado.");
      fecharModal();
      carregarCadastro({ reiniciar: true });
      return true;
    }
  });
}

// Busca uma página da lista (reiniciar = volta à primeira página, com os filtros atuais)
async function carregarCadastro({ reiniciar = false } = {}) {
  const config = CADASTROS[cadastro.entidade];
  const pagina = reiniciar ? 1 : cadastro.pagina + 1;
  const parametros = new URLSearchParams({ situacao: cadastro.situacao, pagina: String(pagina) });
  if (cadastro.q) parametros.set("q", cadastro.q);
  let dados;
  try {
    dados = await api(`/api/mycontrol/${config.api}?${parametros}`);
  } catch (erro) {
    avisarErro(erro);
    return;
  }
  cadastro.itens = reiniciar ? dados.itens : [...cadastro.itens, ...dados.itens];
  cadastro.campos = dados.campos;
  cadastro.cargos = dados.cargos || [];
  cadastro.total = dados.total;
  cadastro.pagina = dados.pagina;
  cadastro.limite = dados.limite_imagem_bytes || cadastro.limite;
  desenharListaDoCadastro();
}

// Redesenha só a lista (a busca não perde o foco nem o teclado do celular)
function desenharListaDoCadastro() {
  const entidade = cadastro.entidade;
  const rotulo = (chave, padrao) => cadastro.campos.find((campo) => campo.chave === chave)?.rotulo || padrao;
  const cabecalhos = ["", rotulo("nome", "Nome"), rotulo(CADASTROS[entidade].secundario, "")];
  if (entidade === "colaborador") cabecalhos.push(rotulo("cargo", "Cargo"));
  if (entidade === "veiculo") cabecalhos.push(rotulo("numero_chave", "Chave"));
  cabecalhos.push("Situação", "Ações");
  const alvo = document.querySelector("#mc-cadastro-lista");
  if (!alvo) return;
  alvo.innerHTML = `
    ${table(cabecalhos, cadastro.itens.map((item) => linhaCadastro(entidade, item)))}
    <p class="mc-contagem text-sm text-slate-500">${cadastro.itens.length} de ${cadastro.total}</p>
    ${cadastro.itens.length < cadastro.total ? '<button class="btn secondary mc-botao-cheio" type="button" id="mc-carregar-mais">Carregar mais</button>' : ""}`;
  const achar = (id) => cadastro.itens.find((item) => item.id === Number(id));
  alvo.querySelector("#mc-carregar-mais")?.addEventListener("click", () => carregarCadastro());
  alvo.querySelectorAll("[data-foto]").forEach((botao) => botao.addEventListener("click", () => abrirFotoGrande(botao.dataset.foto, botao.dataset.titulo)));
  alvo.querySelectorAll("[data-item-editar]").forEach((botao) => botao.addEventListener("click", () => abrirCadastro(entidade, achar(botao.dataset.itemEditar))));
  alvo.querySelectorAll("[data-item-ativo]").forEach((botao) => botao.addEventListener("click", async () => {
    const item = achar(botao.dataset.itemAtivo);
    const ativar = botao.dataset.valor === "true";
    const nome = item.valores.nome || CADASTROS[entidade].singular;
    if (!confirmar(ativar ? `Reativar ${nome}?` : `Desativar ${nome}? O cadastro continua guardado e pode ser reativado.`)) return;
    try {
      await api(`/api/mycontrol/${CADASTROS[entidade].api}/${item.id}/ativo`, { method: "POST", body: JSON.stringify({ ativo: ativar }) });
      toast(ativar ? "Cadastro reativado." : "Cadastro desativado.");
      carregarCadastro({ reiniciar: true });
    } catch (erro) {
      avisarErro(erro);
    }
  }));
}

// Tela de um cadastro: título, novo, busca, filtro de situação e lista paginada
async function renderCadastro(entidade) {
  const config = CADASTROS[entidade];
  if (cadastro.entidade !== entidade) Object.assign(cadastro, { entidade, itens: [], q: "", situacao: "ativos", pagina: 1 });
  casca(`
    <section class="card mc-cartao mc-lista mc-lista-com-foto">
      <div class="mc-barra">
        <div class="mc-barra-titulo">
          <p class="eyebrow">Cadastros</p>
          <h3 class="text-xl font-black">${esc(config.plural)}</h3>
        </div>
        <button class="btn mc-botao-cheio-celular" type="button" id="mc-novo-item">${entidade === "ferramenta" ? "Nova ferramenta" : `Novo ${esc(config.singular)}`}</button>
        <form class="mc-filtros" id="mc-filtros" role="search">
          <label class="mc-campo mc-filtro-busca"><span class="mc-rotulo">Buscar</span>
            <input name="q" type="search" enterkeyhint="search" autocomplete="off" value="${esc(cadastro.q)}" placeholder="Nome ou ${entidade === "colaborador" ? "matrícula" : entidade === "veiculo" ? "placa ou chave" : "identificador"}" />
          </label>
          <label class="mc-campo"><span class="mc-rotulo">Situação</span>
            <select name="situacao">
              <option value="ativos" ${cadastro.situacao === "ativos" ? "selected" : ""}>Ativos</option>
              <option value="inativos" ${cadastro.situacao === "inativos" ? "selected" : ""}>Desativados</option>
              <option value="todos" ${cadastro.situacao === "todos" ? "selected" : ""}>Todos</option>
            </select>
          </label>
        </form>
      </div>
      <div id="mc-cadastro-lista"></div>
    </section>`);
  document.querySelector("#mc-novo-item").addEventListener("click", () => abrirCadastro(entidade));
  const filtros = document.querySelector("#mc-filtros");
  let espera = null;
  // Busca enquanto digita (com pausa curta) e ao trocar a situação
  const filtrar = () => {
    cadastro.q = filtros.elements.q.value.trim();
    cadastro.situacao = filtros.elements.situacao.value;
    carregarCadastro({ reiniciar: true });
  };
  filtros.addEventListener("submit", (evento) => {
    evento.preventDefault();
    filtrar();
  });
  filtros.elements.q.addEventListener("input", () => {
    clearTimeout(espera);
    espera = setTimeout(filtrar, 350);
  });
  filtros.elements.situacao.addEventListener("change", filtrar);
  await carregarCadastro({ reiniciar: true });
}

// Voltar/avançar do navegador
window.addEventListener("popstate", () => renderizarRota());

// Ponto de entrada: assistente numa instalação sem usuários; senão sessão atual ou login
async function iniciar() {
  try {
    const status = await request("/api/mycontrol/setup/status", { silentLoading: true });
    if (status.senhaMinima) estado.senhaMinima = status.senhaMinima;
    if (status.disponivel) return renderAssistente();
    guardarSessao(await request("/api/mycontrol/auth/me", { silentLoading: true }));
    renderizarRota();
  } catch (erro) {
    toast(erro.message, "error");
    renderLogin();
  }
}

iniciar();

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

const app = document.querySelector("#app");

// Permissão que abre Configurações > Usuários (mesma chave do catálogo no servidor)
const GERENCIAR_USUARIOS = "usuario.gerenciar";

// Estado da página: usuário logado, catálogo de permissões e lista da tela de usuários
const estado = {
  usuario: null,
  catalogo: [],
  senhaMinima: 6,
  usuarios: []
};

// Telas por caminho. Só existem as da Fase 1 -- nada de tela vazia para o que ainda não foi feito.
const TELAS = {
  "/mycontrol": { id: "inicio", titulo: "Início" },
  "/mycontrol/configuracoes/usuarios": { id: "usuarios", titulo: "Configurações", permissao: GERENCIAR_USUARIOS }
};

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
  const itens = Object.entries(TELAS).filter(([, tela]) => !tela.permissao || pode(tela.permissao));
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
          ${itens.map(([caminho, tela]) => `<button class="side-link nav-btn" type="button" data-caminho="${caminho}">${esc(tela.titulo)}</button>`).join("")}
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
  casca(`
    <section class="card mc-cartao">
      <p class="eyebrow">Início</p>
      <h3 class="mc-nome text-xl font-black">Olá, ${esc(estado.usuario.nome)}</h3>
      ${pode(GERENCIAR_USUARIOS)
        ? `<p class="text-slate-600">Cadastre os usuários do MyControl e defina o que cada um pode fazer em Configurações.</p>
           <div><button class="btn mc-botao-cheio-celular" type="button" id="mc-ir-usuarios">Abrir Configurações &rsaquo; Usuários</button></div>`
        : `<p class="text-slate-600">As telas liberadas pelas suas permissões aparecerão no menu conforme forem disponibilizadas.</p>`}
      <div>
        <p class="text-sm font-bold text-slate-600">Suas permissões</p>
        <div class="mc-selos mt-2">${estado.usuario.permissoes.map((chave) => `<span class="mc-selo">${esc(rotuloDaPermissao(chave))}</span>`).join("")}</div>
      </div>
    </section>`);
  document.querySelector("#mc-ir-usuarios")?.addEventListener("click", () => navegar("/mycontrol/configuracoes/usuarios"));
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
    <section class="card mc-cartao mc-usuarios">
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
  if (tela.id === "usuarios") return renderUsuarios();
  return renderInicio();
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

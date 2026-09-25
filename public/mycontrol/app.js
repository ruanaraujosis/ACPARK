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
import { ligarQuadroDeAssinatura } from "../js/ui/assinatura.js?v=20260925-mycontrol-fase3";

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

// Permissões de registro (Fase 3): quem tem qualquer uma vê "Em uso", "Histórico" e o detalhe
const PERMISSOES_REGISTRO = ["registro.registrar", "registro.devolver", "registro.editar", "registro.cancelar", "registro.excluir"];

// Telas por caminho. Só existem as telas já feitas -- nada de tela vazia para fases futuras.
// `permissao` pode ser uma lista (basta ter qualquer uma). O detalhe do registro
// (/mycontrol/registros/123) é tratado à parte em renderizarRota.
const TELAS = {
  "/mycontrol": { id: "inicio", titulo: "Início" },
  "/mycontrol/registrar": { id: "registrar", titulo: "Registrar uso", permissao: "registro.registrar" },
  "/mycontrol/em-uso": { id: "em-uso", titulo: "Em uso", permissao: PERMISSOES_REGISTRO },
  "/mycontrol/historico": { id: "historico", titulo: "Histórico", permissao: PERMISSOES_REGISTRO },
  ...Object.fromEntries(Object.entries(CADASTROS).map(([entidade, c]) => [c.caminho, { id: "cadastro", entidade, titulo: c.plural, permissao: c.permissao }])),
  ...Object.fromEntries(ABAS_CONFIGURACAO.map((aba) => [aba.caminho, { id: "configuracao", aba: aba.id, titulo: "Configurações", permissao: aba.permissao }]))
};

// Itens do menu lateral: início, uso (registrar, em uso, histórico), cadastros permitidos e
// Configurações (primeira aba permitida)
function itensDoMenu() {
  const itens = [["/mycontrol", "Início"]];
  for (const caminho of ["/mycontrol/registrar", "/mycontrol/em-uso", "/mycontrol/historico"]) {
    if (pode(TELAS[caminho].permissao)) itens.push([caminho, TELAS[caminho].titulo]);
  }
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

// O usuário logado tem a permissão? (lista = basta ter qualquer uma)
function pode(permissao) {
  if (Array.isArray(permissao)) return permissao.some((chave) => pode(chave));
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
  // Detalhe de um registro: /mycontrol/registros/123
  const detalhe = caminho.match(/^\/mycontrol\/registros\/(\d{1,9})$/);
  if (detalhe && pode(PERMISSOES_REGISTRO)) return renderDetalheRegistro(Number(detalhe[1]));
  const tela = TELAS[caminho];
  if (!tela || (tela.permissao && !pode(tela.permissao))) {
    history.replaceState(null, "", "/mycontrol");
    return renderInicio();
  }
  if (tela.id === "registrar") return renderRegistrar();
  if (tela.id === "em-uso") return renderEmUso();
  if (tela.id === "historico") return renderHistorico();
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

// ===== Registros de uso e devolução (Fase 3) =====
// A tela de registro é usada no celular, no pátio: uma coluna, alvos grandes, câmera traseira e
// botão de salvar sempre à vista. A hora de saída e de devolução é SEMPRE a do servidor; a tela
// só mostra (em America/Sao_Paulo) o que o servidor devolve.

// Nomes dos tipos e dos status na tela
const TIPOS_REGISTRO = {
  veiculo: { rotulo: "Veículo", busca: "Nome, placa ou nº da chave" },
  ferramenta: { rotulo: "Ferramenta", busca: "Nome ou identificador" }
};
const STATUS_REGISTRO = { EM_USO: "Em uso", DEVOLVIDO: "Devolvido", CANCELADO: "Cancelado" };

// Limite de imagem informado pelo servidor (UPLOAD_MAX_IMAGE_MB) e limite de km alto
const registrosConfig = { limiteImagem: 8 * 1024 * 1024, limiteKmAlto: 1000 };

// Data e hora completas em Brasília (detalhe do registro)
function dataCompleta(valor) {
  const data = valor ? new Date(valor) : null;
  return !data || Number.isNaN(data.getTime()) ? "—" : formatoLongo.format(data);
}

// Selo da situação do registro
function seloStatus(status) {
  const classe = status === "EM_USO" ? "is-em-uso" : status === "CANCELADO" ? "is-inativo" : "";
  return `<span class="mc-chip ${classe}">${esc(STATUS_REGISTRO[status] || status)}</span>`;
}

// Selo do cargo do colaborador
function seloCargo(cargo) {
  return cargo?.nome ? `<span class="mc-selo is-cargo">${esc(cargo.nome)}</span>` : "";
}

// Miniatura que abre a foto grande ao tocar (ou um quadrado vazio sem foto)
function miniaturaBotao(id, titulo, { grande = false } = {}) {
  if (!id) return `<span class="mc-miniatura is-vazia ${grande ? "is-grande" : ""}" aria-hidden="true"></span>`;
  return `<button class="mc-miniatura ${grande ? "is-grande" : ""}" type="button" data-foto="${id}" data-titulo="${esc(titulo)}" aria-label="Ver foto: ${esc(titulo)}"><img src="${urlArquivo(id, { miniatura: true })}" alt="" loading="lazy" /></button>`;
}

// Liga os botões de miniatura dentro de `raiz` à foto grande
function ligarMiniaturas(raiz = document) {
  raiz.querySelectorAll("[data-foto]").forEach((botao) => botao.addEventListener("click", () => abrirFotoGrande(botao.dataset.foto, botao.dataset.titulo)));
}

// Campo de foto do registro (antes/depois): câmera traseira, prévia e troca antes de salvar
function campoFotoRegistro(chave, rotulo, { obrigatoria = true } = {}) {
  return `
    <div class="mc-campo" data-foto-registro="${chave}">
      <span class="mc-rotulo">${esc(rotulo)}${obrigatoria ? ' <span class="mc-obrigatorio" aria-label="obrigatória">*</span>' : ""}</span>
      <div class="mc-foto-campo">
        <img class="mc-foto-previa hidden" alt="Prévia da foto" />
        <label class="btn secondary mc-acao mc-botao-arquivo mc-botao-camera">Tirar foto
          <input type="file" accept="image/*" capture="environment" />
        </label>
      </div>
    </div>`;
}

// Liga um campo de foto de registro; devolve { tem(), enviar() } -- enviar sobe a foto uma vez só
// (se a devolução pedir confirmação de km, o reenvio reaproveita o mesmo arquivo)
function ligarFotoRegistro(raiz, chave) {
  const bloco = raiz.querySelector(`[data-foto-registro="${chave}"]`);
  const entrada = bloco.querySelector("input[type=file]");
  const previa = bloco.querySelector(".mc-foto-previa");
  const rotuloBotao = bloco.querySelector(".mc-botao-camera");
  let pendente = null;
  let enviado = null;
  let urlLocal = null;
  entrada.addEventListener("change", async () => {
    const arquivo = entrada.files?.[0];
    if (!arquivo) return;
    try {
      const blob = await comprimirImagem(arquivo, { limite: registrosConfig.limiteImagem });
      if (urlLocal) URL.revokeObjectURL(urlLocal);
      urlLocal = URL.createObjectURL(blob);
      previa.src = urlLocal;
      previa.classList.remove("hidden");
      rotuloBotao.firstChild.textContent = "Tirar outra foto";
      pendente = { blob, original: arquivo };
      enviado = null;
    } catch (erro) {
      toast(erro.message, "error");
    }
    entrada.value = "";
  });
  return {
    tem: () => Boolean(pendente),
    enviar: async () => {
      if (!pendente) return null;
      enviado ||= await enviarImagem("registro", "foto", pendente.blob, { original: pendente.original });
      return enviado;
    }
  };
}

// Escolha com busca (item ou colaborador): lista resultados enquanto digita; ao escolher, mostra
// o escolhido com o botão "Trocar". `buscar(q)` devolve a lista do servidor.
function montarEscolha(bloco, { buscar, desenharItem, desenharEscolhido, aoEscolher }) {
  const busca = bloco.querySelector("input[type=search]");
  const lista = bloco.querySelector(".mc-resultados");
  const escolhido = bloco.querySelector(".mc-escolhido");
  const areaBusca = bloco.querySelector(".mc-escolha-busca");
  let itens = [];
  let espera = null;
  let pedido = 0;
  // Busca no servidor e desenha a lista (descarta respostas antigas que chegarem atrasadas)
  const atualizar = async () => {
    const meu = ++pedido;
    try {
      const resultado = await buscar(busca.value.trim());
      if (meu !== pedido) return;
      itens = resultado;
      lista.innerHTML = itens.length
        ? itens.map((item, i) => `<button class="mc-resultado" type="button" data-indice="${i}">${desenharItem(item)}</button>`).join("")
        : '<p class="text-sm text-slate-500">Nada encontrado.</p>';
      lista.querySelectorAll("[data-indice]").forEach((botao) => botao.addEventListener("click", () => escolher(itens[Number(botao.dataset.indice)])));
    } catch (erro) {
      avisarErro(erro);
    }
  };
  // Mostra o escolhido no lugar da busca
  const escolher = (item) => {
    escolhido.innerHTML = `${desenharEscolhido(item)}<button class="btn secondary mc-acao" type="button" data-trocar>Trocar</button>`;
    escolhido.classList.remove("hidden");
    areaBusca.classList.add("hidden");
    escolhido.querySelector("[data-trocar]").addEventListener("click", () => limpar());
    ligarMiniaturas(escolhido);
    aoEscolher(item);
  };
  // Volta para a busca
  const limpar = () => {
    escolhido.classList.add("hidden");
    escolhido.innerHTML = "";
    areaBusca.classList.remove("hidden");
    aoEscolher(null);
    atualizar();
  };
  busca.addEventListener("input", () => {
    clearTimeout(espera);
    espera = setTimeout(atualizar, 300);
  });
  atualizar();
  return { limpar, atualizar };
}

// HTML-base de uma escolha com busca
function htmlEscolha(chave, rotuloBusca, placeholder) {
  return `
    <div class="mc-escolha" data-escolha="${chave}">
      <div class="mc-escolha-busca">
        <label class="mc-campo"><span class="mc-rotulo">${esc(rotuloBusca)}</span>
          <input type="search" enterkeyhint="search" autocomplete="off" autocapitalize="none" placeholder="${esc(placeholder)}" />
        </label>
        <div class="mc-resultados" role="list"></div>
      </div>
      <div class="mc-escolhido hidden"></div>
    </div>`;
}

// Como um item aparece na lista de escolha e depois de escolhido
function htmlItemDeRegistro(item, tipo) {
  const extra = tipo === "veiculo" && item.numero_chave ? ` · chave ${esc(item.numero_chave)}` : "";
  return `${miniaturaBotaoEstatica(item.foto_id)}<span class="mc-resultado-texto"><strong class="mc-nome">${esc(item.nome)}</strong><small><span class="mc-login">${esc(item.secundario || "")}</span>${extra}</small></span>`;
}

// Miniatura só para exibir (dentro de botão de resultado não pode haver outro botão)
function miniaturaBotaoEstatica(id) {
  return id ? `<span class="mc-miniatura"><img src="${urlArquivo(id, { miniatura: true })}" alt="" loading="lazy" /></span>` : '<span class="mc-miniatura is-vazia" aria-hidden="true"></span>';
}

// Como um colaborador aparece na lista de escolha
function htmlColaboradorDeRegistro(colaborador) {
  return `${miniaturaBotaoEstatica(colaborador.foto_id)}<span class="mc-resultado-texto"><strong class="mc-nome">${esc(colaborador.nome)}</strong><small><span class="mc-login">${esc(colaborador.matricula)}</span></small>${seloCargo(colaborador.cargo)}</span>`;
}

// Colaborador escolhido, com a assinatura do cadastro já aplicada
function htmlColaboradorEscolhido(colaborador) {
  return `
    <div class="mc-escolhido-dados">${htmlColaboradorDeRegistro(colaborador)}</div>
    ${colaborador.assinatura_id
      ? `<div class="mc-assinatura-aplicada"><img src="${urlArquivo(colaborador.assinatura_id)}" alt="Assinatura de ${esc(colaborador.nome)}" /><p class="mc-aviso-ok">Assinatura do cadastro aplicada automaticamente.</p></div>`
      : '<p class="mc-aviso">Este colaborador está sem assinatura no cadastro. Atualize o cadastro antes de registrar.</p>'}`;
}

// Tela "Registrar uso": tipo -> item disponível -> colaborador -> km (veículo) -> foto -> observação
function renderRegistrar() {
  let tipo = "veiculo";
  let item = null;
  let colaborador = null;
  casca(`
    <section class="card mc-cartao mc-registrar">
      <div class="mc-barra-titulo">
        <p class="eyebrow">Uso</p>
        <h3 class="text-xl font-black">Registrar uso</h3>
        <p class="text-sm text-slate-500">A data e a hora da saída são registradas pelo sistema no momento em que você salvar.</p>
      </div>
      <form id="mc-registrar-form" class="mc-form" novalidate>
        <fieldset class="mc-passo">
          <legend>O que vai sair</legend>
          <div class="mc-segmentado" role="group" aria-label="Tipo">
            ${Object.entries(TIPOS_REGISTRO).map(([id, t]) => `<button class="btn ${id === tipo ? "" : "secondary"}" type="button" data-tipo="${id}" aria-pressed="${id === tipo}">${esc(t.rotulo)}</button>`).join("")}
          </div>
          <div id="mc-escolha-item"></div>
        </fieldset>
        <fieldset class="mc-passo">
          <legend>Quem vai levar</legend>
          ${htmlEscolha("colaborador", "Buscar colaborador", "Nome ou matrícula")}
        </fieldset>
        <fieldset class="mc-passo" data-so-veiculo>
          <legend>Quilometragem de saída</legend>
          <label class="mc-campo"><span class="mc-rotulo">Km no painel <span class="mc-obrigatorio" aria-label="obrigatório">*</span></span>
            <input name="km_saida" type="text" inputmode="numeric" pattern="[0-9.]*" autocomplete="off" placeholder="Ex.: 45230" />
          </label>
        </fieldset>
        <fieldset class="mc-passo">
          <legend>Foto de antes</legend>
          ${campoFotoRegistro("antes", "Foto do item na saída")}
        </fieldset>
        <fieldset class="mc-passo">
          <legend>Observação</legend>
          <label class="mc-campo"><span class="mc-rotulo">Opcional</span>
            <textarea name="observacao" rows="3" maxlength="1000" autocapitalize="sentences"></textarea>
          </label>
        </fieldset>
        <div class="mc-barra-fixa">
          <button class="btn mc-botao-cheio" type="submit">Registrar saída</button>
        </div>
      </form>
    </section>`);

  const form = document.querySelector("#mc-registrar-form");
  const foto = ligarFotoRegistro(form, "antes");
  let escolhaItem = null;
  // (Re)monta a escolha de item para o tipo atual
  const montarItem = () => {
    item = null;
    const alvo = document.querySelector("#mc-escolha-item");
    alvo.innerHTML = htmlEscolha("item", `Buscar ${TIPOS_REGISTRO[tipo].rotulo.toLowerCase()} disponível`, TIPOS_REGISTRO[tipo].busca);
    escolhaItem = montarEscolha(alvo.querySelector("[data-escolha]"), {
      buscar: async (q) => (await api(`/api/mycontrol/registros/disponiveis?tipo=${tipo}&q=${encodeURIComponent(q)}`, { silentLoading: true })).itens,
      desenharItem: (i) => htmlItemDeRegistro(i, tipo),
      desenharEscolhido: (i) => `<div class="mc-escolhido-dados">${htmlItemDeRegistro(i, tipo)}</div>`,
      aoEscolher: (i) => {
        item = i;
      }
    });
    form.querySelector("[data-so-veiculo]").classList.toggle("hidden", tipo !== "veiculo");
  };
  form.querySelectorAll("[data-tipo]").forEach((botao) => botao.addEventListener("click", () => {
    tipo = botao.dataset.tipo;
    form.querySelectorAll("[data-tipo]").forEach((b) => {
      const ativo = b.dataset.tipo === tipo;
      b.classList.toggle("secondary", !ativo);
      b.setAttribute("aria-pressed", String(ativo));
    });
    montarItem();
  }));
  montarItem();
  montarEscolha(form.querySelector('[data-escolha="colaborador"]'), {
    buscar: async (q) => {
      const dados = await api(`/api/mycontrol/registros/colaboradores?q=${encodeURIComponent(q)}`, { silentLoading: true });
      registrosConfig.limiteImagem = dados.limite_imagem_bytes || registrosConfig.limiteImagem;
      return dados.colaboradores;
    },
    desenharItem: htmlColaboradorDeRegistro,
    desenharEscolhido: htmlColaboradorEscolhido,
    aoEscolher: (c) => {
      colaborador = c;
    }
  });

  form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    // Conferência rápida na tela; o servidor valida tudo de novo
    if (!item) return toast(`Escolha o ${TIPOS_REGISTRO[tipo].rotulo.toLowerCase()}.`, "error");
    if (!colaborador) return toast("Escolha o colaborador.", "error");
    if (!colaborador.assinatura_id) return toast("O colaborador está sem assinatura no cadastro.", "error");
    const km = form.elements.km_saida.value.trim();
    if (tipo === "veiculo" && !km) return toast("Informe a quilometragem de saída.", "error");
    if (!foto.tem()) return toast("Tire a foto de antes.", "error");
    const botao = form.querySelector("button[type=submit]");
    botao.disabled = true;
    try {
      const fotoAntes = await foto.enviar();
      const { registro } = await api("/api/mycontrol/registros", {
        method: "POST",
        loadingMessage: "Registrando saída...",
        body: JSON.stringify({ tipo, item_id: item.id, colaborador_id: colaborador.id, km_saida: tipo === "veiculo" ? km : undefined, foto_antes: fotoAntes, observacao: form.elements.observacao.value })
      });
      toast(`Saída registrada às ${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", timeStyle: "short" }).format(new Date(registro.retirado_em))}.`);
      navegar("/mycontrol/em-uso");
    } catch (erro) {
      avisarErro(erro);
      // Outro usuário registrou o mesmo item neste meio-tempo: a lista precisa mudar
      if (erro.status === 409) escolhaItem?.limpar();
    } finally {
      botao.disabled = false;
    }
  });
}

// Cartão de um registro em uso (celular e desktop), com quem está, cargo e desde quando
function cartaoEmUso(registro) {
  const acoes = [];
  if (pode("registro.devolver")) acoes.push(`<button class="btn mc-acao" type="button" data-devolver="${registro.id}">Devolver</button>`);
  acoes.push(`<button class="btn secondary mc-acao" type="button" data-detalhe="${registro.id}">Detalhes</button>`);
  return `
    <article class="mc-cartao-registro">
      <div class="mc-cartao-registro-topo">
        ${miniaturaBotao(registro.foto_antes_id, `Foto de antes: ${registro.item.nome}`)}
        <div class="mc-cartao-registro-titulo">
          <strong class="mc-nome">${esc(registro.item.nome)}</strong>
          <small><span class="mc-login">${esc(registro.item.secundario || "")}</span>${registro.item.numero_chave ? ` · chave ${esc(registro.item.numero_chave)}` : ""}</small>
        </div>
        <span class="mc-selo">${esc(TIPOS_REGISTRO[registro.tipo].rotulo)}</span>
      </div>
      <p class="mc-cartao-registro-pessoa"><span class="mc-nome">${esc(registro.colaborador.nome)}</span> ${seloCargo(registro.colaborador.cargo)}</p>
      <p class="text-sm text-slate-600">Desde ${dataHtml(registro.retirado_em)}${registro.km_saida !== null ? ` · saiu com ${esc(registro.km_saida)} km` : ""}</p>
      <div class="mc-acoes">${acoes.join("")}</div>
    </article>`;
}

// Tela "Em uso": o que está com alguém agora
async function renderEmUso() {
  let dados;
  try {
    dados = await api("/api/mycontrol/registros/em-uso");
  } catch (erro) {
    avisarErro(erro);
    return;
  }
  registrosConfig.limiteKmAlto = dados.limite_km_alto || registrosConfig.limiteKmAlto;
  registrosConfig.limiteImagem = dados.limite_imagem_bytes || registrosConfig.limiteImagem;
  casca(`
    <section class="card mc-cartao">
      <div class="mc-barra">
        <div class="mc-barra-titulo">
          <p class="eyebrow">Uso</p>
          <h3 class="text-xl font-black">Em uso agora</h3>
        </div>
        ${pode("registro.registrar") ? '<button class="btn mc-botao-cheio-celular" type="button" id="mc-ir-registrar">Registrar uso</button>' : ""}
        <p class="mc-barra-ajuda text-sm text-slate-500">${dados.registros.length ? `${dados.registros.length} item(ns) fora. Os mais antigos aparecem primeiro.` : "Nenhum veículo ou ferramenta em uso no momento."}</p>
      </div>
      <div class="mc-cartoes-registro">${dados.registros.map(cartaoEmUso).join("")}</div>
    </section>`);
  document.querySelector("#mc-ir-registrar")?.addEventListener("click", () => navegar("/mycontrol/registrar"));
  ligarMiniaturas();
  const achar = (id) => dados.registros.find((registro) => registro.id === Number(id));
  document.querySelectorAll("[data-detalhe]").forEach((botao) => botao.addEventListener("click", () => navegar(`/mycontrol/registros/${botao.dataset.detalhe}`)));
  document.querySelectorAll("[data-devolver]").forEach((botao) => botao.addEventListener("click", () => abrirDevolucao(achar(botao.dataset.devolver), renderEmUso)));
}

// Modal de devolução: km de volta (veículo), foto de depois e observação. Diferença de km acima
// do limite: o servidor responde KM_ALTO e a tela pede confirmação antes de reenviar.
function abrirDevolucao(registro, aoConcluir) {
  let foto = null;
  abrirModal({
    titulo: `Devolver ${registro.item.nome}`,
    textoSalvar: "Registrar devolução",
    corpo: `
      <div class="mc-form">
        <p class="text-sm text-slate-600">Com <strong>${esc(registro.colaborador.nome)}</strong> desde ${esc(dataCompleta(registro.retirado_em))}. A hora da devolução é registrada pelo sistema.</p>
        ${registro.tipo === "veiculo" ? `
          <label class="mc-campo"><span class="mc-rotulo">Km de volta <span class="mc-obrigatorio" aria-label="obrigatório">*</span></span>
            <input name="km_volta" type="text" inputmode="numeric" pattern="[0-9.]*" autocomplete="off" />
            <small class="mc-ajuda">Saiu com ${esc(registro.km_saida)} km. Não pode ser menor que isso.</small>
          </label>` : ""}
        ${campoFotoRegistro("depois", "Foto do item na devolução")}
        <label class="mc-campo"><span class="mc-rotulo">Observação (opcional)</span>
          <textarea name="observacao_devolucao" rows="3" maxlength="1000" autocapitalize="sentences"></textarea>
        </label>
      </div>`,
    aoAbrir: (form) => {
      foto = ligarFotoRegistro(form, "depois");
    },
    aoEnviar: async (form) => {
      const km = form.elements.km_volta?.value.trim();
      if (registro.tipo === "veiculo" && !km) {
        toast("Informe a quilometragem de volta.", "error");
        return false;
      }
      if (!foto.tem()) {
        toast("Tire a foto da devolução.", "error");
        return false;
      }
      const corpo = { km_volta: km, foto_depois: await foto.enviar(), observacao_devolucao: form.elements.observacao_devolucao.value };
      // Envia; se o servidor pedir confirmação de km alto, pergunta e reenvia confirmado
      const enviarDevolucao = (extra = {}) => api(`/api/mycontrol/registros/${registro.id}/devolver`, { method: "POST", body: JSON.stringify({ ...corpo, ...extra }), loadingMessage: "Registrando devolução..." });
      try {
        await enviarDevolucao();
      } catch (erro) {
        if (erro.details?.codigo !== "KM_ALTO") throw erro;
        if (!confirmar(`${erro.message}\n\nA quilometragem está certa? Toque em OK para confirmar a devolução.`)) return false;
        await enviarDevolucao({ confirmarKmAlto: true });
      }
      toast("Devolução registrada. O item está disponível de novo.");
      fecharModal();
      aoConcluir?.();
      return true;
    }
  });
}

// Estado da tela de histórico (filtros e página)
const historico = { registros: [], total: 0, pagina: 1, filtros: { tipo: "", status: "", de: "", ate: "", q: "" } };

// Linha do histórico (tabela no desktop, cartão no celular/tablet)
function linhaHistorico(registro) {
  return `
    <tr>
      <td class="mc-col-foto">${miniaturaBotao(registro.foto_antes_id, `Foto de antes: ${registro.item.nome}`)}</td>
      <td class="mc-col-nome"><strong class="mc-nome">${esc(registro.item.nome)}</strong></td>
      <td class="mc-col-login"><span class="mc-login">${esc(registro.item.secundario || "")}</span></td>
      <td class="mc-col-acesso"><span class="mc-rotulo-cartao">Com</span> ${esc(registro.colaborador.nome)} ${seloCargo(registro.colaborador.cargo)}</td>
      <td class="mc-col-acesso"><span class="mc-rotulo-cartao">Saída</span> ${dataHtml(registro.retirado_em)}</td>
      <td class="mc-col-acesso"><span class="mc-rotulo-cartao">Devolução</span> ${registro.devolvido_em ? dataHtml(registro.devolvido_em) : "—"}</td>
      <td class="mc-col-situacao">${seloStatus(registro.status)}</td>
      <td class="mc-col-acoes"><div class="mc-acoes"><button class="btn secondary mc-acao" type="button" data-detalhe="${registro.id}">Detalhes</button></div></td>
    </tr>`;
}

// Busca uma página do histórico (reiniciar = primeira página com os filtros atuais)
async function carregarHistorico({ reiniciar = false } = {}) {
  const pagina = reiniciar ? 1 : historico.pagina + 1;
  const parametros = new URLSearchParams({ pagina: String(pagina) });
  for (const [chave, valor] of Object.entries(historico.filtros)) if (valor) parametros.set(chave, valor);
  let dados;
  try {
    dados = await api(`/api/mycontrol/registros?${parametros}`);
  } catch (erro) {
    avisarErro(erro);
    return;
  }
  historico.registros = reiniciar ? dados.registros : [...historico.registros, ...dados.registros];
  historico.total = dados.total;
  historico.pagina = dados.pagina;
  const alvo = document.querySelector("#mc-historico-lista");
  if (!alvo) return;
  alvo.innerHTML = `
    ${table(["", "Item", "Placa / identificador", "Colaborador", "Saída", "Devolução", "Situação", ""], historico.registros.map(linhaHistorico))}
    <p class="mc-contagem text-sm text-slate-500">${historico.registros.length} de ${historico.total}</p>
    ${historico.registros.length < historico.total ? '<button class="btn secondary mc-botao-cheio" type="button" id="mc-historico-mais">Carregar mais</button>' : ""}`;
  ligarMiniaturas(alvo);
  alvo.querySelector("#mc-historico-mais")?.addEventListener("click", () => carregarHistorico());
  alvo.querySelectorAll("[data-detalhe]").forEach((botao) => botao.addEventListener("click", () => navegar(`/mycontrol/registros/${botao.dataset.detalhe}`)));
}

// Tela "Histórico": lista paginada com filtros (tipo, situação, período e busca)
async function renderHistorico() {
  const f = historico.filtros;
  casca(`
    <section class="card mc-cartao mc-lista mc-lista-com-foto">
      <div class="mc-barra">
        <div class="mc-barra-titulo">
          <p class="eyebrow">Uso</p>
          <h3 class="text-xl font-black">Histórico de registros</h3>
        </div>
        <form class="mc-filtros" id="mc-historico-filtros" role="search">
          <label class="mc-campo mc-filtro-busca"><span class="mc-rotulo">Buscar</span>
            <input name="q" type="search" enterkeyhint="search" autocomplete="off" value="${esc(f.q)}" placeholder="Colaborador, matrícula, item, placa..." />
          </label>
          <label class="mc-campo"><span class="mc-rotulo">Tipo</span>
            <select name="tipo">
              <option value="">Todos</option>
              <option value="veiculo" ${f.tipo === "veiculo" ? "selected" : ""}>Veículos</option>
              <option value="ferramenta" ${f.tipo === "ferramenta" ? "selected" : ""}>Ferramentas</option>
            </select>
          </label>
          <label class="mc-campo"><span class="mc-rotulo">Situação</span>
            <select name="status">
              <option value="">Todas</option>
              ${Object.entries(STATUS_REGISTRO).map(([id, rotulo]) => `<option value="${id}" ${f.status === id ? "selected" : ""}>${esc(rotulo)}</option>`).join("")}
            </select>
          </label>
          <label class="mc-campo"><span class="mc-rotulo">De</span><input name="de" type="date" value="${esc(f.de)}" /></label>
          <label class="mc-campo"><span class="mc-rotulo">Até</span><input name="ate" type="date" value="${esc(f.ate)}" /></label>
        </form>
        <p class="mc-barra-ajuda text-sm text-slate-500">Registros cancelados aparecem com a situação "Cancelado". Registros excluídos não aparecem.</p>
      </div>
      <div id="mc-historico-lista"></div>
    </section>`);
  const filtros = document.querySelector("#mc-historico-filtros");
  let espera = null;
  // Aplica os filtros e volta para a primeira página
  const aplicar = () => {
    for (const chave of Object.keys(historico.filtros)) historico.filtros[chave] = filtros.elements[chave].value.trim();
    carregarHistorico({ reiniciar: true });
  };
  filtros.addEventListener("submit", (evento) => {
    evento.preventDefault();
    aplicar();
  });
  filtros.elements.q.addEventListener("input", () => {
    clearTimeout(espera);
    espera = setTimeout(aplicar, 350);
  });
  for (const chave of ["tipo", "status", "de", "ate"]) filtros.elements[chave].addEventListener("change", aplicar);
  await carregarHistorico({ reiniciar: true });
}

// Linha "rótulo: valor" do detalhe
function linhaDetalhe(rotulo, valor) {
  return `<div class="mc-detalhe-linha"><dt>${esc(rotulo)}</dt><dd>${valor}</dd></div>`;
}

// Detalhe de um registro, com as ações conforme as permissões de quem está logado
async function renderDetalheRegistro(id) {
  let dados;
  try {
    dados = await api(`/api/mycontrol/registros/${id}`);
  } catch (erro) {
    avisarErro(erro);
    if (erro.status === 404) navegar("/mycontrol/historico", { substituir: true });
    return;
  }
  const r = dados.registro;
  registrosConfig.limiteKmAlto = dados.limite_km_alto || registrosConfig.limiteKmAlto;
  registrosConfig.limiteImagem = dados.limite_imagem_bytes || registrosConfig.limiteImagem;
  const acoes = [];
  if (r.status === "EM_USO" && pode("registro.devolver")) acoes.push('<button class="btn mc-acao" type="button" data-acao="devolver">Devolver</button>');
  if (r.status !== "CANCELADO" && pode("registro.editar")) acoes.push('<button class="btn secondary mc-acao" type="button" data-acao="editar">Editar</button>');
  // Ações destrutivas ficam afastadas das principais e sempre pedem motivo
  const perigosas = [];
  if (r.status !== "CANCELADO" && pode("registro.cancelar")) perigosas.push('<button class="btn mc-acao mc-acao-perigo" type="button" data-acao="cancelar">Cancelar registro</button>');
  if (pode("registro.excluir")) perigosas.push('<button class="btn mc-acao mc-acao-perigo" type="button" data-acao="excluir">Excluir</button>');
  const diferencaKm = r.km_volta !== null && r.km_saida !== null ? r.km_volta - r.km_saida : null;
  casca(`
    <section class="card mc-cartao mc-detalhe">
      <div class="mc-barra">
        <div class="mc-barra-titulo">
          <p class="eyebrow">Registro nº ${esc(r.id)} · ${esc(TIPOS_REGISTRO[r.tipo].rotulo)}</p>
          <h3 class="mc-nome text-xl font-black">${esc(r.item.nome)} <span class="mc-login text-base font-bold text-slate-500">${esc(r.item.secundario || "")}</span></h3>
        </div>
        ${seloStatus(r.status)}
      </div>
      <div class="mc-detalhe-grade">
        <section class="mc-detalhe-secao">
          <h4>Saída</h4>
          <dl>
            ${linhaDetalhe("Colaborador", `${esc(r.colaborador.nome)} <span class="mc-login">${esc(r.colaborador.matricula)}</span> ${seloCargo(r.colaborador.cargo)}`)}
            ${linhaDetalhe("Data e hora", esc(dataCompleta(r.retirado_em)))}
            ${linhaDetalhe("Registrado por", esc(r.registrado_por || "—"))}
            ${r.tipo === "veiculo" ? linhaDetalhe("Km de saída", esc(r.km_saida)) : ""}
            ${linhaDetalhe("Observação", esc(r.observacao || "—"))}
          </dl>
          <div class="mc-detalhe-midias">
            <figure>${miniaturaBotao(r.foto_antes_id, "Foto de antes", { grande: true })}<figcaption>Foto de antes</figcaption></figure>
            <figure class="mc-assinatura-aplicada"><img src="${urlArquivo(r.assinatura_id)}" alt="Assinatura de ${esc(r.colaborador.nome)}" /><figcaption>${r.assinatura_automatica ? "Assinatura do cadastro aplicada automaticamente" : "Assinatura"}</figcaption></figure>
          </div>
        </section>
        ${r.devolvido_em ? `
          <section class="mc-detalhe-secao">
            <h4>Devolução</h4>
            <dl>
              ${linhaDetalhe("Data e hora", esc(dataCompleta(r.devolvido_em)))}
              ${linhaDetalhe("Registrada por", esc(r.devolvido_por || "—"))}
              ${r.tipo === "veiculo" ? linhaDetalhe("Km de volta", `${esc(r.km_volta)} (${esc(diferencaKm)} km rodados${r.km_alto_confirmado ? ", quilometragem alta confirmada" : ""})`) : ""}
              ${linhaDetalhe("Observação", esc(r.observacao_devolucao || "—"))}
            </dl>
            <div class="mc-detalhe-midias"><figure>${miniaturaBotao(r.foto_depois_id, "Foto de depois", { grande: true })}<figcaption>Foto de depois</figcaption></figure></div>
          </section>` : ""}
        ${r.status === "CANCELADO" ? `
          <section class="mc-detalhe-secao is-cancelado">
            <h4>Cancelamento</h4>
            <dl>
              ${linhaDetalhe("Data e hora", esc(dataCompleta(r.cancelado_em)))}
              ${linhaDetalhe("Cancelado por", esc(r.cancelado_por || "—"))}
              ${linhaDetalhe("Motivo", esc(r.motivo_cancelamento || "—"))}
            </dl>
          </section>` : ""}
      </div>
      ${r.atualizado_em ? `<p class="text-sm text-slate-500">Última edição em ${esc(dataCompleta(r.atualizado_em))} por ${esc(r.atualizado_por || "—")}.</p>` : ""}
      <div class="mc-detalhe-acoes">
        <div class="mc-acoes">${acoes.join("")}<button class="btn secondary mc-acao" type="button" data-acao="voltar">Voltar</button></div>
        ${perigosas.length ? `<div class="mc-acoes mc-acoes-perigosas">${perigosas.join("")}</div>` : ""}
      </div>
    </section>`);
  ligarMiniaturas();
  const recarregar = () => renderDetalheRegistro(id);
  const acao = (nome, funcao) => document.querySelector(`[data-acao="${nome}"]`)?.addEventListener("click", funcao);
  acao("voltar", () => (history.length > 1 ? history.back() : navegar("/mycontrol/historico")));
  acao("devolver", () => abrirDevolucao(r, recarregar));
  acao("editar", () => abrirEdicaoRegistro(r, recarregar));
  acao("cancelar", () => abrirMotivo(r, "cancelar", recarregar));
  acao("excluir", () => abrirMotivo(r, "excluir", () => navegar("/mycontrol/historico", { substituir: true })));
}

// Modal de edição do registro: observação, fotos e colaborador (a auditoria guarda antes e depois)
function abrirEdicaoRegistro(registro, aoConcluir) {
  let fotoAntes = null;
  let fotoDepois = null;
  let novoColaborador = null;
  abrirModal({
    titulo: `Editar registro nº ${registro.id}`,
    textoSalvar: "Salvar alterações",
    corpo: `
      <div class="mc-form">
        <div class="mc-campo">
          <span class="mc-rotulo">Colaborador</span>
          <p class="text-sm text-slate-600">Atual: <strong>${esc(registro.colaborador.nome)}</strong>. Para trocar, escolha outro abaixo (a assinatura do novo cadastro é aplicada automaticamente).</p>
          ${htmlEscolha("colaborador", "Buscar outro colaborador", "Nome ou matrícula")}
        </div>
        <label class="mc-campo"><span class="mc-rotulo">Observação da saída</span>
          <textarea name="observacao" rows="3" maxlength="1000" autocapitalize="sentences"></textarea>
        </label>
        ${campoFotoRegistro("antes", "Trocar a foto de antes (opcional)", { obrigatoria: false })}
        ${registro.status === "DEVOLVIDO" ? `
          <label class="mc-campo"><span class="mc-rotulo">Observação da devolução</span>
            <textarea name="observacao_devolucao" rows="3" maxlength="1000" autocapitalize="sentences"></textarea>
          </label>
          ${campoFotoRegistro("depois", "Trocar a foto de depois (opcional)", { obrigatoria: false })}` : ""}
      </div>`,
    aoAbrir: (form) => {
      form.elements.observacao.value = registro.observacao || "";
      if (form.elements.observacao_devolucao) form.elements.observacao_devolucao.value = registro.observacao_devolucao || "";
      fotoAntes = ligarFotoRegistro(form, "antes");
      if (registro.status === "DEVOLVIDO") fotoDepois = ligarFotoRegistro(form, "depois");
      montarEscolha(form.querySelector('[data-escolha="colaborador"]'), {
        buscar: async (q) => (await api(`/api/mycontrol/registros/colaboradores?q=${encodeURIComponent(q)}`, { silentLoading: true })).colaboradores.filter((c) => c.id !== registro.colaborador.id),
        desenharItem: htmlColaboradorDeRegistro,
        desenharEscolhido: htmlColaboradorEscolhido,
        aoEscolher: (c) => {
          novoColaborador = c;
        }
      });
    },
    aoEnviar: async (form) => {
      const corpo = { observacao: form.elements.observacao.value };
      if (form.elements.observacao_devolucao) corpo.observacao_devolucao = form.elements.observacao_devolucao.value;
      if (fotoAntes.tem()) corpo.foto_antes = await fotoAntes.enviar();
      if (fotoDepois?.tem()) corpo.foto_depois = await fotoDepois.enviar();
      if (novoColaborador) corpo.colaborador_id = novoColaborador.id;
      await api(`/api/mycontrol/registros/${registro.id}`, { method: "PATCH", body: JSON.stringify(corpo) });
      toast("Registro atualizado.");
      fecharModal();
      aoConcluir?.();
      return true;
    }
  });
}

// Modal de motivo obrigatório para cancelar ou excluir
function abrirMotivo(registro, acao, aoConcluir) {
  const cancelar = acao === "cancelar";
  abrirModal({
    titulo: cancelar ? `Cancelar registro nº ${registro.id}` : `Excluir registro nº ${registro.id}`,
    textoSalvar: cancelar ? "Cancelar registro" : "Excluir registro",
    corpo: `
      <div class="mc-form">
        <p class="mc-aviso">${cancelar
          ? "O registro continua no histórico como cancelado e o item volta a ficar disponível."
          : "O registro sai das listas, mas continua guardado na auditoria. Use só para registro feito por engano."}</p>
        <label class="mc-campo"><span class="mc-rotulo">Motivo <span class="mc-obrigatorio" aria-label="obrigatório">*</span></span>
          <textarea name="motivo" rows="3" maxlength="500" required minlength="3" autocapitalize="sentences"></textarea>
        </label>
      </div>`,
    aoEnviar: async (form) => {
      const motivo = form.elements.motivo.value.trim();
      if (motivo.length < 3) {
        toast("Informe o motivo.", "error");
        return false;
      }
      await api(`/api/mycontrol/registros/${registro.id}/${acao}`, { method: "POST", body: JSON.stringify({ motivo }) });
      toast(cancelar ? "Registro cancelado." : "Registro excluído.");
      fecharModal();
      aoConcluir?.();
      return true;
    }
  });
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

// Rotas do MyControl (/api/mycontrol/*).
//
// Tratadas pelo server/index.js ANTES do portão de sessão do MyEstoque: não exigem o cookie
// `session`, não rodam processAutoOrders() e nunca caem nas rotas do MyEstoque -- qualquer
// caminho /api/mycontrol/* termina aqui (404 se não existir).
//
// Só as duas rotas do assistente de primeiro uso respondem sem sessão, e cada uma se tranca
// sozinha no servidor. Todas as demais passam por requireMcUser com a permissão da própria rota.
import { hashPassword, query, tx, verifyPassword } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { ensureMyControlTables } from "../../services/mycontrol/mycontrol.schema.js";
import { GRUPOS_PERMISSOES, PERMISSAO_GERENCIAR_USUARIOS } from "../../services/mycontrol/permissoes.js";
import {
  cookieDeSessaoMc,
  cookieLimparSessaoMc,
  limiteDeLogin,
  requireMcUser,
  usuarioDaSessaoMc
} from "../../services/mycontrol/sessao.js";
import {
  SENHA_MINIMA,
  alterarAtivo,
  assistenteDisponivel,
  criarPrimeiroUsuario,
  criarUsuario,
  editarUsuario,
  listarUsuarios,
  redefinirSenha
} from "../../services/mycontrol/usuarios.service.js";
import { MENSAGENS_CONFLITO } from "../../services/mycontrol/cadastros.service.js";
import { tipoDeImagemAceito } from "../../services/mycontrol/arquivos.service.js";
import { ROTAS_CADASTROS } from "./mycontrol-cadastros.routes.js";
import { ROTAS_REGISTROS } from "./mycontrol-registros.routes.js";

// Hash descartável usado quando o login não existe: a verificação custa o mesmo tempo que uma
// senha errada, então o tempo de resposta não revela quais logins existem
const HASH_FALSO = hashPassword("mycontrol-login-inexistente");

// O caminho pertence ao MyControl?
export function ehRotaMyControl(pathname) {
  return pathname === "/api/mycontrol" || pathname.startsWith("/api/mycontrol/");
}

// Dados do usuário devolvidos à tela (sem hash de senha)
function publico(usuario) {
  return {
    id: usuario.id,
    usuario: usuario.usuario,
    nome: usuario.nome,
    permissoes: usuario.permissoes || [],
    ativo: usuario.ativo,
    criado_em: usuario.criado_em,
    criado_por: usuario.criado_por ?? null,
    ultimo_login_em: usuario.ultimo_login_em ?? null
  };
}

// Resposta de sessão: o usuário e o catálogo de permissões (a tela traduz as chaves em rótulos)
function sessaoParaTela(usuario) {
  return { usuario: publico(usuario), catalogo: GRUPOS_PERMISSOES, senhaMinima: SENHA_MINIMA };
}

// Status do assistente (público): diz se ainda não existe nenhum usuário
async function statusAssistente(req, res) {
  const disponivel = await tx((client) => assistenteDisponivel(client));
  send(res, 200, { disponivel, senhaMinima: SENHA_MINIMA });
}

// Cria o primeiro usuário (público). Recusa ANTES de ler o corpo se já houver usuário; a mesma
// checagem é refeita dentro do lock, no serviço, para o caso de dois envios simultâneos.
async function primeiroUsuario(req, res) {
  if (!(await tx((client) => assistenteDisponivel(client)))) {
    return send(res, 403, { error: "O MyControl já foi configurado. Use a tela de login." });
  }
  const body = await readBody(req);
  const criado = await criarPrimeiroUsuario(body);
  send(res, 200, sessaoParaTela(criado), { "Set-Cookie": cookieDeSessaoMc(criado) });
}

// Login com usuário e senha, sob o mesmo limite de tentativas por IP do MyEstoque
async function login(req, res) {
  const { isLoginRateLimited, registerLoginFailure } = limiteDeLogin();
  const ip = req.socket.remoteAddress || "desconhecido";
  if (isLoginRateLimited(ip)) {
    return send(res, 429, { error: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente." });
  }
  const body = await readBody(req);
  const loginInformado = String(body.usuario || "").trim().toLowerCase().slice(0, 40);
  const senha = normalizeText(body.senha, 120);
  const linhas = loginInformado
    ? await query("SELECT id, usuario, nome, senha, permissoes, ativo FROM mc_usuarios WHERE usuario = $1", [loginInformado])
    : [];
  const usuario = linhas[0];
  const senhaConfere = verifyPassword(senha, usuario?.senha || HASH_FALSO);
  // Mesma mensagem para login inexistente e senha errada: não revela quais usuários existem
  if (!usuario || !senhaConfere) {
    registerLoginFailure(ip);
    return send(res, 401, { error: "Usuário ou senha incorretos." });
  }
  if (!usuario.ativo) {
    return send(res, 403, { error: "Este usuário está desativado. Procure quem administra o MyControl." });
  }
  const atualizado = await query(
    "UPDATE mc_usuarios SET ultimo_login_em = now() WHERE id = $1 RETURNING id, usuario, nome, permissoes, ativo, criado_em, criado_por, ultimo_login_em",
    [usuario.id]
  );
  send(res, 200, sessaoParaTela(atualizado[0]), { "Set-Cookie": cookieDeSessaoMc(usuario) });
}

// Encerra a sessão do MyControl (o login do MyEstoque no mesmo navegador continua)
async function logout(req, res) {
  send(res, 200, { ok: true }, { "Set-Cookie": cookieLimparSessaoMc() });
}

// Quem está logado agora, lido do banco (null se não houver sessão ou se foi desativado)
async function quemSouEu(req, res) {
  const usuario = await usuarioDaSessaoMc(req);
  if (usuario && !usuario.ativo) {
    return send(res, 200, { usuario: null }, { "Set-Cookie": cookieLimparSessaoMc() });
  }
  send(res, 200, usuario ? sessaoParaTela(usuario) : { usuario: null });
}

// Lista usuários e o catálogo de permissões (a tela monta as caixas a partir dele)
async function listar(req, res) {
  const usuarios = await tx((client) => listarUsuarios(client));
  send(res, 200, { usuarios: usuarios.map(publico), catalogo: GRUPOS_PERMISSOES, senhaMinima: SENHA_MINIMA });
}

// Cria usuário com as permissões marcadas
async function criar(req, res, { usuario }) {
  const criado = await criarUsuario(usuario, await readBody(req));
  send(res, 200, { usuario: publico(criado) });
}

// Edita nome e permissões
async function editar(req, res, { usuario, id }) {
  const atualizado = await editarUsuario(usuario, id, await readBody(req));
  send(res, 200, { usuario: publico(atualizado) });
}

// Redefine a senha de outro usuário (ou a própria). As sessões abertas do alvo caem; se a pessoa
// redefiniu a própria senha, recebe um token novo para não ser derrubada da tela em que está.
async function senha(req, res, { usuario, id }) {
  const alvo = await redefinirSenha(usuario, id, await readBody(req));
  const headers = alvo.id === usuario.id ? { "Set-Cookie": cookieDeSessaoMc(alvo) } : {};
  send(res, 200, { ok: true }, headers);
}

// Desativa ou reativa
async function ativo(req, res, { usuario, id }) {
  const body = await readBody(req);
  const atualizado = await alterarAtivo(usuario, id, body.ativo);
  send(res, 200, { usuario: publico(atualizado) });
}

// Tabela de rotas da Fase 1. `publica: true` só nas do assistente e de autenticação; nas demais,
// `permissao` é checada no servidor por requireMcUser antes do handler rodar.
// O id aceita no máximo 9 dígitos: cabe no INTEGER do banco (maior que isso é 404, não erro 500).
const ROTAS_FASE1 = [
  { metodo: "GET", caminho: /^\/api\/mycontrol\/setup\/status$/, publica: true, handler: statusAssistente },
  { metodo: "POST", caminho: /^\/api\/mycontrol\/setup\/primeiro-usuario$/, publica: true, handler: primeiroUsuario },
  { metodo: "POST", caminho: /^\/api\/mycontrol\/auth\/login$/, publica: true, handler: login },
  { metodo: "POST", caminho: /^\/api\/mycontrol\/auth\/logout$/, publica: true, handler: logout },
  { metodo: "GET", caminho: /^\/api\/mycontrol\/auth\/me$/, publica: true, handler: quemSouEu },
  { metodo: "GET", caminho: /^\/api\/mycontrol\/usuarios$/, permissao: PERMISSAO_GERENCIAR_USUARIOS, handler: listar },
  { metodo: "POST", caminho: /^\/api\/mycontrol\/usuarios$/, permissao: PERMISSAO_GERENCIAR_USUARIOS, handler: criar },
  { metodo: "PATCH", caminho: /^\/api\/mycontrol\/usuarios\/(\d{1,9})$/, permissao: PERMISSAO_GERENCIAR_USUARIOS, handler: editar },
  { metodo: "POST", caminho: /^\/api\/mycontrol\/usuarios\/(\d{1,9})\/senha$/, permissao: PERMISSAO_GERENCIAR_USUARIOS, handler: senha },
  { metodo: "POST", caminho: /^\/api\/mycontrol\/usuarios\/(\d{1,9})\/ativo$/, permissao: PERMISSAO_GERENCIAR_USUARIOS, handler: ativo }
];

// Todas as rotas do MyControl (Fase 1 + cadastros da Fase 2 + registros de uso da Fase 3)
export const ROTAS_MYCONTROL = Object.freeze([...ROTAS_FASE1, ...ROTAS_CADASTROS, ...ROTAS_REGISTROS]);

// Roteador do MyControl: sempre trata o caminho (devolve true), mesmo quando é 404
export async function handleMyControlRoutes(req, res, { method, url }) {
  try {
    await ensureMyControlTables();
    const rota = ROTAS_MYCONTROL.find((r) => r.metodo === method && r.caminho.test(url.pathname));
    if (!rota) {
      send(res, 404, { error: "Rota não encontrada." });
      return true;
    }
    // Toda escrita exige corpo JSON. Um formulário HTML de outro site só consegue mandar
    // text/plain/form-urlencoded sem preflight de CORS; exigir application/json impede que uma
    // página maliciosa aberta por alguém da rede crie o primeiro usuário (rota pública) ou
    // dispare ações com o cookie de quem está logado. O upload de imagem exige image/jpeg,
    // image/png ou image/webp, que também não passa sem preflight (ver arquivos.service.js).
    if (method !== "GET" && rota.corpo === "imagem" && !tipoDeImagemAceito(req)) {
      send(res, 415, { error: "Envie a imagem como JPG, PNG ou WEBP." });
      return true;
    }
    if (method !== "GET" && rota.corpo !== "imagem" && !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
      send(res, 415, { error: "Envie os dados em JSON." });
      return true;
    }
    // Capturas da URL: por padrão a primeira é o id; `parametros` dá nome a cada uma
    const contexto = { url };
    const captura = url.pathname.match(rota.caminho);
    (rota.parametros || ["id"]).forEach((nome, indice) => {
      const valor = captura?.[indice + 1];
      if (valor !== undefined) contexto[nome] = nome === "id" ? Number.parseInt(valor, 10) : valor;
    });
    if (!rota.publica) {
      // Toda rota não pública exige sessão do MyControl ativa E a permissão dela
      contexto.usuario = await requireMcUser(req, res, rota.permissao);
      if (!contexto.usuario) return true;
    }
    await rota.handler(req, res, contexto);
  } catch (erro) {
    // Resposta já enviada: só registra (tentar responder de novo derrubaria o processo)
    if (res.headersSent) {
      console.error("[mycontrol] erro depois da resposta:", erro);
      return true;
    }
    if (erro.mensagemUsuario) {
      send(res, erro.statusCode || 400, { error: erro.mensagemUsuario, ...(erro.extras || {}) });
    } else if (erro.code === "23505") {
      // Unicidade que escapou das checagens prévias (corrida ou valor repetido): conflito com
      // a mensagem da constraint (login, placa, chave, identificador, cargo)
      send(res, 409, { error: MENSAGENS_CONFLITO[erro.constraint] || "Já existe um cadastro com esses dados." });
    } else if (erro.code === "23503") {
      // Referência que sumiu no meio (ex.: cargo excluído enquanto alguém salvava um colaborador)
      send(res, 409, { error: "Um item usado neste cadastro foi alterado ao mesmo tempo. Recarregue e tente de novo." });
    } else if (erro.name === "StorageValidationError") {
      // Imagem vazia, acima do limite ou que não é JPG/PNG/WEBP de verdade (conferido pelos bytes)
      send(res, 400, { error: erro.message });
    } else if (erro.message === "JSON inválido.") {
      send(res, 400, { error: "JSON inválido." });
    } else if (String(erro.message).startsWith("Arquivo muito grande")) {
      // readBody corta o corpo em 8 MB; nenhum formulário do MyControl chega perto disso
      send(res, 413, { error: "Requisição grande demais." });
    } else {
      // Erro técnico vai para o log; o cliente recebe mensagem genérica em português
      console.error("[mycontrol]", erro);
      send(res, 500, { error: "Erro interno no MyControl." });
    }
  }
  return true;
}

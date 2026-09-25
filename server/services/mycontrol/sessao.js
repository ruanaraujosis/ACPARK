// Sessão do MyControl: cookie próprio (mc_session) e token isolado do MyEstoque.
//
// ISOLAMENTO NOS DOIS SENTIDOS:
//  - o token do MyControl é assinado com um segredo DERIVADO (HMAC do JWT_SECRET com o rótulo
//    "mycontrol") e verificado com audience "mycontrol" -- um token do MyEstoque não passa aqui;
//  - o sessionFrom do MyEstoque (server/index.js) recusa qualquer token com aud "mycontrol".
// Sem isso, as rotas do MyEstoque que só exigem "estar logado" (ex.: /api/bootstrap) abririam
// para um token do MyControl colocado no cookie `session`, e vice-versa.
//
// O token só identifica o usuário: `ativo` e permissões são lidos do banco a CADA requisição
// (requireMcUser), então desativar alguém ou tirar uma permissão vale na próxima chamada, sem
// esperar as 8h do token expirarem.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { query } from "../../db.js";
import { send } from "../../utils/http.js";

export const MC_COOKIE = "mc_session";
export const MC_AUDIENCE = "mycontrol";
const DURACAO_SEGUNDOS = 60 * 60 * 8;

// Configuração injetada pelo server/index.js (segredo, opções do cookie e limite de login)
let configuracao = null;

// Recebe do servidor principal o JWT_SECRET já validado e as opções de cookie da sessão
export function configurarSessaoMc({ jwtSecret, sessionCookieOptions, isLoginRateLimited, registerLoginFailure }) {
  if (!jwtSecret) throw new Error("MyControl: JWT_SECRET ausente.");
  configuracao = {
    // Segredo derivado: nunca o mesmo do MyEstoque, então um token não serve no outro sistema
    segredo: crypto.createHmac("sha256", String(jwtSecret)).update("mycontrol").digest("hex"),
    cookieOptions: { ...sessionCookieOptions },
    isLoginRateLimited,
    registerLoginFailure
  };
}

// Falha fechada: sem configuração, nenhuma rota do MyControl autentica ninguém
function config() {
  if (!configuracao) throw new Error("MyControl: sessão não configurada.");
  return configuracao;
}

// Expõe o limite de tentativas de login compartilhado com o MyEstoque
export function limiteDeLogin() {
  const { isLoginRateLimited, registerLoginFailure } = config();
  return { isLoginRateLimited, registerLoginFailure };
}

// Monta o cabeçalho Set-Cookie com um token novo para o usuário
export function cookieDeSessaoMc(usuario) {
  const { segredo, cookieOptions } = config();
  const token = jwt.sign({ sub: String(usuario.id), usuario: usuario.usuario }, segredo, {
    audience: MC_AUDIENCE,
    algorithm: "HS256",
    expiresIn: DURACAO_SEGUNDOS
  });
  return serializeCookie(MC_COOKIE, token, { ...cookieOptions, maxAge: DURACAO_SEGUNDOS });
}

// Cabeçalho Set-Cookie que apaga a sessão do MyControl (não mexe no cookie do MyEstoque)
export function cookieLimparSessaoMc() {
  return serializeCookie(MC_COOKIE, "", { ...config().cookieOptions, maxAge: 0 });
}

// Lê e valida o token do cookie mc_session; devolve { id, emitidoEm } (segundos) ou null
export function tokenDaSessaoMc(req) {
  const { segredo } = config();
  const cookies = parseCookie(req.headers.cookie || "");
  if (!cookies[MC_COOKIE]) return null;
  try {
    const payload = jwt.verify(cookies[MC_COOKIE], segredo, { audience: MC_AUDIENCE, algorithms: ["HS256"] });
    const id = Number.parseInt(payload.sub, 10);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(payload.iat)) return null;
    return { id, emitidoEm: payload.iat };
  } catch {
    return null;
  }
}

// Token foi emitido antes da última redefinição de senha? Compara em segundos inteiros (o iat
// do JWT não tem fração): um token emitido no mesmo segundo da troca continua valendo.
export function tokenRevogadoPelaSenha(emitidoEm, senhaAlteradaEm) {
  if (!senhaAlteradaEm) return false;
  return emitidoEm < Math.floor(new Date(senhaAlteradaEm).getTime() / 1000);
}

// Carrega do banco o usuário da sessão atual (ativo ou não); null se não houver sessão válida
// ou se o token for anterior à última redefinição de senha daquele usuário
export async function usuarioDaSessaoMc(req) {
  const token = tokenDaSessaoMc(req);
  if (!token) return null;
  const linhas = await query("SELECT id, usuario, nome, permissoes, ativo, senha_alterada_em FROM mc_usuarios WHERE id = $1", [token.id]);
  const usuario = linhas[0];
  if (!usuario || tokenRevogadoPelaSenha(token.emitidoEm, usuario.senha_alterada_em)) return null;
  delete usuario.senha_alterada_em;
  return usuario;
}

// Exige usuário do MyControl logado, ativo e (opcionalmente) com a permissão pedida.
// Consulta o banco a cada chamada -- não confia no conteúdo do token. Já envia a resposta de erro.
export async function requireMcUser(req, res, permissao = null) {
  const usuario = await usuarioDaSessaoMc(req);
  if (!usuario || !usuario.ativo) {
    // Sessão inválida, revogada pela troca de senha ou de usuário desativado é descartada no navegador também
    send(res, 401, { error: "Login necessario." }, { "Set-Cookie": cookieLimparSessaoMc() });
    return null;
  }
  // Aceita uma permissão ou uma lista (basta ter qualquer uma delas)
  const exigidas = Array.isArray(permissao) ? permissao : permissao ? [permissao] : [];
  if (exigidas.length && !exigidas.some((chave) => (usuario.permissoes || []).includes(chave))) {
    send(res, 403, { error: "Seu usuário não tem permissão para esta ação." });
    return null;
  }
  return usuario;
}

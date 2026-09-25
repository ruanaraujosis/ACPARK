import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import jwt from "jsonwebtoken";
import { chamar, cookieDe, criarAmbienteDescartavel } from "./helpers/ambiente-descartavel.js";

// Sessão e segurança do MyControl contra servidor e banco DESCARTÁVEIS (nunca produção):
// isolamento de token nos dois sentidos, desativação e perda de permissão valendo na próxima
// requisição, permissão por rota, fallback /mycontrol/*, path traversal e limite de login.
// O teste de limite de login fica por último: ele bloqueia o IP 127.0.0.1 no servidor de teste.

let amb;
let rotas;
const senhaAdminMyEstoque = "senha-almox-teste";
const senhaA = "senha-gestor-a";
let cookieA; // mc_session do primeiro usuário (todas as permissões)
let cookieMyEstoque; // session do Almoxarifado no MyEstoque

// Cria um usuário do MyControl pelo gestor A e devolve o cookie de login dele
async function criarELogar(usuario, permissoes, senha = "senha-teste-1") {
  const criado = await chamar(amb.base, "/api/mycontrol/usuarios", {
    method: "POST",
    cookie: cookieA,
    corpo: { nome: usuario.toUpperCase(), usuario, senha, confirmarSenha: senha, permissoes }
  });
  assert.equal(criado.status, 200, JSON.stringify(criado.dados));
  const login = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario, senha } });
  assert.equal(login.status, 200, JSON.stringify(login.dados));
  return { id: criado.dados.usuario.id, cookie: cookieDe(login.cookies, "mc_session") };
}

// Requisição com caminho cru (sem a normalização de ".." que o fetch/URL fazem)
function getCru(base, caminho) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: caminho, method: "GET" }, (res) => {
      let corpo = "";
      res.on("data", (pedaco) => (corpo += pedaco));
      res.on("end", () => resolve({ status: res.statusCode, corpo }));
    });
    req.on("error", reject);
    req.end();
  });
}

test.before(async () => {
  amb = await criarAmbienteDescartavel();
  // A tabela de rotas é importada só depois de apontar DATABASE_URL para o banco descartável
  process.env.DATABASE_URL = amb.databaseUrl;
  ({ ROTAS_MYCONTROL: rotas } = await import("../server/modules/mycontrol/mycontrol.routes.js"));

  // MyEstoque: instalação nova -> define a senha do Almoxarifado e entra
  assert.equal((await chamar(amb.base, "/api/setup/senha-admin", { method: "POST", corpo: { senha: senhaAdminMyEstoque, confirmarSenha: senhaAdminMyEstoque } })).status, 200);
  const loginEstoque = await chamar(amb.base, "/api/auth/login", { method: "POST", corpo: { profile: "admin", password: senhaAdminMyEstoque } });
  cookieMyEstoque = cookieDe(loginEstoque.cookies, "session");
  assert.ok(cookieMyEstoque);

  // MyControl: primeiro usuário pelo assistente (já sai logado)
  const primeiro = await chamar(amb.base, "/api/mycontrol/setup/primeiro-usuario", {
    method: "POST",
    corpo: { nome: "Gestor A", usuario: "gestor.a", senha: senhaA, confirmarSenha: senhaA }
  });
  assert.equal(primeiro.status, 200, JSON.stringify(primeiro.dados));
  cookieA = cookieDe(primeiro.cookies, "mc_session");
  assert.ok(cookieA, "o assistente deveria já devolver a sessão do MyControl");
});

test.after(async () => {
  await amb?.encerrar();
});

test("o cookie do MyControl é mc_session, com as mesmas opções do cookie do MyEstoque", async () => {
  const login = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "gestor.a", senha: senhaA } });
  const linha = login.cookies.find((c) => c.startsWith("mc_session="));
  assert.ok(linha);
  assert.match(linha, /HttpOnly/i);
  assert.match(linha, /SameSite=Lax/i);
  assert.match(linha, /Path=\//);
  assert.doesNotMatch(linha, /Secure/i, "sem FORCE_SECURE_COOKIES o cookie não pode ser secure (LAN em HTTP)");
  assert.ok(!login.cookies.some((c) => c.startsWith("session=")), "login do MyControl não mexe no cookie do MyEstoque");
});

test("token do MyControl não abre o MyEstoque (/api/auth/me e /api/bootstrap)", async () => {
  const tokenMc = cookieA.split("=")[1];
  const me = await chamar(amb.base, "/api/auth/me", { cookie: `session=${tokenMc}` });
  assert.equal(me.status, 200);
  assert.equal(me.dados.user, null);
  const bootstrap = await chamar(amb.base, "/api/bootstrap", { cookie: `session=${tokenMc}` });
  assert.equal(bootstrap.status, 401);

  // Mesmo assinado com o JWT_SECRET do MyEstoque, um token com aud "mycontrol" é recusado
  const forjado = jwt.sign({ role: "admin", name: "Almoxarifado" }, amb.jwtSecret, { audience: "mycontrol", expiresIn: "1h" });
  assert.equal((await chamar(amb.base, "/api/auth/me", { cookie: `session=${forjado}` })).dados.user, null);
  assert.equal((await chamar(amb.base, "/api/bootstrap", { cookie: `session=${forjado}` })).status, 401);
  const forjadoLista = jwt.sign({ role: "admin" }, amb.jwtSecret, { audience: ["outro", "mycontrol"], expiresIn: "1h" });
  assert.equal((await chamar(amb.base, "/api/bootstrap", { cookie: `session=${forjadoLista}` })).status, 401);
  // O cookie mc_session sozinho também não serve para o MyEstoque
  assert.equal((await chamar(amb.base, "/api/bootstrap", { cookie: cookieA })).status, 401);
});

test("token do MyEstoque não abre o MyControl", async () => {
  const tokenEstoque = cookieMyEstoque.split("=")[1];
  const comoMc = await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: `mc_session=${tokenEstoque}` });
  assert.equal(comoMc.status, 401);
  assert.equal((await chamar(amb.base, "/api/mycontrol/auth/me", { cookie: `mc_session=${tokenEstoque}` })).dados.usuario, null);
  // O cookie `session` do MyEstoque sozinho não autentica no MyControl
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: cookieMyEstoque })).status, 401);

  // Token com aud certo mas assinado com o segredo BASE (não o derivado) é recusado
  const comSegredoBase = jwt.sign({ sub: "1", usuario: "gestor.a" }, amb.jwtSecret, { audience: "mycontrol", expiresIn: "1h" });
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: `mc_session=${comSegredoBase}` })).status, 401);
  // alg=none é recusado
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const semAssinatura = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "1", aud: "mycontrol", exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: `mc_session=${semAssinatura}` })).status, 401);
});

test("dá para ficar logado nos dois no mesmo navegador, e o logout do MyControl não derruba o MyEstoque", async () => {
  const ambos = `${cookieMyEstoque}; ${cookieA}`;
  assert.equal((await chamar(amb.base, "/api/bootstrap", { cookie: ambos })).status, 200);
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: ambos })).status, 200);
  const logout = await chamar(amb.base, "/api/mycontrol/auth/logout", { method: "POST", cookie: ambos });
  assert.equal(logout.status, 200);
  assert.ok(logout.cookies.some((c) => /^mc_session=;/.test(c) && /Max-Age=0/i.test(c)), "logout precisa limpar mc_session");
  assert.ok(!logout.cookies.some((c) => c.startsWith("session=")), "logout do MyControl não pode limpar o cookie do MyEstoque");
});

test("usuário desativado perde o acesso na próxima requisição", async () => {
  const b = await criarELogar("usuario.b", ["dashboard.ver"]);
  assert.equal((await chamar(amb.base, "/api/mycontrol/auth/me", { cookie: b.cookie })).dados.usuario.usuario, "usuario.b");

  const desativa = await chamar(amb.base, `/api/mycontrol/usuarios/${b.id}/ativo`, { method: "POST", cookie: cookieA, corpo: { ativo: false } });
  assert.equal(desativa.status, 200);

  // O token de 8h continua válido na assinatura, mas o servidor consulta `ativo` no banco
  const me = await chamar(amb.base, "/api/mycontrol/auth/me", { cookie: b.cookie });
  assert.equal(me.dados.usuario, null);
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: b.cookie })).status, 401);
  // E também não consegue entrar de novo
  const login = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "usuario.b", senha: "senha-teste-1" } });
  assert.equal(login.status, 403);
});

test("permissão retirada vale na próxima requisição", async () => {
  const c = await criarELogar("usuario.c", ["usuario.gerenciar", "dashboard.ver"]);
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: c.cookie })).status, 200);

  const edita = await chamar(amb.base, `/api/mycontrol/usuarios/${c.id}`, {
    method: "PATCH",
    cookie: cookieA,
    corpo: { nome: "USUARIO C", permissoes: ["dashboard.ver"] }
  });
  assert.equal(edita.status, 200, JSON.stringify(edita.dados));
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: c.cookie })).status, 403);
  assert.deepEqual((await chamar(amb.base, "/api/mycontrol/auth/me", { cookie: c.cookie })).dados.usuario.permissoes, ["dashboard.ver"]);
});

test("cada rota protegida recusa quem não tem a permissão dela (e quem não tem sessão)", async () => {
  const d = await criarELogar("usuario.d", ["dashboard.ver"]);
  const protegidas = rotas.filter((rota) => !rota.publica);
  assert.ok(protegidas.length >= 30, `esperava as rotas de usuários, campos, cargos, cadastros e arquivos (achei ${protegidas.length})`);
  // PNG mínimo válido (1x1): as rotas de upload exigem corpo de imagem, não JSON
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");
  for (const rota of protegidas) {
    assert.ok(rota.permissao, `rota ${rota.caminho} sem permissão declarada`);
    const caminho = rota.caminho.source
      .replace(/^\^/, "")
      .replace(/\$$/, "")
      .replace("(\\d{1,9})", String(d.id))
      .replace(/\([a-z|]+\)/, "colaborador")
      .replace(/\\\//g, "/");
    const tentar = (cookie) => {
      if (rota.corpo === "imagem") {
        return fetch(`${amb.base}${caminho}`, { method: rota.metodo, headers: { "Content-Type": "image/png", ...(cookie ? { Cookie: cookie } : {}) }, body: png });
      }
      const corpo = rota.metodo === "GET" ? undefined : { nome: "X", usuario: "novo.x", senha: "123456", confirmarSenha: "123456", permissoes: ["dashboard.ver"], ativo: false, entidade: "colaborador", valores: { nome: "X" } };
      return chamar(amb.base, caminho, { method: rota.metodo, cookie, corpo });
    };
    const semPermissao = await tentar(d.cookie);
    assert.equal(semPermissao.status, 403, `${rota.metodo} ${caminho} deveria recusar sem ${rota.permissao}`);
    const semSessao = await tentar(null);
    assert.equal(semSessao.status, 401, `${rota.metodo} ${caminho} deveria exigir sessão`);
  }
  // Nenhum arquivo nem cadastro nasceu das tentativas recusadas
  for (const tabela of ["mc_arquivos", "mc_colaboradores", "mc_cargos"]) {
    const { rows } = await amb.sql(`SELECT count(*)::int AS n FROM ${tabela}`);
    assert.equal(rows[0].n, 0, `${tabela} deveria continuar vazia`);
  }
  // Nada foi criado nem alterado pelas tentativas recusadas
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios WHERE usuario = 'novo.x'");
  assert.equal(rows[0].n, 0);
  const { rows: alvo } = await amb.sql("SELECT ativo FROM mc_usuarios WHERE id = $1", [d.id]);
  assert.equal(alvo[0].ativo, true);
});

test("caminho desconhecido em /api/mycontrol/* é 404 do MyControl, nunca cai no MyEstoque", async () => {
  const r = await chamar(amb.base, "/api/mycontrol/bootstrap", { cookie: cookieMyEstoque });
  assert.equal(r.status, 404);
  // Id maior que o INTEGER do banco é 404, não erro 500
  const enorme = await chamar(amb.base, "/api/mycontrol/usuarios/99999999999", { method: "PATCH", cookie: cookieA, corpo: { nome: "X", permissoes: ["dashboard.ver"] } });
  assert.equal(enorme.status, 404);
});

test("escrita com corpo que não é JSON é recusada mesmo com sessão válida", async () => {
  const r = await fetch(`${amb.base}/api/mycontrol/usuarios`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Cookie: cookieA },
    body: JSON.stringify({ nome: "Forjado", usuario: "forjado", senha: "123456", confirmarSenha: "123456", permissoes: ["dashboard.ver"] })
  });
  assert.equal(r.status, 415);
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios WHERE usuario = 'forjado'");
  assert.equal(rows[0].n, 0);
});

test("/mycontrol e /mycontrol/* sem arquivo caem no index.html do MyControl, sem cache", async () => {
  for (const caminho of ["/mycontrol", "/mycontrol/", "/mycontrol/configuracoes/usuarios", "/mycontrol/qualquer/coisa"]) {
    const r = await chamar(amb.base, caminho);
    assert.equal(r.status, 200, caminho);
    assert.match(r.texto, /<title>MyControl<\/title>/, `${caminho} deveria servir o index do MyControl`);
    assert.equal(r.headers.get("cache-control"), "no-store", caminho);
  }
  // Fora de /mycontrol o fallback continua sendo o MyEstoque
  const outra = await chamar(amb.base, "/pagina-inexistente");
  assert.doesNotMatch(outra.texto, /<title>MyControl<\/title>/);
  assert.match(outra.texto, /\/app\.js\?v=/);
  // "/mycontrolx" não é o MyControl
  assert.doesNotMatch((await chamar(amb.base, "/mycontrolx")).texto, /<title>MyControl<\/title>/);
  // Asset versionado do MyControl vai com cache imutável
  const js = await chamar(amb.base, "/mycontrol/app.js?v=teste");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.match(js.headers.get("cache-control"), /immutable/);
});

test("path traversal a partir de /mycontrol não vaza arquivo de fora de public", async () => {
  const tentativas = [
    "/mycontrol/../../.env.local",
    "/mycontrol/..%2f..%2f.env.local",
    "/mycontrol/%2e%2e/%2e%2e/.env.local",
    "/mycontrol/..%5c..%5c.env.local",
    "/mycontrol/%2e%2e%2f%2e%2e%2fpackage.json",
    "/%2e%2e/package.json",
    "/..%2fserver%2fdb.js"
  ];
  for (const caminho of tentativas) {
    const r = await getCru(amb.base, caminho);
    assert.ok([200, 400, 403, 404].includes(r.status), `${caminho}: status ${r.status}`);
    assert.doesNotMatch(r.corpo, /DATABASE_URL|JWT_SECRET|"dependencies"|createHmac|new Pool/, `${caminho} vazou conteúdo de fora de public`);
  }
  // Encoding quebrado não derruba o servidor
  assert.equal((await getCru(amb.base, "/mycontrol/%E0%A4%A")).status, 400);
  assert.equal((await chamar(amb.base, "/api/health")).status, 200);
});

test("login do MyControl usa o mesmo limite de tentativas do MyEstoque (roda por último)", async () => {
  // Mensagem igual para login inexistente e senha errada (não revela quem existe)
  const inexistente = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "nao.existe", senha: "x" } });
  const senhaErrada = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "gestor.a", senha: "errada" } });
  assert.equal(inexistente.status, 401);
  assert.equal(senhaErrada.status, 401);
  assert.equal(inexistente.dados.error, senhaErrada.dados.error);

  let status = 401;
  for (let i = 0; i < 12 && status !== 429; i++) {
    status = (await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "gestor.a", senha: `errada-${i}` } })).status;
  }
  assert.equal(status, 429, "depois de 8 falhas o login deveria ser bloqueado");
  // Bloqueado, nem a senha certa entra
  const certa = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "gestor.a", senha: senhaA } });
  assert.equal(certa.status, 429);
  // O contador é o mesmo do MyEstoque (mesmo IP): o login do Almoxarifado também fica bloqueado
  const estoque = await chamar(amb.base, "/api/auth/login", { method: "POST", corpo: { profile: "admin", password: senhaAdminMyEstoque } });
  assert.equal(estoque.status, 429);
});

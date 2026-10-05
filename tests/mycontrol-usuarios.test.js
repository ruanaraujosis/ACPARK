import test from "node:test";
import assert from "node:assert/strict";
import { chamar, cookieDe, criarAmbienteDescartavel } from "./helpers/ambiente-descartavel.js";

// Usuários do MyControl contra servidor e banco DESCARTÁVEIS (nunca produção): assistente de
// primeiro uso (inclusive envios simultâneos), validação de permissões, proteção do último
// gestor e de si mesmo (também sob concorrência) e trilha de auditoria.

let amb;
let cookieA;
let idA;
const senhaA = "senha-gestor-a";

// Atalho para chamar a API do MyControl com o cookie informado
const api = (caminho, opcoes = {}) => chamar(amb.base, `/api/mycontrol${caminho}`, opcoes);

// Cria usuário pelo gestor A e devolve id + cookie de login
async function criarELogar(usuario, permissoes, senha = "senha-teste-1") {
  const criado = await api("/usuarios", {
    method: "POST",
    cookie: cookieA,
    corpo: { nome: usuario.toUpperCase(), usuario, senha, confirmarSenha: senha, permissoes }
  });
  assert.equal(criado.status, 200, JSON.stringify(criado.dados));
  const login = await api("/auth/login", { method: "POST", corpo: { usuario, senha } });
  assert.equal(login.status, 200, JSON.stringify(login.dados));
  return { id: criado.dados.usuario.id, cookie: cookieDe(login.cookies, "mc_session") };
}

// Quantos usuários ativos com usuario.gerenciar existem no banco
async function gestoresAtivos() {
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios WHERE ativo AND 'usuario.gerenciar' = ANY(permissoes)");
  return rows[0].n;
}

test.before(async () => {
  amb = await criarAmbienteDescartavel();
});

test.after(async () => {
  await amb?.encerrar();
});

test("assistente: disponível com zero usuários; recusa senha curta e confirmação diferente", async () => {
  const status = await api("/setup/status");
  assert.equal(status.status, 200);
  assert.equal(status.dados.disponivel, true);

  const curta = await api("/setup/primeiro-usuario", { method: "POST", corpo: { nome: "A", usuario: "gestor.a", senha: "123", confirmarSenha: "123" } });
  assert.equal(curta.status, 400);
  const diferente = await api("/setup/primeiro-usuario", { method: "POST", corpo: { nome: "A", usuario: "gestor.a", senha: "123456", confirmarSenha: "654321" } });
  assert.equal(diferente.status, 400);
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios");
  assert.equal(rows[0].n, 0);
});

test("assistente: recusa corpo que não seja JSON (formulário de outro site não cria o primeiro usuário)", async () => {
  // Um <form enctype="text/plain"> consegue montar um corpo que parece JSON sem preflight de CORS
  const corpoForjado = JSON.stringify({ nome: "Intruso", usuario: "intruso", senha: "123456", confirmarSenha: "123456" });
  for (const tipo of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
    const r = await chamar(amb.base, "/api/mycontrol/setup/primeiro-usuario", { method: "POST", headers: { "Content-Type": tipo }, corpo: undefined });
    assert.equal(r.status, 415, tipo);
  }
  const resposta = await fetch(`${amb.base}/api/mycontrol/setup/primeiro-usuario`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: corpoForjado });
  assert.equal(resposta.status, 415);
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios");
  assert.equal(rows[0].n, 0);
});

test("assistente: envios simultâneos criam exatamente UM primeiro usuário", async () => {
  const envios = Array.from({ length: 6 }, (_, i) =>
    api("/setup/primeiro-usuario", {
      method: "POST",
      corpo: { nome: `Gestor ${i}`, usuario: i === 0 ? "gestor.a" : `gestor.${i}`, senha: senhaA, confirmarSenha: senhaA }
    })
  );
  const respostas = await Promise.all(envios);
  const aceitos = respostas.filter((r) => r.status === 200);
  assert.equal(aceitos.length, 1, `esperava 1 aceito, vieram: ${respostas.map((r) => r.status).join(",")}`);
  assert.ok(respostas.filter((r) => r.status !== 200).every((r) => r.status === 403));
  const { rows } = await amb.sql("SELECT id, usuario, permissoes FROM mc_usuarios");
  assert.equal(rows.length, 1);

  // Para o resto do arquivo, o gestor A é quem venceu a corrida (login e senha conhecidos)
  const vencedor = aceitos[0];
  cookieA = cookieDe(vencedor.cookies, "mc_session");
  idA = vencedor.dados.usuario.id;
  assert.ok(cookieA, "o assistente já faz login");
  // O primeiro usuário nasce com TODAS as permissões do catálogo
  const catalogo = vencedor.dados.catalogo.flatMap((grupo) => grupo.permissoes.map((p) => p.chave));
  assert.deepEqual([...vencedor.dados.usuario.permissoes].sort(), [...catalogo].sort());
  assert.equal(catalogo.length, 12);
});

test("assistente: se tranca depois do primeiro usuário, mesmo chamado direto", async () => {
  assert.equal((await api("/setup/status")).dados.disponivel, false);
  const denovo = await api("/setup/primeiro-usuario", { method: "POST", corpo: { nome: "Intruso", usuario: "intruso", senha: "123456", confirmarSenha: "123456" } });
  assert.equal(denovo.status, 403);
  assert.equal(denovo.cookies.length, 0, "a recusa não pode devolver sessão");
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios");
  assert.equal(rows[0].n, 1);
  const auditoria = await amb.sql("SELECT acao, usuario_id FROM mc_auditoria WHERE acao = 'usuario.criar_primeiro'");
  assert.equal(auditoria.rows.length, 1);
  assert.equal(auditoria.rows[0].usuario_id, idA);
});

test("as datas novas são TIMESTAMPTZ", async () => {
  const { rows } = await amb.sql(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_name IN ('mc_usuarios', 'mc_auditoria') AND column_name IN ('criado_em', 'ultimo_login_em')`
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.data_type === "timestamp with time zone"), JSON.stringify(rows));
});

test("chave de permissão desconhecida é recusada ao criar e ao editar", async () => {
  const criar = await api("/usuarios", {
    method: "POST",
    cookie: cookieA,
    corpo: { nome: "X", usuario: "usuario.x", senha: "123456", confirmarSenha: "123456", permissoes: ["dashboard.ver", "admin.tudo"] }
  });
  assert.equal(criar.status, 400);
  assert.match(criar.dados.error, /admin\.tudo/);
  assert.equal((await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios WHERE usuario = 'usuario.x'")).rows[0].n, 0);

  const semNenhuma = await api("/usuarios", {
    method: "POST",
    cookie: cookieA,
    corpo: { nome: "X", usuario: "usuario.x", senha: "123456", confirmarSenha: "123456", permissoes: [] }
  });
  assert.equal(semNenhuma.status, 400);

  const b = await criarELogar("usuario.b", ["dashboard.ver"]);
  const editar = await api(`/usuarios/${b.id}`, { method: "PATCH", cookie: cookieA, corpo: { nome: "B", permissoes: ["dashboard.ver", "registro.tudo"] } });
  assert.equal(editar.status, 400);
  const naoArray = await api(`/usuarios/${b.id}`, { method: "PATCH", cookie: cookieA, corpo: { nome: "B", permissoes: "usuario.gerenciar" } });
  assert.equal(naoArray.status, 400);
  const { rows } = await amb.sql("SELECT permissoes FROM mc_usuarios WHERE id = $1", [b.id]);
  assert.deepEqual(rows[0].permissoes, ["dashboard.ver"]);
});

test("login é único e sempre minúsculo", async () => {
  const maiusculo = await api("/usuarios", {
    method: "POST",
    cookie: cookieA,
    corpo: { nome: "Carla", usuario: "  Carla.Souza ", senha: "123456", confirmarSenha: "123456", permissoes: ["dashboard.ver"] }
  });
  assert.equal(maiusculo.status, 200);
  assert.equal(maiusculo.dados.usuario.usuario, "carla.souza");
  const repetido = await api("/usuarios", {
    method: "POST",
    cookie: cookieA,
    corpo: { nome: "Outra", usuario: "CARLA.SOUZA", senha: "123456", confirmarSenha: "123456", permissoes: ["dashboard.ver"] }
  });
  assert.equal(repetido.status, 409);
  const invalido = await api("/usuarios", {
    method: "POST",
    cookie: cookieA,
    corpo: { nome: "Y", usuario: "a b", senha: "123456", confirmarSenha: "123456", permissoes: ["dashboard.ver"] }
  });
  assert.equal(invalido.status, 400);
  // A resposta nunca traz o hash da senha
  assert.equal(maiusculo.dados.usuario.senha, undefined);
  const lista = await api("/usuarios", { cookie: cookieA });
  assert.ok(lista.dados.usuarios.every((u) => u.senha === undefined));
  assert.doesNotMatch(lista.texto, /pbkdf2/);
});

test("ninguém tira usuario.gerenciar de si mesmo nem se desativa", async () => {
  const tirar = await api(`/usuarios/${idA}`, { method: "PATCH", cookie: cookieA, corpo: { nome: "Gestor A", permissoes: ["dashboard.ver"] } });
  assert.equal(tirar.status, 400);
  assert.match(tirar.dados.error, /si mesmo/);
  const desativar = await api(`/usuarios/${idA}/ativo`, { method: "POST", cookie: cookieA, corpo: { ativo: false } });
  assert.equal(desativar.status, 400);
  // Pode editar as próprias permissões desde que mantenha usuario.gerenciar
  const manter = await api(`/usuarios/${idA}`, { method: "PATCH", cookie: cookieA, corpo: { nome: "Gestor A", permissoes: ["usuario.gerenciar", "dashboard.ver"] } });
  assert.equal(manter.status, 200);
  assert.deepEqual(manter.dados.usuario.permissoes, ["usuario.gerenciar", "dashboard.ver"]);
  assert.equal(await gestoresAtivos(), 1);
});

test("dois gestores tirando a permissão um do outro ao mesmo tempo: sobra pelo menos um", async () => {
  const g = await criarELogar("gestor.g", ["usuario.gerenciar"]);
  assert.equal(await gestoresAtivos(), 2);
  for (let rodada = 0; rodada < 3; rodada++) {
    const [r1, r2] = await Promise.all([
      api(`/usuarios/${g.id}`, { method: "PATCH", cookie: cookieA, corpo: { nome: "GESTOR G", permissoes: ["dashboard.ver"] } }),
      api(`/usuarios/${idA}`, { method: "PATCH", cookie: g.cookie, corpo: { nome: "Gestor A", permissoes: ["dashboard.ver"] } })
    ]);
    assert.equal([r1, r2].filter((r) => r.status === 200).length, 1, `só uma das duas pode vencer: ${r1.status}/${r2.status}`);
    assert.equal(await gestoresAtivos(), 1, "nunca pode ficar sem gestor de usuários");
    // Restaura o cenário para a próxima rodada (quem sobrou devolve a permissão ao outro)
    const sobrou = r1.status === 200 ? { cookie: cookieA, outro: g.id, nome: "GESTOR G" } : { cookie: g.cookie, outro: idA, nome: "Gestor A" };
    const volta = await api(`/usuarios/${sobrou.outro}`, { method: "PATCH", cookie: sobrou.cookie, corpo: { nome: sobrou.nome, permissoes: ["usuario.gerenciar", "dashboard.ver"] } });
    assert.equal(volta.status, 200);
  }
});

test("dois gestores desativando um ao outro ao mesmo tempo: sobra pelo menos um ativo", async () => {
  const h = await criarELogar("gestor.h", ["usuario.gerenciar"]);
  // Deixa só A e H como gestores ativos
  const { rows } = await amb.sql("SELECT id FROM mc_usuarios WHERE ativo AND 'usuario.gerenciar' = ANY(permissoes) AND id NOT IN ($1, $2)", [idA, h.id]);
  for (const linha of rows) {
    assert.equal((await api(`/usuarios/${linha.id}/ativo`, { method: "POST", cookie: cookieA, corpo: { ativo: false } })).status, 200);
  }
  assert.equal(await gestoresAtivos(), 2);
  const [r1, r2] = await Promise.all([
    api(`/usuarios/${h.id}/ativo`, { method: "POST", cookie: cookieA, corpo: { ativo: false } }),
    api(`/usuarios/${idA}/ativo`, { method: "POST", cookie: h.cookie, corpo: { ativo: false } })
  ]);
  assert.equal([r1, r2].filter((r) => r.status === 200).length, 1, `${r1.status}/${r2.status}`);
  assert.equal(await gestoresAtivos(), 1);
  // Garante que A continua ativo para os próximos testes
  if (r2.status === 200) {
    await amb.sql("UPDATE mc_usuarios SET ativo = TRUE WHERE id = $1", [idA]);
  }
});

test("redefinir senha troca a senha e a auditoria não guarda hash", async () => {
  const r = await criarELogar("usuario.r", ["dashboard.ver"], "senha-antiga");
  const curta = await api(`/usuarios/${r.id}/senha`, { method: "POST", cookie: cookieA, corpo: { senha: "12", confirmarSenha: "12" } });
  assert.equal(curta.status, 400);
  const troca = await api(`/usuarios/${r.id}/senha`, { method: "POST", cookie: cookieA, corpo: { senha: "senha-nova-1", confirmarSenha: "senha-nova-1" } });
  assert.equal(troca.status, 200);
  assert.equal((await api("/auth/login", { method: "POST", corpo: { usuario: "usuario.r", senha: "senha-nova-1" } })).status, 200);
  const auditoria = await amb.sql("SELECT antes, depois FROM mc_auditoria WHERE acao = 'usuario.senha_redefinida' AND entidade_id = $1", [String(r.id)]);
  assert.equal(auditoria.rows.length, 1);
  const tudo = await amb.sql("SELECT coalesce(string_agg(coalesce(antes::text, '') || coalesce(depois::text, ''), ''), '') AS t FROM mc_auditoria");
  assert.doesNotMatch(tudo.rows[0].t, /pbkdf2|senha-nova/);
});

test("auditoria registra criação, permissões, desativação e reativação com o autor", async () => {
  const z = await criarELogar("usuario.z", ["dashboard.ver"]);
  await api(`/usuarios/${z.id}`, { method: "PATCH", cookie: cookieA, corpo: { nome: "USUARIO.Z", permissoes: ["dashboard.ver", "registro.registrar"] } });
  await api(`/usuarios/${z.id}/ativo`, { method: "POST", cookie: cookieA, corpo: { ativo: false } });
  await api(`/usuarios/${z.id}/ativo`, { method: "POST", cookie: cookieA, corpo: { ativo: true } });
  const { rows } = await amb.sql("SELECT acao, usuario_id, antes, depois FROM mc_auditoria WHERE entidade = 'usuario' AND entidade_id = $1 ORDER BY id", [String(z.id)]);
  assert.deepEqual(rows.map((r) => r.acao), ["usuario.criar", "usuario.permissoes", "usuario.desativar", "usuario.reativar"]);
  assert.ok(rows.every((r) => r.usuario_id === idA), "o autor é quem fez a mudança");
  assert.deepEqual(rows[1].antes, { permissoes: ["dashboard.ver"] });
  assert.deepEqual(rows[1].depois, { permissoes: ["registro.registrar", "dashboard.ver"] });
});

test("não existe rota de exclusão física de usuário", async () => {
  const r = await api(`/usuarios/${idA}`, { method: "DELETE", cookie: cookieA });
  assert.equal(r.status, 404);
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_usuarios WHERE id = $1", [idA]);
  assert.equal(rows[0].n, 1);
});

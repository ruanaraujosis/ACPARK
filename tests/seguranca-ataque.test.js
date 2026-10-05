import test from "node:test";
import assert from "node:assert/strict";
import { chamar, cookieDe, criarAmbienteDescartavel } from "./helpers/ambiente-descartavel.js";

// Ataques reais contra um servidor de verdade num banco descartável (nunca produção).
// Cada teste é o ponto de vista do atacante: tudo aqui tem de FALHAR para ele.
let amb;
const SENHA = "senha-correta-teste";

test.before(async () => {
  amb = await criarAmbienteDescartavel();
  const setup = await chamar(amb.base, "/api/setup/senha-admin", {
    method: "POST",
    corpo: { senha: SENHA, confirmarSenha: SENHA }
  });
  assert.equal(setup.status, 200);
});

test.after(async () => {
  if (amb) await amb.encerrar();
});

// Faz login de admin e devolve o cookie de sessão
async function loginAdmin() {
  const login = await chamar(amb.base, "/api/auth/login", { method: "POST", corpo: { profile: "admin", password: SENHA } });
  assert.equal(login.status, 200);
  return cookieDe(login.cookies, "session");
}

test("erro interno do banco não chega ao navegador (sem SQL, tabela ou coluna)", async () => {
  const cookie = await loginAdmin();
  // Some com uma tabela que o bootstrap consulta: o pg responde "relação ... não existe"
  await amb.sql("ALTER TABLE categorias RENAME TO categorias_sumiu");
  try {
    const resposta = await chamar(amb.base, "/api/bootstrap", { cookie });
    assert.equal(resposta.status, 500);
    assert.doesNotMatch(resposta.texto, /categorias|rela[cç][aã]o|relation|42P01|SELECT/i);
    assert.match(resposta.dados.message, /Erro interno/);
  } finally {
    await amb.sql("ALTER TABLE categorias_sumiu RENAME TO categorias");
  }
  // O detalhe técnico continua indo para o log do servidor, onde ajuda a diagnosticar
  assert.match(amb.saida.join(""), /categorias/);
});

test("reconfirmar a senha do admin também é limitado (não serve de atalho para força bruta)", async () => {
  // A sessão de admin é obtida ANTES de gastar as tentativas
  const cookie = await loginAdmin();
  const tentativas = [];
  for (let i = 0; i < 4; i += 1) {
    tentativas.push(
      await chamar(amb.base, "/api/admin/config", {
        method: "POST",
        cookie,
        corpo: { currentAdminPassword: `errada-${i}`, adminPassword: "nova-senha-x", confirmAdminPassword: "nova-senha-x" }
      })
    );
  }
  // Limite de 3 tentativas: as 3 primeiras dizem "senha errada", a 4ª já é bloqueada
  assert.deepEqual(tentativas.slice(0, 3).map((t) => t.status), [401, 401, 401]);
  assert.equal(tentativas[3].status, 429);

  // E o bloqueio vale para o login também: mesmo a senha certa é recusada durante a janela
  const login = await chamar(amb.base, "/api/auth/login", { method: "POST", corpo: { profile: "admin", password: SENHA } });
  assert.equal(login.status, 429);
});

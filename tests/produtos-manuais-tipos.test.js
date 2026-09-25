import test from "node:test";
import assert from "node:assert/strict";
import { chamar, cookieDe, criarAmbienteDescartavel } from "./helpers/ambiente-descartavel.js";

// Criar, editar e importar produto manual contra servidor e banco DESCARTÁVEIS (nunca produção).
// Desde que produtos.qtd_total virou NUMERIC (estoque_central segue INTEGER), usar o mesmo
// parâmetro nas duas colunas fazia o Postgres recusar a consulta ("inconsistent types").

let amb;
let cookie;
const senha = "senha-admin-teste";

// Atalho para as rotas do MyEstoque com a sessão do Almoxarifado
const api = (caminho, opcoes = {}) => chamar(amb.base, caminho, { cookie, ...opcoes });

test.before(async () => {
  amb = await criarAmbienteDescartavel();
  assert.equal((await chamar(amb.base, "/api/setup/senha-admin", { method: "POST", corpo: { senha, confirmarSenha: senha } })).status, 200);
  const login = await chamar(amb.base, "/api/auth/login", { method: "POST", corpo: { profile: "admin", password: senha } });
  assert.equal(login.status, 200);
  cookie = cookieDe(login.cookies, "session");
});

test.after(async () => {
  await amb?.encerrar();
});

test("criar produto manual grava qtd_total e estoque_central", async () => {
  const r = await api("/api/admin/products", { method: "POST", corpo: { sku: "TESTE-1", nome: "Produto teste", qtd_total: 12, categorias: ["LIMPEZA"] } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const { rows } = await amb.sql("SELECT qtd_total::float AS q, estoque_central AS e, categoria FROM produtos WHERE sku = 'TESTE-1'");
  assert.deepEqual(rows[0], { q: 12, e: 12, categoria: "LIMPEZA" });
});

test("editar produto manual atualiza as duas colunas", async () => {
  const r = await api("/api/admin/products", { method: "PATCH", corpo: { sku: "TESTE-1", nome: "Produto teste 2", qtd_total: 7, ativo: true, categorias: ["LIMPEZA"] } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const { rows } = await amb.sql("SELECT nome, qtd_total::float AS q, estoque_central AS e FROM produtos WHERE sku = 'TESTE-1'");
  assert.deepEqual(rows[0], { nome: "PRODUTO TESTE 2", q: 7, e: 7 });
});

test("importar produtos em lote grava as duas colunas", async () => {
  const r = await api("/api/admin/products/import", {
    method: "POST",
    corpo: { items: [{ sku: "IMP-1", nome: "Importado 1", qtd_total: 3, categoria: "ESCRITORIO" }, { sku: "IMP-2", nome: "Importado 2", qtd_total: 0 }] }
  });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const { rows } = await amb.sql("SELECT sku, qtd_total::float AS q, estoque_central AS e FROM produtos WHERE sku LIKE 'IMP-%' ORDER BY sku");
  assert.deepEqual(rows, [{ sku: "IMP-1", q: 3, e: 3 }, { sku: "IMP-2", q: 0, e: 0 }]);
});

test("quantidade fracionada é aceita no cadastro, na edição e na importação (vírgula ou ponto)", async () => {
  const criado = await api("/api/admin/products", { method: "POST", corpo: { sku: "KG-1", nome: "Carne kg", qtd_total: "2,5" } });
  assert.equal(criado.status, 200, JSON.stringify(criado.dados));
  let { rows } = await amb.sql("SELECT qtd_total::float AS q, estoque_central AS e FROM produtos WHERE sku = 'KG-1'");
  assert.deepEqual(rows[0], { q: 2.5, e: 3 }, "qtd_total guarda a fração; estoque_central (legado) guarda o arredondado");

  const editado = await api("/api/admin/products", { method: "PATCH", corpo: { sku: "KG-1", nome: "Carne kg", qtd_total: 1.2345, ativo: true } });
  assert.equal(editado.status, 200, JSON.stringify(editado.dados));
  ({ rows } = await amb.sql("SELECT qtd_total::float AS q FROM produtos WHERE sku = 'KG-1'"));
  assert.equal(rows[0].q, 1.235, "arredonda para 3 casas");

  const importado = await api("/api/admin/products/import", { method: "POST", corpo: { items: [{ sku: "KG-2", nome: "Queijo kg", qtd_total: "0.75" }, { sku: "KG-3", nome: "Negativo", qtd_total: -4 }, { sku: "KG-4", nome: "Texto", qtd_total: "abc" }] } });
  assert.equal(importado.status, 200, JSON.stringify(importado.dados));
  ({ rows } = await amb.sql("SELECT sku, qtd_total::float AS q FROM produtos WHERE sku IN ('KG-2','KG-3','KG-4') ORDER BY sku"));
  assert.deepEqual(rows, [{ sku: "KG-2", q: 0.75 }, { sku: "KG-3", q: 0 }, { sku: "KG-4", q: 0 }], "negativo e inválido viram zero");
});

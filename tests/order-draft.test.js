import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8");

test("pdv order draft has backend storage and routes", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS pedido_rascunhos/);
  assert.match(routes, /function ensurePedidoDraftTable/);
  assert.match(routes, /url\.pathname === "\/api\/pdv\/order-draft"/);
  assert.match(routes, /INSERT INTO pedido_rascunhos/);
  assert.match(routes, /ON CONFLICT \(pdv_id\) DO UPDATE/);
  assert.match(routes, /DELETE FROM pedido_rascunhos WHERE pdv_id = \$1/);
});

test("pdv order screen can save, restore and clear cart draft", () => {
  assert.match(app, /\/api\/pdv\/order-draft/);
  assert.match(app, /Salvar rascunho/);
  assert.match(app, /Limpar rascunho/);
  assert.match(app, /currentDraftPayload/);
  // localStorage tem prioridade sobre o rascunho do servidor -- é sempre o mais recente dos
  // dois (grava a cada mudança; o servidor só a cada 2,5s via debounce)
  assert.match(app, /const rascunhoLocalCarrinho = lerRascunhoCarrinhoLocal\(\);/);
  assert.match(app, /const draftParaRestaurar = rascunhoLocalCarrinho\?\.items\?\.length \? rascunhoLocalCarrinho : savedDraft;/);
  assert.match(app, /state\.cart = draftParaRestaurar\.items/);
  assert.match(app, /Você pode continuar este pedido depois/);
});

test("carrinho do PDV tem auto-save: localStorage a cada mudança + debounce pro servidor", () => {
  assert.match(app, /function lerRascunhoCarrinhoLocal\(\)/);
  assert.match(app, /localStorage\.getItem\("pedido-rascunho-carrinho"\)/);
  assert.match(app, /localStorage\.setItem\("pedido-rascunho-carrinho", JSON\.stringify\(currentDraftPayload\(\)\)\)/);
  // Debounce de 2,5s -- não manda uma requisição a cada tecla
  assert.match(app, /const autoSalvarCarrinhoNoServidor = debounce\(async \(\) => \{/);
  assert.match(app, /\}, 2500\);/);
  // renderCart roda depois de toda mudança no carrinho (adicionar, editar qtd, trocar unidade,
  // remover) -- ligar o auto-save ali cobre os 4 pontos de mutação sem duplicar em cada um
  const renderCartFn = app.slice(app.indexOf("const renderCart = () => {"), app.indexOf("renderAvailableProducts();\n  renderCart();"));
  assert.match(renderCartFn, /salvarRascunhoCarrinhoLocal\(\);/);
  assert.match(renderCartFn, /autoSalvarCarrinhoNoServidor\(\);/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const schema = fs.readFileSync("server/schema.sql", "utf8");
const routes = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const styles = fs.readFileSync("public/styles.css", "utf8");
const indexHtml = fs.readFileSync("public/index.html", "utf8");
const notifications = fs.readFileSync("public/js/ui/notifications.js", "utf8");
const almoxModal = app.slice(
  app.indexOf('id="add-almox-product-form"'),
  app.indexOf("function releaseHasOpenOrder")
);

test("schema and backend support almox-origin order items", () => {
  assert.match(schema, /item_origem TEXT DEFAULT 'PDV'/);
  assert.match(routes, /item_origem TEXT DEFAULT 'PDV'/);
  assert.match(routes, /\/api\/admin\/order-item/);
  assert.match(routes, /\/api\/admin\/orders\/add-item/);
  assert.match(routes, /\/api\/admin\/orders\/add-items/);
  assert.match(routes, /Remova produtos duplicados antes de adicionar ao pedido/);
  // item_origem continua na lista de colunas do INSERT (seguido do local de origem do pedido)
  assert.match(routes, /item_origem,\s*local_origem_pdv_id\)/);
  assert.match(routes, /'ALMOX'/);
  assert.match(routes, /COALESCE\(p\.item_origem, 'PDV'\) AS item_origem/);
});

test("admin can add product only while order is in progress", () => {
  assert.match(routes, /Produtos s\S podem ser adicionados quando o pedido est\S Em andamento/);
  assert.match(routes, /Este produto j\S existe no pedido/);
  assert.match(routes, /ativo IS NOT FALSE/);
  assert.match(routes, /não encontrado ou inativo/);
});

test("release screen exposes add product action and Almox badge", () => {
  assert.match(app, /\+ Produto/);
  assert.match(app, /add-almox-product/);
  assert.doesNotMatch(app, /add-almox-product-options/);
  assert.match(app, /almox-product-results/);
  assert.match(app, /almox-product-option/);
  assert.match(app, /Incluir na lista/);
  assert.match(app, /Adicionar produtos/);
  assert.match(app, /\/api\/admin\/orders\/add-items/);
  assert.match(app, /function adicionarProdutosAoPedido/);
  assert.match(app, /Idempotency-Key/);
  assert.match(app, /Não foi possível localizar a função de inclusão de produtos/);
  assert.match(app, /Rota não encontrada/);
  assert.match(app, /Não foi possível localizar o pedido ou produto informado/);
  assert.match(app, /Adicionando produtos/);
  assert.match(app, /Produtos adicionados com sucesso/);
  assert.doesNotMatch(almoxModal, /id="add-almox-product-search"[^>]*required/);
  assert.doesNotMatch(almoxModal, /name="quantidade"[^>]*required/);
  assert.match(app, /Selecione um produto da lista antes de incluir/);
  assert.match(app, /Adicionando/);
  assert.match(app, /order-source-badge/);
  assert.match(app, /Almox/);
  assert.match(styles, /almox-product-results/);
  assert.match(styles, /almox-product-selected-list/);
  assert.match(styles, /order-source-badge/);
});

test("toast is rendered globally above modals", () => {
  assert.match(indexHtml, /id="toast-root"/);
  assert.match(notifications, /document\.querySelector\("#toast-root"\)/);
  assert.match(notifications, /root\.appendChild\(el\)/);
  assert.match(styles, /z-index:\s*3000/);
  assert.match(styles, /pointer-events:\s*none/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");
const routes = fs.readFileSync("server/index.js", "utf8").split("\r\n").join("\n");

// Recorta o bloco da tela de categorias, do início da renderização até a próxima função de view
const painel = app.slice(app.indexOf("const renderCategories = async"), app.indexOf("cancelCategoryEdit.addEventListener"));

test("a tabela de produtos vinculados tem checkbox por linha e um bloco de ações em massa", () => {
  // Pedido do usuário: "preciso de uma função para selecionar os produtos e excluir
  // selecionados" -- antes só existia o × por linha, um de cada vez.
  assert.match(painel, /id="category-linked-select-all"/);
  assert.match(painel, /id="category-linked-selected-count"/);
  assert.match(painel, /id="delete-selected-category-products"/);
  assert.match(painel, /class="category-linked-check"/);
  // O botão nasce desabilitado -- só liga quando algo está marcado
  assert.match(painel, /id="delete-selected-category-products" type="button" disabled>/);
});

test("selecionar tudo marca só as linhas visíveis (respeita o filtro de busca ativo)", () => {
  const handler = painel.slice(painel.indexOf('"#category-linked-select-all"'));
  assert.match(handler, /\.category-product-row:not\(\.hidden\) \.category-linked-check/);
});

test("o contador e o botão de excluir em massa reagem à seleção, não a um estado fixo", () => {
  const fn = painel.slice(painel.indexOf("const updateLinkedSelectedCount"), painel.indexOf("document.querySelectorAll(\".category-linked-check\")"));
  assert.match(fn, /document\.querySelectorAll\(\"\.category-linked-check:checked\"\)\.length/);
  assert.match(fn, /deleteButton\.disabled = total === 0;/);
});

test("excluir selecionados pede confirmação e reusa a mesma rota da remoção individual, em lote", () => {
  const handler = painel.slice(painel.indexOf('"#delete-selected-category-products"'));
  assert.match(handler, /confirmSystem\(/, "exclusão em massa também precisa de confirmação, como a exclusão de categoria");
  assert.match(handler, /\/api\/admin\/category-products/);
  assert.match(handler, /action: "remove"/);
  // skus no plural: manda a lista inteira de uma vez, não um DELETE por item
  assert.match(handler, /const skus = \[\.\.\.document\.querySelectorAll\("\.category-linked-check:checked"\)\]\.map\(\(checkbox\) => checkbox\.value\);/);
});

test("a rota já aceitava lista de skus antes desta mudança -- a exclusão em massa não precisou de rota nova", () => {
  const rota = routes.slice(routes.indexOf('"/api/admin/category-products"'), routes.indexOf("// Painel gerencial"));
  assert.match(rota, /Array\.isArray\(body\.skus\)/);
});

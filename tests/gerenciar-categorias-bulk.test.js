import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");
const routes = fs.readFileSync("server/index.js", "utf8").split("\r\n").join("\n");
const styles = fs.readFileSync("public/styles.css", "utf8").split("\r\n").join("\n");

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

test("a lista de produtos vinculados é maior nesta tela, sem crescer a lista de produtos do pedido (mesma classe, tela diferente)", () => {
  // Pedido do usuário: 430px (herdado da tela de pedidos) só mostrava 5 linhas por vez numa
  // categoria com 40+ produtos. Escopado a .category-detail-screen de propósito -- a classe
  // .category-product-table também é usada pela lista de produtos disponíveis do pedido do
  // PDV (public/app.js:523, tela diferente), que não deve mudar de tamanho junto.
  assert.match(styles, /\.category-detail-screen \.category-product-table \{\s*\n\s*max-height: 700px;/);
  const generico = styles.slice(styles.indexOf(".category-product-table {"), styles.indexOf(".category-product-table {") + 200);
  assert.match(generico, /max-height: 430px;/, "a versão genérica (tela de pedidos) continua 430px");
  // A lista de "Adicionar produtos" (mesma tela) cresceu do mesmo jeito, por consistência
  assert.match(styles, /\.category-add-list \{[\s\S]{0,60}max-height: 700px;/);
});

test("Excluir categoria lê o nome antes do await de confirmação, não depois", () => {
  // Bug real reportado pelo usuário: "o botão excluir não está excluindo". currentTarget do
  // evento vira null assim que o dispatch do clique termina -- e confirmSystem só resolve
  // bem depois (espera clique num diálogo). Ler event.currentTarget.dataset.name só na
  // chamada final (depois do await) lançava TypeError silencioso e a requisição de exclusão
  // nunca saía. Verificado de ponta a ponta contra banco descartável: sem o fix a categoria
  // sobrevivia ao clique; com o fix, categoria e vínculos em produto_categorias são apagados.
  const handler = painel.slice(painel.indexOf('".delete-category-btn"'), painel.indexOf('".delete-category-btn"') + 900);
  assert.match(handler, /const categoryName = event\.currentTarget\.dataset\.name;/);
  const posCategoryName = handler.indexOf("const categoryName");
  const posAwaitConfirm = handler.indexOf("await confirmSystem");
  assert.ok(posCategoryName > -1 && posCategoryName < posAwaitConfirm, "categoryName precisa ser lido antes do await confirmSystem");
  // Depois da captura, nenhuma outra leitura de event.currentTarget sobra no handler -- tudo
  // usa a variável já guardada, então um novo await no meio não reintroduz o mesmo bug
  const semComentarios = handler.replace(/^\s*\/\/.*$/gm, "");
  const linhaCaptura = "const categoryName = event.currentTarget.dataset.name;";
  const aposCaptura = semComentarios.slice(semComentarios.indexOf(linhaCaptura) + linhaCaptura.length);
  assert.doesNotMatch(aposCaptura, /event\.currentTarget/);
});

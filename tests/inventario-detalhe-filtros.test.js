import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../server/modules/inventarios/inventarios.routes.js", import.meta.url), "utf8");

test("detalhe do inventário devolve categorias por item sem multiplicar linhas", () => {
  const rota = routes.slice(routes.indexOf("const itensBase = await query(SQL_ITENS_DETALHE"), routes.indexOf("const historico = await query"));
  // Segunda consulta simples + junção em JS, na mesma fonte do catálogo do PDV
  assert.match(rota, /FROM produto_categorias WHERE sku_produto = ANY\(\$1\)/);
  assert.match(rota, /categorias: \[\.\.\.\(categoriasPorSku\.get\(item\.sku_produto\) \|\| \[\]\)\]\.sort\(\)/);
  assert.match(rota, /itensBase\.map\(\(item\) => \(\{/, "uma linha por item, com categorias como array");
  // SQL_ITENS_DETALHE continua sem join de categorias (não multiplica linha)
  const sql = routes.slice(routes.indexOf("const SQL_ITENS_DETALHE"), routes.indexOf("// Há quantos dias"));
  assert.doesNotMatch(sql, /produto_categorias|string_agg/);
});

test("o painel de conferência renderiza os três controles de filtro (ids detalhe-*)", () => {
  const detalhe = app.slice(app.indexOf("function renderDetalheInventario"), app.indexOf("function bindDetalheInventario"));
  assert.match(detalhe, /class="inventario-filtros"/);
  assert.match(detalhe, /id="detalhe-busca"/);
  assert.match(detalhe, /id="detalhe-categoria"/);
  assert.match(detalhe, /id="detalhe-pendentes"/);
  // Vale para todos os estados: o bloco não depende de "editavel"
  const bloco = detalhe.slice(detalhe.indexOf('class="inventario-filtros"') - 60, detalhe.indexOf('class="table-wrap inventario-tabela"'));
  assert.doesNotMatch(bloco, /editavel/);
});

test("as linhas têm data-busca e data-categorias", () => {
  const detalhe = app.slice(app.indexOf("function renderDetalheInventario"), app.indexOf("function bindDetalheInventario"));
  assert.match(detalhe, /data-busca="\$\{esc\(`\$\{item\.sku_produto\} \$\{item\.produto \|\| ""\}`\.toLowerCase\(\)\)\}"/);
  assert.match(detalhe, /data-categorias="\$\{esc\(\(item\.categorias \|\| \[\]\)\.map\(\(c\) => c\.toLowerCase\(\)\)\.join\("\|"\)\)\}"/);
});

test("o filtro só esconde a linha e o salvamento lê todas, visíveis ou não", () => {
  const bind = app.slice(app.indexOf("function bindDetalheInventario"), app.indexOf("async function salvarCorrecoesInventario"));
  assert.match(bind, /card\.querySelector\("#detalhe-busca"\)/, "escopado ao overlay, não ao document");
  assert.doesNotMatch(bind.slice(bind.indexOf("const aplicarFiltrosDetalhe"), bind.indexOf("const aplicarFiltrosDetalhe") + 900), /\.remove\(\)/);
  assert.match(bind, /tr\.classList\.toggle\("hidden"/);
  const salvar = app.slice(app.indexOf("async function salvarCorrecoesInventario"), app.indexOf("async function salvarCorrecoesInventario") + 500);
  assert.match(salvar, /document\.querySelectorAll\("\.inventario-item-linha"\)/);
  assert.doesNotMatch(salvar, /hidden|:not\(|offsetParent/);
});

test("CSS: checkbox de 'Só os não contados' não herda o tamanho global de input", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /html \.inventario-so-pendentes input\[type="checkbox"\] \{[^}]*width: 1\.15rem;[^}]*min-height: 0;/);
  assert.match(css, /grid-template-columns: minmax\(10rem, 1fr\) minmax\(9rem, 14rem\) auto;/);
  assert.match(css, /\.order-panel-foot \.order-card-actions \{\s*max-width: 100%;/);
});

test("CSS: a lista do painel de inventário mostra ao menos 10 produtos (altura mínima) e o corpo rola", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.order-panel-content > \.table-wrap\.inventario-tabela \{[^}]*min-height: 48rem;/);
  assert.match(css, /\.inventario-detail-overlay \.order-panel-content \{\s*overflow-y: auto;/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*min-height: 58rem;/);
});

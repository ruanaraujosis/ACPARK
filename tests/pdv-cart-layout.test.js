import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync("public/styles.css", "utf8");
const html = fs.readFileSync("public/index.html", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

test("o padding dos campos vence o preflight do Tailwind", () => {
  // O Tailwind entra por <script> e injeta o preflight em tempo de execução, DEPOIS do
  // styles.css. O preflight zera `padding` de campos de formulário com especificidade (0,0,1),
  // então uma regra `input, select, textarea` empata e perde — o texto encosta na borda e o
  // primeiro caractere fica cortado. O prefixo `html` sobe para (0,0,2) e resolve.
  assert.match(html, /<script src="\/vendor\/tailwind\.js/, "o Tailwind continua vindo por <script>");
  assert.match(css, /html input,\s*\n\s*html select,\s*\n\s*html textarea \{[^}]*padding:/,
    "a regra de padding precisa do prefixo html para vencer o preflight injetado");
});

test("checkbox e radio são isentados por regra própria, não por :not() no seletor base", () => {
  // Armadilha real: `:not([type="checkbox"])` soma a especificidade do atributo, levando a
  // regra base para (0,2,2) — o que passa por cima de `td input`, que deixa os campos dentro
  // de tabelas mais compactos, e engorda todas as linhas de tabela do sistema.
  assert.doesNotMatch(css, /html input:not\(\[type="checkbox"\]\)/,
    "não use :not([type=...]) no seletor base: a especificidade extra quebra o `td input`");
  assert.match(css, /html input\[type="checkbox"\],\s*\n\s*html input\[type="radio"\] \{\s*\n\s*padding: 0;/,
    "checkbox e radio precisam de uma regra separada zerando o padding");
});

test("os campos dentro de tabelas continuam mais compactos que os de formulário", () => {
  // Se esta regra parar de valer, todas as tabelas com campo editável ganham altura extra.
  assert.match(css, /td input,\s*\n\s*td select,\s*\n\s*td textarea \{[^}]*padding-block:/);
});

test("o carrinho do PDV define as cinco colunas", () => {
  // As regras eram do carrinho antigo de 3 colunas (Produto/Qtd/Ação). Quando "Unidade" e
  // "Total" entraram, a coluna 3 continuou com 58px — largura de botão de ícone — e passou a
  // espremer o seletor de unidade a ponto de mostrar só uma letra.
  for (const n of [2, 3, 4, 5]) {
    assert.match(
      css,
      new RegExp(`\\.order-cart-list th:nth-child\\(${n}\\),\\s*\\n\\s*\\.order-cart-list td:nth-child\\(${n}\\)`),
      `a coluna ${n} do carrinho precisa de regra própria`
    );
  }
  assert.doesNotMatch(css, /\.order-cart-list th:nth-child\(3\),\s*\n\s*\.order-cart-list td:nth-child\(3\) \{\s*\n\s*width: 58px/,
    "a coluna 3 não pode voltar à largura de ícone do layout antigo");
});

test("o texto do total não quebra e a tabela rola no contêiner em tela estreita", () => {
  const blocoTotal = css.match(/\.order-cart-list th:nth-child\(4\),[\s\S]{0,220}?\}/)?.[0] || "";
  assert.match(blocoTotal, /white-space: nowrap/, "o total não pode quebrar no meio");

  // Sem min-width a tabela se espremeria em vez de rolar; o #cart é quem tem overflow-x
  assert.match(css, /\.order-cart-list table \{[\s\S]{0,400}?min-width: \d+px/);
  assert.match(css, /\.order-cart-list #cart \{[\s\S]{0,200}?overflow-x: auto/);
});

test("o carrinho é renderizado com os cinco cabeçalhos na ordem esperada", () => {
  assert.match(app, /table\(\["Produto", "Qtd", "Unidade", "Total", "Ação"\]/);
});

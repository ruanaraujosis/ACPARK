import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync("public/styles.css", "utf8").split("\r\n").join("\n");
const html = fs.readFileSync("public/index.html", "utf8").split("\r\n").join("\n");
const app = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");

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
  // As larguras agora moram numa classe compartilhada (.pedido-pdv-table), usada pela tela
  // "Novo pedido" E pela Edição do pedido pendente — as duas montam a mesma tabela.
  for (const n of [2, 3, 4, 5]) {
    assert.match(
      css,
      new RegExp(`\\.pedido-pdv-table th:nth-child\\(${n}\\),\\s*\\n\\s*\\.pedido-pdv-table td:nth-child\\(${n}\\)`),
      `a coluna ${n} precisa de regra própria`
    );
  }
  assert.doesNotMatch(css, /th:nth-child\(3\),[\s\S]{0,80}?width: 58px/,
    "a coluna 3 não pode voltar à largura de ícone do layout antigo");
});

test("o texto do total não quebra e a tabela rola no contêiner em tela estreita", () => {
  const blocoTotal = css.match(/\.pedido-pdv-table th:nth-child\(4\),[\s\S]{0,320}?\}/)?.[0] || "";
  assert.match(blocoTotal, /white-space: nowrap/, "o total não pode quebrar no meio");

  // Sem min-width a tabela se espremeria em vez de rolar
  assert.match(css, /\.pedido-pdv-table table \{[\s\S]{0,400}?min-width: \d+px/);
  // No carrinho quem rola é o #cart; na edição, o .table-wrap padrão
  assert.match(css, /\.order-cart-list #cart \{[\s\S]{0,200}?overflow-x: auto/);
  assert.match(css, /\.table-wrap \{[\s\S]{0,200}?overflow-x: auto/);
});

test("as duas telas usam a mesma renderização de linha, sem markup duplicado", () => {
  // O motivo desta tarefa: enquanto cada tela montava o próprio markup, elas divergiram.
  assert.match(app, /const COLUNAS_PEDIDO_PDV = \["Produto", "Qtd", "Unidade", "Total", "Ação"\]/);
  assert.match(app, /function linhaProdutoPedidoPdv\(item, opcoes = \{\}\)/);
  // As duas telas chamam a função compartilhada e a mesma lista de colunas
  const chamadas = [...app.matchAll(/linhaProdutoPedidoPdv\(/g)].length;
  assert.ok(chamadas >= 4, `esperava a função definida e usada pelas duas telas, achei ${chamadas} ocorrências`);
  const cabecalhos = [...app.matchAll(/table\(COLUNAS_PEDIDO_PDV/g)].length;
  assert.equal(cabecalhos, 2, "as duas tabelas precisam usar a mesma lista de colunas");
  // E as duas recebem a classe que carrega as larguras compartilhadas
  const comClasse = [...app.matchAll(/table-wrap pedido-pdv-table/g)].length;
  assert.equal(comClasse, 2, "as duas tabelas precisam da classe de larguras compartilhada");
});

test("o total e o seletor de unidade saem de um ponto único", () => {
  assert.match(app, /function totalDoItemPedidoPdv\(/);
  assert.match(app, /function celulaUnidadePedidoPdv\(/);
  // Produto sem fator mostra "Unidade" como texto, sem seletor
  const celula = app.slice(app.indexOf("function celulaUnidadePedidoPdv"), app.indexOf("\n}\n", app.indexOf("function celulaUnidadePedidoPdv")));
  assert.match(celula, /if \(!temEmbalagem\) return `<span class="conversao-info">Unidade<\/span>`/);
});

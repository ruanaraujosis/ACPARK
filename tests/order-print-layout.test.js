import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const appSource = fs.readFileSync("public/app.js", "utf8");
const stylesSource = fs.readFileSync("public/styles.css", "utf8");

test("manual order print uses dedicated receipt layout instead of screen card", () => {
  assert.match(appSource, /async function printOrder/);
  assert.match(appSource, /order-request-print-target/);
  assert.match(appSource, /ACPark Pedidos/);
  assert.match(appSource, /Produto/);
  assert.match(appSource, /QTD/);
  assert.match(appSource, /receipt-item-dash/);
  assert.doesNotMatch(appSource, /card\.classList\.add\("is-manual-print-target"\)/);
});

test("order print css keeps receipt clean and left aligned", () => {
  assert.match(stylesSource, /order-request-print-target/);
  assert.match(stylesSource, /text-align: left/);
  assert.match(stylesSource, /grid-template-columns: minmax\(0, 1fr\) 13mm/);
});

test("order receipt prints as 80mm cupom, not full A4 sheet", () => {
  // Sem um @page dedicado, o recibo herdava o @page A4 global (definido para o histórico)
  // e imprimia como folha cheia mesmo com o conteúdo já estilizado como cupom estreito
  const printOrderBlock = appSource.slice(appSource.indexOf("async function printOrder"), appSource.indexOf("// Extrai os itens de retirada a partir do card do pedido"));
  assert.match(printOrderBlock, /id = "receipt-80mm-print-style"/);
  assert.match(printOrderBlock, /size: 80mm auto;/);
  assert.match(printOrderBlock, /margin: 0;/);
  assert.match(printOrderBlock, /document\.head\.appendChild\(printStyle\)/);
  // O estilo temporário precisa ser removido depois de imprimir, como o comprovante de retirada já faz
  assert.match(printOrderBlock, /printStyle\.remove\(\)/);
});

test("cupom de pedido não sobra em folha em branco (irmãos escondidos com display: none)", () => {
  // "visibility: hidden" (regra global) não tira o app do fluxo do documento: o corpo
  // inteiro continuava ocupando espaço de layout mesmo invisível, inflando a altura da
  // página "80mm auto" e imprimindo uma segunda folha em branco após o cupom encolhido
  assert.match(stylesSource, /body\.printing-receipt:not\(\.printing-withdrawal-receipt\) > \*:not\(\.receipt-print-target\) \{\s*\n\s*display: none !important;/);
});

test("history print keeps A4 sheet format (@page global, sem override para 80mm)", () => {
  assert.match(stylesSource, /@page \{\s*\n\s*size: A4 portrait;\s*\n\s*margin: 12mm;/);
  assert.match(stylesSource, /body\.printing-history \.print-history-area \{[\s\S]*?width: 186mm/);
  // A área impressa do histórico não pode herdar a formatação estreita do cupom de pedido
  assert.doesNotMatch(stylesSource, /body\.printing-history[\s\S]{0,40}80mm/);
});

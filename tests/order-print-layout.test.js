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

test("cupom imprime solicitado quando Pendente e liberado em Em Andamento/Aguardando Retirada/Finalizado", () => {
  const printOrderBlock = appSource.slice(appSource.indexOf("async function printOrder"), appSource.indexOf("// Extrai os itens de retirada a partir do card do pedido"));
  // Pendente ainda não teve nada decidido pelo almoxarifado: só o solicitado existe
  assert.match(printOrderBlock, /const printReleasedQty = orderStatus === "Em Andamento" \|\| orderStatus === "Aguardando Retirada" \|\| orderStatus === "Finalizado";/);
  // Em Andamento: o campo "Liberar" ao vivo (ainda não salvo) tem prioridade sobre o valor do servidor
  assert.match(printOrderBlock, /row\.querySelector\("\.liberada"\)\?\.value,\s*\n\s*row\.dataset\.released,\s*\n\s*cells\[cells\.length - 1\]\?\.textContent\?\.trim\(\)/);
  assert.match(printOrderBlock, /printReleasedQty \? releasedQty : requestedQty/);
});

test("cupom imprime em embalagem, não em unidade, quando o produto tem fator confiável", () => {
  // Pedido do usuário (01/09/2026): o depósito separa caixa/fardo fechado, não unidade a
  // unidade -- mostrar "24" quando na verdade são "2 Fardos" obrigava a converter de cabeça.
  const printOrderBlock = appSource.slice(appSource.indexOf("async function printOrder"), appSource.indexOf("// Extrai os itens de retirada a partir do card do pedido"));
  assert.match(printOrderBlock, /const fator = Number\(row\.dataset\.fator\);/);
  assert.match(printOrderBlock, /const fatorValido = row\.dataset\.fator && Number\.isSafeInteger\(fator\) && fator > 1;/);
  assert.match(printOrderBlock, /formatarQuantidadeImpressaoPedido\(quantidadeBruta, fator, row\.dataset\.embalagem\)/);
  // Sem fator confiável, continua exatamente como antes -- sem essa condição, item sem
  // embalagem cadastrada (fator inválido/ausente) quebraria ou mostraria "NaN Fardo"
  assert.match(printOrderBlock, /const requested = fatorValido\s*\n\s*\? formatarQuantidadeImpressaoPedido/);
});

test("a conversão usa a quantidade já escolhida pelo status (solicitada ou liberada), nunca recalcula outra", () => {
  // Se a conversão lesse requestedQty/releasedQty direto, em vez do valor já escolhido pela
  // regra de status, um pedido Em Andamento imprimiria embalagem da quantidade errada.
  const printOrderBlock = appSource.slice(appSource.indexOf("async function printOrder"), appSource.indexOf("// Extrai os itens de retirada a partir do card do pedido"));
  assert.match(printOrderBlock, /const quantidadeBruta = printReleasedQty \? releasedQty : requestedQty;/);
  const posQuantidadeBruta = printOrderBlock.indexOf("const quantidadeBruta");
  const posFormatar = printOrderBlock.indexOf("formatarQuantidadeImpressaoPedido(quantidadeBruta");
  assert.ok(posQuantidadeBruta > -1 && posFormatar > posQuantidadeBruta, "quantidadeBruta precisa existir antes de ser convertida");
});

test("formatarQuantidadeImpressaoPedido divide pelo fator e nomeia a embalagem do produto, não uma sigla genérica", () => {
  const fnSrc = appSource.slice(appSource.indexOf("function formatarQuantidadeImpressaoPedido"), appSource.indexOf("// Dispara a impressão de um pedido"));
  assert.match(fnSrc, /const valor = \(Number\(unidades\) \|\| 0\) \/ fator;/);
  // Item incompleto (sem embalagem cadastrada) cai num rótulo genérico, nunca "undefined"
  assert.match(fnSrc, /const rotulo = embalagem \|\| "EMB";/);
  // Fração real (pedido não múltiplo exato da embalagem) tem que aparecer, não ser escondida
  assert.match(fnSrc, /valor\.toFixed\(2\)\.replace\("\.", ","\)/);
});

test("as três tabelas que alimentam o cupom (painel, kanban editável e kanban travado) marcam o fator na própria linha", () => {
  // O cupom lê row.dataset.fator direto da <tr> -- se uma das três fontes não gravar isso,
  // pedidos vindos daquele status/tela voltam a imprimir em unidade sem ninguém perceber.
  const painel = appSource.slice(appSource.indexOf("function releasePanelItemsTable"), appSource.indexOf("function releasePanelItemsTable") + 3000);
  assert.match(painel, /\$\{fatorValido \? `data-fator="\$\{fator\}" data-embalagem="\$\{esc\(item\.embalagem \|\| ""\)\}"` : ""\}/);

  const kanbanEditavel = appSource.slice(appSource.indexOf('data-released="${esc(releasedQty)}"'), appSource.indexOf('data-released="${esc(releasedQty)}"') + 200);
  assert.match(kanbanEditavel, /\$\{fatorKanbanValido \? `data-fator="\$\{fatorKanban\}" data-embalagem="\$\{esc\(o\.embalagem \|\| ""\)\}"` : ""\}/);

  const kanbanTravado = appSource.slice(appSource.indexOf("fatorNaoEditavel = Number"), appSource.indexOf("fatorNaoEditavel = Number") + 600);
  assert.match(kanbanTravado, /fatorNaoEditavelValido = o\.fator_status !== "INVALIDO" && Number\.isSafeInteger\(fatorNaoEditavel\) && fatorNaoEditavel > 1;/);
  assert.match(kanbanTravado, /\$\{fatorNaoEditavelValido \? `data-fator="\$\{fatorNaoEditavel\}" data-embalagem="\$\{esc\(o\.embalagem \|\| ""\)\}"` : ""\}/);
});

test("history print keeps A4 sheet format (@page global, sem override para 80mm)", () => {
  assert.match(stylesSource, /@page \{\s*\n\s*size: A4 portrait;\s*\n\s*margin: 12mm;/);
  assert.match(stylesSource, /body\.printing-history \.print-history-area \{[\s\S]*?width: 186mm/);
  // A área impressa do histórico não pode herdar a formatação estreita do cupom de pedido
  assert.doesNotMatch(stylesSource, /body\.printing-history[\s\S]{0,40}80mm/);
});

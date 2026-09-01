import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const rotas = fs.readFileSync("server/modules/inventarios/inventarios.routes.js", "utf8").split("\r\n").join("\n");
const appJs = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");
const indexHtml = fs.readFileSync("public/index.html", "utf8").split("\r\n").join("\n");

// Recorta só o corpo da rota do relatório, do início do handler até o próximo comentário de rota.
const rota = rotas.slice(
  rotas.indexOf('if (url.pathname === "/api/admin/inventario/relatorio"'),
  rotas.indexOf("// Detalhe de um inventário")
);

test("o relatório de estoque exige admin, nunca PDV", () => {
  // Um PDV vendo o estoque de todos os outros PDVs vazaria dado de concorrente interno.
  assert.match(rota, /requireUser\(req, res, "admin"\)/);
});

test("a data de corte é validada, nunca aceita solta ou em outro formato", () => {
  // Sem isso, uma data mal formada viraria "corte" inválido silencioso na consulta em vez de erro claro.
  assert.match(rota, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(corte\)/);
  assert.match(rota, /send\(res, 400, \{ error: "Informe uma data de corte válida/);
});

test("PDV administrativo não vira coluna do relatório", () => {
  // Etapa 2: administrativo não tem saldo de revenda, então não faz sentido ter coluna de estoque.
  assert.match(rota, /FROM pdvs WHERE administrativo = FALSE/);
});

test("o vencedor de cada local usa ajuste_aplicado_em, nunca confirmado_em", () => {
  // confirmado_em marca só a revisão do Almoxarifado num inventário de PDV, antes da assinatura;
  // ajuste_aplicado_em é o momento em que o ajuste realmente entrou no saldo -- para os dois fluxos.
  assert.match(rota, /WHERE status = \$1 AND ajuste_aplicado_em < \(\$2::date \+ INTERVAL '1 day'\)/);
  assert.doesNotMatch(rota, /WHERE\s+confirmado_em/, "confirmado_em não pode decidir o vencedor");
});

test("só inventário Confirmado entra na disputa pelo vencedor", () => {
  assert.match(rota, /STATUS_INVENTARIO\.CONFIRMADO, corte/);
});

test("o vencedor por local é o mais recente dentro do corte, e o Almoxarifado usa o mesmo mecanismo", () => {
  // DISTINCT ON (pdv_id) trata NULL (Almoxarifado) como um grupo igual a qualquer pdv_id --
  // não existe consulta separada para o Almoxarifado, o que evitaria os dois caminhos divergirem.
  assert.match(rota, /DISTINCT ON \(pdv_id\)/);
  assert.match(rota, /ORDER BY pdv_id, ajuste_aplicado_em DESC/);
});

test("produto sem ninguém ter contado no ciclo vencedor não aparece no relatório", () => {
  // Catálogo inteiro sem nenhuma contagem viraria relatório enorme e inútil. skusContados só
  // recebe SKU de quem foi de fato contado (quantidade_contada IS NOT NULL) no próprio vencedor.
  assert.match(rota, /if \(!skusContados\.has\(produto\.sku\)\) continue;/);
  assert.match(rota, /WHERE inventario_id = ANY\(\$1\) AND quantidade_contada IS NOT NULL/);
});

test("a rota não preserva mais o saldo atual -- não contado por um local vira branco, não um número herdado", () => {
  // Mudança de critério: antes, quem não contava herdava estoque_pdv.quantidade (regra certa
  // para o AJUSTE, errada para ESTA leitura -- misturava "contado como zero" com "não contado").
  // Essa fonte de dado nem é mais buscada nesta rota.
  assert.doesNotMatch(rota, /saldoPdvPorChave/, "o fallback de saldo preservado foi removido");
  assert.doesNotMatch(rota, /FROM estoque_pdv/, "a rota não lê mais estoque_pdv para preencher célula");
});

test("por coluna: só mostra valor se AQUELE local contou o produto no próprio ciclo, senão fica null", () => {
  const trecho = rota.slice(rota.indexOf("const linhas = []"), rota.indexOf("send(res, 200"));
  assert.match(trecho, /porPdv\[pdv\.id\] = contado !== undefined \? contado : null;/);
  assert.match(trecho, /const almoxarifado = contadoAlmox !== undefined \? contadoAlmox : null;/);
});

test("o Total soma só o que foi contado -- célula em branco nunca entra como zero", () => {
  const trecho = rota.slice(rota.indexOf("const linhas = []"), rota.indexOf("send(res, 200"));
  assert.match(trecho, /if \(contado !== undefined\) total \+= contado;/);
  assert.match(trecho, /if \(contadoAlmox !== undefined\) total \+= contadoAlmox;/);
});

test("produtos vêm ordenados por categoria antes do nome, senão o agrupamento visual quebra", () => {
  // Bug já visto nesta implementação: ORDER BY nome sozinho intercala categorias na saída.
  assert.match(rota, /ORDER BY categoria, nome/);
});

test("o relatório é só leitura -- nenhuma escrita em estoque_pdv, produtos ou inventarios", () => {
  assert.doesNotMatch(rota, /INSERT INTO|UPDATE estoque_pdv|UPDATE produtos|UPDATE inventarios/);
});

test("a rota nunca calcula nem busca preço -- a coluna existe só na exibição, sempre vazia", () => {
  // Preço unitário/total é exigência visual do modelo de referência, nunca dado real.
  assert.doesNotMatch(rota, /preco|preço/i);
});

test("impressão e exportação usam exatamente a mesma resposta da API, sem recomputar o corte", () => {
  // Os dois formatos têm que bater no mesmo corte de dados -- por construção, se os dois
  // consumirem o mesmo objeto `dados` sem escolher um corte novo, eles nunca podem divergir.
  const bind = appJs.slice(appJs.indexOf("function bindRelatorioDeEstoque"), appJs.indexOf("// Há quanto tempo a contagem foi feita"));
  assert.match(bind, /const dados = await buscarDadosRelatorioDeEstoque\(\);\s*\n\s*if \(dados\) printInventoryReport\(dados\)/);
  assert.match(bind, /const dados = await buscarDadosRelatorioDeEstoque\(\);\s*\n\s*if \(!dados\) return;\s*\n\s*try \{\s*\n\s*await exportInventoryReport\(dados\);/);
});

test("impressão e exportação calculam o mesmo cabeçalho (corte/emissão/usuário) por uma única função", () => {
  // inventoryReportMeta é chamada pelas duas -- não existem dois cálculos de "gerado quando/por
  // quem" que possam divergir.
  const printFn = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(printFn, /inventoryReportMeta\(dados\)/);
  assert.match(exportFn, /inventoryReportMeta\(dados\)/);
});

test("a impressão A4 repete o cabeçalho de coluna em toda página", () => {
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(html, /@page \{ size: A4 portrait/);
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.match(html, /tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
});

test("na impressão, célula não contada vira travessão -- nunca \"0\", que é uma contagem real", () => {
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(html, /valor === null \|\| valor === undefined/);
  assert.match(html, /relatorio-nao-contado.*—/);
  // Total nunca some por trás de "|| 0": já é garantido número pela rota (soma só o contado)
  assert.match(html, /<td class="num relatorio-total">\$\{Number\(linha\.total\)\}<\/td>/);
});

test("as colunas de preço na impressão e na exportação ficam sempre em branco", () => {
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(html, /<td class="num relatorio-total">\$\{Number\(linha\.total\)\}<\/td>\s*\n\s*<td><\/td>\s*\n\s*<td><\/td>/);

  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /linha\.almoxarifado, linha\.total, null, null/);
});

test("a exportação usa ExcelJS, não o SheetJS gratuito -- só ele grava negrito/cor de fundo de verdade", () => {
  // Comprovado empiricamente nesta implementação: SheetJS (window.XLSX, edição gratuita) ignora
  // cell.s ao escrever; ExcelJS grava fonte e preenchimento reais no styles.xml do .xlsx.
  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /new window\.ExcelJS\.Workbook\(\)/);
  assert.match(exportFn, /await workbook\.xlsx\.writeBuffer\(\)/);
  assert.doesNotMatch(exportFn, /downloadWorkbook\(/, "não deve mais passar pelo SheetJS");
});

test("sem ExcelJS carregado, a exportação cai pro .csv em vez de quebrar", () => {
  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /if \(!window\.ExcelJS\) \{/);
  assert.match(exportFn, /downloadCsv\(`relatorio_estoque_\$\{corte\}\.csv`/);
});

test("a exportação destaca a linha de categoria com a mesma cor teal já usada na impressão", () => {
  assert.match(appJs, /RELATORIO_COR_TEAL = "FF005F68"/, "mesma cor de #005f68 usada em .relatorio-categoria na impressão");
  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /celulaCategoria\.fill = \{ type: "pattern", pattern: "solid", fgColor: \{ argb: RELATORIO_COR_TEAL \} \};/);
  assert.match(exportFn, /celulaCategoria\.font = \{ bold: true, color: \{ argb: RELATORIO_COR_BRANCO \} \};/);
});

test("a exportação repete o cabeçalho do relatório (sistema, usuário, corte, emissão) igual à impressão", () => {
  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /ÁGUAS CORRENTES PARK — Relatório de estoque consolidado/);
  assert.match(exportFn, /Corte: \$\{moneyDate/);
  assert.match(exportFn, /Emissão: \$\{generatedAt\}/);
  assert.match(exportFn, /Usuário: \$\{generatedBy\}/);
});

test("a unidade de medida no relatório é sempre UN -- não existe fator nem embalagem aqui", () => {
  // Mesma regra do resto do sistema: contagem é sempre em unidade.
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(html, /<td class="num">UN<\/td>/);
  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /"UN",/);
});

test("ExcelJS está vendorizado localmente, não vindo de CDN", () => {
  // Mesmo padrão já usado para tailwind.js e xlsx.full.min.js -- CLAUDE.md exige libs locais.
  assert.ok(fs.existsSync("public/vendor/exceljs.min.js"), "public/vendor/exceljs.min.js precisa existir");
  assert.match(indexHtml, /<script src="\/vendor\/exceljs\.min\.js\?v=[^"]+"><\/script>/);
  assert.doesNotMatch(indexHtml, /cdn\.jsdelivr|unpkg\.com/, "sem CDN no HTML servido");
});

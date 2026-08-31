import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const rotas = fs.readFileSync("server/modules/inventarios/inventarios.routes.js", "utf8").split("\r\n").join("\n");
const appJs = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");

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

test("produto sem ninguém ter contado não aparece no relatório", () => {
  // Catálogo inteiro sem nenhuma contagem viraria relatório enorme e inútil.
  assert.match(rota, /if \(!skusContados\.has\(produto\.sku\)\) continue;/);
});

test("local que não contou o produto preserva o saldo atual, nunca zera", () => {
  // Mesma regra já usada no ajuste de inventário: ausência de contagem mantém o valor.
  assert.match(rota, /const valor = contado !== undefined \? contado : \(saldoPdvPorChave\.get/);
  assert.match(rota, /const almoxarifado = contadoAlmox !== undefined \? contadoAlmox : Number\(produto\.qtd_total \|\| 0\)/);
});

test("o Total soma todos os PDVs mais o Almoxarifado, nunca um subconjunto", () => {
  const trecho = rota.slice(rota.indexOf("let total = 0"), rota.indexOf("linhas.push"));
  assert.match(trecho, /total \+= valor;/);
  assert.match(trecho, /total \+= almoxarifado;/);
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
  assert.match(bind, /const dados = await buscarDadosRelatorioDeEstoque\(\);\s*\n\s*if \(dados\) exportInventoryReport\(dados\)/);
});

test("a impressão A4 repete o cabeçalho de coluna em toda página", () => {
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(html, /@page \{ size: A4 portrait/);
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.match(html, /tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
});

test("as colunas de preço na impressão e na exportação ficam sempre em branco", () => {
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  // As duas últimas células da linha (Preço Unit./Preço Total) não recebem valor nenhum
  assert.match(html, /<td class="num relatorio-total">\$\{Number\(linha\.total \|\| 0\)\}<\/td>\s*\n\s*<td><\/td>\s*\n\s*<td><\/td>/);

  const exportFn = appJs.slice(appJs.indexOf("function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /Number\(linha\.total \|\| 0\),\s*\n\s*"",\s*\n\s*""/);
});

test("a exportação gera .xlsx de verdade, reaproveitando downloadWorkbook -- não um CSV disfarçado", () => {
  const exportFn = appJs.slice(appJs.indexOf("function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /downloadWorkbook\(`relatorio_estoque_\$\{corte\}\.xlsx`/);
});

test("a unidade de medida no relatório é sempre UN -- não existe fator nem embalagem aqui", () => {
  // Mesma regra do resto do sistema: contagem é sempre em unidade.
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(html, /<td class="num">UN<\/td>/);
  const exportFn = appJs.slice(appJs.indexOf("function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /"UN",/);
});

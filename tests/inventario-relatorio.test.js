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
// Rota de opções de filtro (categorias/locais), separada da rota do relatório em si
const rotaFiltros = rotas.slice(
  rotas.indexOf('if (url.pathname === "/api/admin/inventario/relatorio/filtros"'),
  rotas.indexOf('if (url.pathname === "/api/admin/inventario/relatorio"')
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

test("produto sem ninguém ter contado no ciclo vencedor não aparece no relatório (a menos que ?todos=1)", () => {
  // Catálogo inteiro sem nenhuma contagem viraria relatório enorme e inútil. skusContados só
  // recebe SKU de quem foi de fato contado (quantidade_contada IS NOT NULL) no próprio vencedor.
  // mostraTodos (?todos=1) pula esse filtro de propósito -- read-only, não afeta a regra do ajuste.
  assert.match(rota, /if \(!mostraTodos && !skusContados\.has\(produto\.sku\)\) continue;/);
  assert.match(rota, /const mostraTodos = url\.searchParams\.get\("todos"\) === "1";/);
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
  assert.match(rota, /ORDER BY cp\.categoria_exibicao, p\.nome/);
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
  const modal = appJs.slice(appJs.indexOf("async function openRelatorioEstoqueModal"), appJs.indexOf("// Busca os dados do relatório"));
  assert.match(modal, /const dados = await buscarDadosRelatorioDeEstoque\(filtro\);\s*\n\s*if \(dados\) printInventoryReport\(dados\)/);
  assert.match(modal, /const dados = await buscarDadosRelatorioDeEstoque\(filtro\);\s*\n\s*if \(!dados\) return;\s*\n\s*try \{\s*\n\s*await exportInventoryReport\(dados\);/);
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
  assert.match(html, /<td class="num relatorio-total">\$\{Number\(linha\.total\)\}<\/td>\s*\n\s*<td class="num">\$\{Number\(linha\.totalFardos\)\.toFixed\(2\)\.replace\("\.", ","\)\}<\/td>\s*\n\s*<td><\/td>\s*\n\s*<td><\/td>/);

  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /linha\.total, linha\.totalFardos, null, null/);
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

test("a unidade de medida no relatório vem do cadastro OMIE (product_integration_mappings.unit), com UN de fallback", () => {
  // A coluna deixou de ser fixa: cada linha traz sua própria unidade, calculada no backend
  // a partir de obterFatoresEmLote (mesma consulta já usada para o fator/Total Fardos).
  const html = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(html, /<td class="centro">\$\{esc\(linha\.unidade \|\| "UN"\)\}<\/td>/);
  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /linha\.unidade \|\| "UN"/);

  const rota = fs.readFileSync("server/modules/inventarios/inventarios.routes.js", "utf8").split("\r\n").join("\n");
  assert.match(rota, /linha\.unidade = fatoresPorSku\.get\(linha\.sku\)\?\.unit \|\| "UN"/);
});

test("ExcelJS está vendorizado localmente, não vindo de CDN", () => {
  // Mesmo padrão já usado para tailwind.js e xlsx.full.min.js -- CLAUDE.md exige libs locais.
  assert.ok(fs.existsSync("public/vendor/exceljs.min.js"), "public/vendor/exceljs.min.js precisa existir");
  assert.match(indexHtml, /<script src="\/vendor\/exceljs\.min\.js\?v=[^"]+"><\/script>/);
  assert.doesNotMatch(indexHtml, /cdn\.jsdelivr|unpkg\.com/, "sem CDN no HTML servido");
});

// ===== Total Fardos (relatório de compras) =====

test("Total Fardos vem de obterFatoresEmLote, não de uma coluna fator_conversao em produtos", () => {
  // produtos NÃO tem fator_conversao/embalagem -- essas colunas moram em
  // product_integration_mappings, por integração. Reimplementar essa leitura na mão (em vez de
  // reusar a função já testada e otimizada que pedidos.routes.js usa) foi um erro real cometido
  // e corrigido antes desta rota existir.
  assert.match(rotas, /import \{ obterFatoresEmLote \} from "\.\.\/\.\.\/services\/integrations\/core\/fator-conversao\.repository\.js";/);
  assert.match(rota, /const fatoresPorSku = await obterFatoresEmLote\(pool, linhas\.map\(\(linha\) => linha\.sku\)\);/);
  assert.doesNotMatch(rota, /FROM produtos.*fator_conversao/is, "produtos não tem essa coluna");
});

test("produto sem fator cadastrado (ou fator inválido) usa fator 1, nunca fica em branco/travessão", () => {
  // Decisão do usuário (18/09/2026): Total Fardos = Total / COALESCE(fator, 1) -- nunca null,
  // nunca "—". obterFatoresEmLote já devolve fator=1 quando não há vínculo, mas com fator_status
  // INVALIDO ele devolve fator=null (conteúdo não numérico no ERP) -- daí o Number.isFinite aqui,
  // que cobre os dois casos (sem vínculo E vínculo com conteúdo inválido) com a mesma regra.
  const trecho = rota.slice(rota.indexOf("const fatoresPorSku"));
  assert.match(trecho, /const fatorEfetivo = Number\.isFinite\(fator\) && fator > 0 \? fator : 1;/);
});

test("Total Fardos não arredonda nem trunca -- fica com casas decimais", () => {
  const trecho = rota.slice(rota.indexOf("const fatoresPorSku"));
  assert.match(trecho, /linha\.totalFardos = linha\.total \/ fatorEfetivo;/);
  assert.doesNotMatch(trecho, /Math\.round|Math\.floor|Math\.trunc|parseInt/);
});

test("Total Fardos é calculado no backend, o front só exibe (mesma responsabilidade do resto da rota)", () => {
  assert.doesNotMatch(appJs, /totalFardos = .*\/ /, "o front não deveria fazer essa divisão de novo");
});

// ===== Filtro de categoria =====

test("filtro de categoria compara sem depender de acento/caixa exatos, e ausente = sem filtro", () => {
  // Compara contra as categorias INDIVIDUAIS do produto (array), não a string combinada --
  // selecionar só "PROTEINAS" tem que achar um produto cujo grupo é "MATERIA PRIMA, PROTEINAS".
  assert.match(rota, /cp\.categorias_individuais && \$1::text\[\]/);
  assert.match(rota, /const categoriasFiltroChave = categoriasFiltro\.length\s*\n\s*\? new Set\(categoriasFiltro\.map\(\(v\) => v\.toUpperCase\(\)\)\)\s*\n\s*: null;/);
});

test("categoria de exibição vem de produto_categorias (produto pode ter mais de uma), com produtos.categoria só como reserva", () => {
  // 62% dos produtos ativos não têm produtos.categoria preenchido -- a categorização real do
  // resto do sistema (tela de contagem do PDV, permissão por categoria) vive em
  // produto_categorias. Ignorar essa tabela deixava a maioria do catálogo fora do relatório.
  const trecho = rota.slice(rota.indexOf("const produtos = await query"), rota.indexOf("const skusContados"));
  assert.match(trecho, /string_agg\(DISTINCT pc\.categoria, ', ' ORDER BY pc\.categoria\)/);
  assert.match(trecho, /FROM produto_categorias pc WHERE pc\.sku_produto = p\.sku/);
  assert.match(trecho, /NULLIF\(TRIM\(p\.categoria\), ''\)/, "produtos.categoria só entra como reserva");
  assert.match(trecho, /'Sem categoria'/, "nunca fica sem grupo por falta de categorização");
});

test("produto com mais de uma categoria (produto_categorias) vira UM grupo combinado, não duplica no Total", () => {
  // Decisão do usuário (21/09/2026): mesmo padrão de SQL_PRODUTOS_DO_PDV -- "MATERIA PRIMA,
  // PROTEINAS" é um grupo só. Duplicar a linha em cada categoria infla o Total do relatório.
  const trecho = rota.slice(rota.indexOf("const produtos = await query"), rota.indexOf("const skusContados"));
  assert.match(trecho, /array_agg\(DISTINCT UPPER\(TRIM\(pc\.categoria\)\)\)/);
  // Uma linha por SKU (JOIN 1:1 com o CTE, não JOIN direto em produto_categorias que
  // multiplicaria linhas por categoria)
  assert.doesNotMatch(trecho, /JOIN produto_categorias[\s\S]{0,80}SELECT p\.sku, p\.nome/);
});

test("categoria filtrada estreita o catálogo de produtos consultado, não filtra em memória depois", () => {
  const trecho = rota.slice(rota.indexOf("const produtos = await query"), rota.indexOf("const skusContados"));
  assert.match(trecho, /\$1::text\[\] IS NULL OR/);
});

// ===== Filtro de local =====

test("filtro de local usa o mesmo token ALMOX nas duas rotas (relatório e /filtros), sem tradução entre front e back", () => {
  assert.match(rotaFiltros, /\{ id: "ALMOX", nome: "Almoxarifado" \}/);
  assert.match(rota, /const incluiAlmoxarifado = !locaisFiltroAtivo \|\| locaisFiltroBruto\.includes\("ALMOX"\);/);
});

test("filtro de local só com ALMOX selecionado não deveria incluir nenhum PDV por engano", () => {
  // Bug pego na própria implementação: uma versão anterior caía num "pdvIdsFiltro.size === 0
  // então inclui tudo", que tratava "só Almoxarifado" como "sem filtro nenhum" e mostrava as
  // colunas de PDV mesmo assim.
  assert.doesNotMatch(rota, /pdvIdsFiltro\.size === 0/);
  assert.match(rota, /const pdvIdsVisiveis = new Set\(pdvs\.map\(\(p\) => p\.id\)\);/);
  assert.match(rota, /vencedoresTodos\.filter\(\(v\) => \(v\.pdv_id === null \? incluiAlmoxarifado : pdvIdsVisiveis\.has\(v\.pdv_id\)\)\);/);
});

test("local escondido pelo filtro estreita Total/Total Fardos E o critério de inclusão da linha, não só a coluna visível", () => {
  // Decisão do usuário (21/09/2026): Total soma só o que está visível -- por isso o filtro de
  // local precisa agir ANTES de vencedores/contadoPorLocal/skusContados serem montados, não
  // só depois, escondendo coluna de um cálculo que ainda considerava tudo por trás.
  const posPdvsFiltrados = rota.indexOf("const pdvs = locaisFiltroAtivo");
  const posVencedores = rota.indexOf("const vencedores = vencedoresTodos.filter");
  const posSkusContados = rota.indexOf("const skusContados = new Set();");
  assert.ok(posPdvsFiltrados > -1 && posPdvsFiltrados < posVencedores, "pdvs precisa estar filtrado antes de filtrar vencedores");
  assert.ok(posVencedores < posSkusContados, "vencedores (já filtrado) precisa vir antes do critério de inclusão, que depende dele");
});

test("rota /relatorio/filtros exige admin, não tem corte e devolve o universo inteiro (não filtrado)", () => {
  assert.match(rotaFiltros, /requireUser\(req, res, "admin"\)/);
  assert.doesNotMatch(rotaFiltros, /searchParams\.get\("corte"\)/);
  assert.match(rotaFiltros, /FROM pdvs WHERE administrativo = FALSE/);
});

test("filtro de categorias lista nomes individuais de produto_categorias, com produtos.categoria e 'Sem categoria' de reserva", () => {
  // Mesma correção da rota principal: produtos.categoria sozinha ("Sorveteria"/"Vinhos" nunca
  // apareciam, por exemplo, porque só existem em produto_categorias). A lista de opções do
  // filtro precisa enxergar as três fontes, senão o painel nunca oferece uma categoria que só
  // existe em produto_categorias.
  assert.match(rotaFiltros, /FROM produto_categorias pc\s*\n\s*JOIN produtos p ON p\.sku = pc\.sku_produto/);
  assert.match(rotaFiltros, /NOT EXISTS \(SELECT 1 FROM produto_categorias pc2 WHERE pc2\.sku_produto = p\.sku\)/);
  assert.match(rotaFiltros, /SELECT 'Sem categoria' AS categoria/);
});

// ===== Modal e botão no cabeçalho (item 4) =====

test('viewInventarios passa o botão RELATORIO como actions pro shell(), que antes só recebia um argumento', () => {
  const view = appJs.slice(appJs.indexOf("async function viewInventarios"), appJs.indexOf("async function openRelatorioEstoqueModal"));
  assert.match(view, /shell\(`[\s\S]*`,\s*\n(\s*\/\/[^\n]*\n)*\s*`<button class="btn secondary" id="abrir-relatorio-estoque" type="button">RELATORIO<\/button>`\);/);
  assert.doesNotMatch(view, /\$\{blocoRelatorioDeEstoque\(\)\}/, "o card antigo saiu do corpo da página");
});

test("o card 'Consolidado' antigo foi removido -- blocoRelatorioDeEstoque não existe mais", () => {
  assert.doesNotMatch(appJs, /function blocoRelatorioDeEstoque/);
});

test("o painel do relatório é modal (photo-viewer), não um drawer lateral", () => {
  const modal = appJs.slice(appJs.indexOf("async function openRelatorioEstoqueModal"), appJs.indexOf("// Busca os dados do relatório"));
  assert.match(modal, /modal\.className = "photo-viewer";/);
  assert.match(modal, /class="photo-viewer-dialog relatorio-estoque-dialog"/);
  assert.match(modal, /document\.body\.appendChild\(modal\);/);
  // Fecha clicando fora, igual aos outros modais do sistema
  assert.match(modal, /if \(event\.target === modal\) close\(\);/);
});

test("os filtros de categoria/local vêm da rota /filtros ao abrir o modal, não hardcoded no front", () => {
  const modal = appJs.slice(appJs.indexOf("async function openRelatorioEstoqueModal"), appJs.indexOf("// Busca os dados do relatório"));
  assert.match(modal, /request\("\/api\/admin\/inventario\/relatorio\/filtros", \{ silentLoading: true \}\)/);
});

test("selecionar tudo (categoria/local) só existe uma vez por lista, e atualiza o contador", () => {
  const modal = appJs.slice(appJs.indexOf("async function openRelatorioEstoqueModal"), appJs.indexOf("// Busca os dados do relatório"));
  assert.match(modal, /#relatorio-categorias-select-all/);
  assert.match(modal, /#relatorio-locais-select-all/);
  assert.match(modal, /const atualizarContador = /);
});

// ===== Persistência em localStorage (item 4 das perguntas) =====

test("filtro de categoria/local persiste em localStorage, sob chave própria -- não é lido/gravado no servidor", () => {
  assert.match(appJs, /const CHAVE_FILTRO_RELATORIO_ESTOQUE = "relatorio-estoque-filtros";/);
  assert.match(appJs, /function lerFiltroRelatorioEstoqueSalvo\(\)/);
  assert.match(appJs, /function salvarFiltroRelatorioEstoque\(filtro\)/);
  assert.match(appJs, /localStorage\.getItem\(CHAVE_FILTRO_RELATORIO_ESTOQUE\)/);
  assert.match(appJs, /localStorage\.setItem\(CHAVE_FILTRO_RELATORIO_ESTOQUE, JSON\.stringify\(filtro\)\)/);
});

test("localStorage corrompido ou indisponível (navegação privada) não quebra a abertura do modal", () => {
  const leitura = appJs.slice(appJs.indexOf("function lerFiltroRelatorioEstoqueSalvo"), appJs.indexOf("function salvarFiltroRelatorioEstoque"));
  assert.match(leitura, /try \{/);
  assert.match(leitura, /\} catch \{/);
  const escrita = appJs.slice(appJs.indexOf("function salvarFiltroRelatorioEstoque"), appJs.indexOf("// Relatório consolidado de estoque"));
  assert.match(escrita, /try \{/);
  assert.match(escrita, /\} catch \{/);
});

test("o filtro é salvo só quando o usuário efetivamente gera o relatório (imprimir/excel), não a cada clique de checkbox", () => {
  const modal = appJs.slice(appJs.indexOf("async function openRelatorioEstoqueModal"), appJs.indexOf("// Busca os dados do relatório"));
  const posImprimir = modal.indexOf('"#relatorio-imprimir"');
  const posExcel = modal.indexOf('"#relatorio-excel"');
  const blocoImprimir = modal.slice(posImprimir, posExcel);
  const blocoExcel = modal.slice(posExcel);
  assert.match(blocoImprimir, /salvarFiltroRelatorioEstoque\(/);
  assert.match(blocoExcel, /salvarFiltroRelatorioEstoque\(/);
});

// ===== Incluir/excluir a coluna Almoxarifado (impressão e Excel) =====

test("a coluna Almoxarifado só existe na impressão/Excel quando incluiAlmoxarifado é true", () => {
  const printFn = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(printFn, /\.\.\.\(incluiAlmoxarifado \? \[\{ classe: "almox", rotulo: "Almoxarifado" \}\] : \[\]\)/);
  assert.match(printFn, /\$\{incluiAlmoxarifado \? celula\(linha\.almoxarifado\) : ""\}/);

  const exportFn = appJs.slice(appJs.indexOf("async function exportInventoryReport"), appJs.indexOf("// View administrativa de avarias"));
  assert.match(exportFn, /\.\.\.\(incluiAlmoxarifado \? \["Almoxarifado"\] : \[\]\)/);
  assert.match(exportFn, /\.\.\.\(incluiAlmoxarifado \? \[linha\.almoxarifado\] : \[\]\)/);
});

test("totalColunas na impressão vem de uma lista de colunas montada, não de uma conta manual -- evita o off-by-one que já existiu aqui", () => {
  // Bug real encontrado ao adicionar a coluna Total Fardos: a fórmula antiga "2 + pdvs.length +
  // 3" tinha uma coluna a menos que o colgroup/thead de verdade, então a linha de categoria
  // (colspan) ficava curta e não cobria a última coluna da tabela.
  const printFn = appJs.slice(appJs.indexOf("function buildInventoryReportPrintHtml"), appJs.indexOf("function printInventoryReport"));
  assert.match(printFn, /const totalColunas = colunas\.length;/);
  assert.doesNotMatch(printFn, /const totalColunas = \d+ \+ pdvs\.length/, "não pode voltar a ser uma conta manual solta");
});

// ===== Contagem decimal (item 2) =====

test("os quatro campos de contagem de inventário aceitam decimal (step 0.01, inputmode decimal)", () => {
  // PDV, correção pelo Almoxarifado (detalhe do inventário do PDV), contagem própria do
  // Almoxarifado, e "+ Adicionar produto" na contagem do PDV -- as quatro telas onde se digita
  // uma quantidade contada.
  assert.match(appJs, /class="inventario-qtd" type="number" min="0" step="0\.01" inputmode="decimal"/);
  assert.match(appJs, /class="almox-qtd inventario-qtd" type="number" min="0" step="0\.01" inputmode="decimal"/);
  assert.match(appJs, /class="inventario-admin-qtd" type="number" min="0" step="0\.01" inputmode="decimal"/);
  assert.match(appJs, /class="inventario-add-qty" type="number" min="0" step="0\.01" value="0" inputmode="decimal"/);
  assert.doesNotMatch(appJs, /class="[a-z-]*inventario[a-z-]*qty?" type="number"[^>]*step="1"/, "nenhum campo de contagem de inventário deveria ter voltado a step=1");
});

// ===== Auto-save (localStorage + debounce pro PATCH que já existia) =====

test("contagem do PDV: localStorage a cada tecla + PATCH debounced 2,5s depois de parar de digitar", () => {
  const fnBind = appJs.slice(appJs.indexOf("function bindInventarioPdv"), appJs.indexOf("// Abre a contagem"));
  assert.match(fnBind, /const autoSalvarNoServidor = debounce\(\(\) => salvarContagemInventarioAuto\(codigo\), 2500\);/);
  assert.match(fnBind, /salvarRascunhoInventarioLocal\(chaveRascunhoInventarioPdv\(codigo\), itensDaTelaInventario\);/);
  assert.match(fnBind, /autoSalvarNoServidor\(\);/);

  // O auto-save é silencioso (sem desabilitar botão nem toast de sucesso a cada poucos
  // segundos) -- só erro continua aparecendo, porque perder a contagem em silêncio é pior.
  const fnAuto = appJs.slice(appJs.indexOf("async function salvarContagemInventarioAuto"), appJs.indexOf("async function salvarContagemInventarioAuto") + 500);
  assert.match(fnAuto, /silentLoading: true/);
  assert.doesNotMatch(fnAuto, /toast\(".*salv/i);

  // Rascunho local é lido e mesclado por cima do que o servidor devolveu, na abertura da tela
  assert.match(appJs, /const rascunho = lerRascunhoInventarioLocal\(chaveRascunhoInventarioPdv\(inventario\.codigo_inventario\)\);/);
});

test("contagem do PDV: rascunho local some depois de salvar (manual, automático ou enviar)", () => {
  const trechoSalvar = appJs.slice(appJs.indexOf("async function salvarContagemInventario("), appJs.indexOf("async function salvarContagemInventarioAuto"));
  assert.match(trechoSalvar, /limparRascunhoInventarioLocal\(chaveRascunhoInventarioPdv\(codigo\)\);/);

  const trechoAuto = appJs.slice(appJs.indexOf("async function salvarContagemInventarioAuto"), appJs.indexOf("// Envio: salva antes"));
  assert.match(trechoAuto, /limparRascunhoInventarioLocal\(chaveRascunhoInventarioPdv\(codigo\)\);/);

  const trechoEnviar = appJs.slice(appJs.indexOf("async function enviarContagemInventario"), appJs.indexOf("// ===== Aba INVENTÁRIOS do Almoxarifado ====="));
  assert.match(trechoEnviar, /limparRascunhoInventarioLocal\(chaveRascunhoInventarioPdv\(codigo\)\);/);
});

test("contagem própria do Almoxarifado: mesmo padrão de auto-save (localStorage + PATCH debounced)", () => {
  const fim = appJs.indexOf("document.querySelector(\"#almox-concluir\")");
  const trecho = appJs.slice(appJs.indexOf("function bindContagemDoAlmoxarifado"), fim);
  assert.match(trecho, /const chaveRascunho = chaveRascunhoInventarioAlmox\(codigo\);/);
  assert.match(trecho, /const autoSalvarNoServidor = debounce\(\(\) => salvar\(\)\.catch\(\(\) => \{\}\), 2500\);/);
  assert.match(trecho, /salvarRascunhoInventarioLocal\(chaveRascunho, itensDaTelaAlmox\);/);
  // salvar() já limpa o rascunho local ao ter sucesso -- reaproveitado tanto pelo auto-save
  // quanto pelo clique manual e pelo "Assinar e confirmar", sem precisar repetir em 3 lugares
  assert.match(trecho, /const salvar = async \(\) => \{[\s\S]{0,300}limparRascunhoInventarioLocal\(chaveRascunho\);/);

  assert.match(appJs, /const rascunho = lerRascunhoInventarioLocal\(chaveRascunhoInventarioAlmox\(inventario\.codigo_inventario\)\);/);
});

test("contagemDigitada não arredonda nem exige inteiro -- decimal já passava, sem precisar mudar essa função", () => {
  const fn = appJs.slice(appJs.indexOf("function contagemDigitada"), appJs.indexOf("// Linha de um produto na contagem"));
  assert.match(fn, /const numero = Number\(texto\);/);
  assert.doesNotMatch(fn, /Number\.isInteger|Math\.round|Math\.floor|Math\.trunc/);
});

test("o ajuste de inventário que consome a contagem já aceita decimal (Number, sem arredondar) -- regra não pode regredir", () => {
  const service = fs.readFileSync("server/services/inventarios/ajuste-inventario.service.js", "utf8");
  assert.match(service, /const contado = Number\(item\.quantidade_contada\);/);
  assert.doesNotMatch(service, /Math\.round\(item\.quantidade_contada\)|parseInt\(item\.quantidade_contada/);
  // A regra que não pode regredir: produto sem contagem nunca é tocado, com ou sem os filtros
  // novos do relatório -- o relatório é read-only e nem importa este arquivo
  assert.match(service, /SEM CONTAGEM = NAO TOCA/);
});

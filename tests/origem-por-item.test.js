import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (caminho) => fs.readFileSync(new URL(caminho, import.meta.url), "utf8").split("\r\n").join("\n");
const routes = ler("../server/modules/pedidos/pedidos.routes.js");
const origem = ler("../server/services/pedidos/origem-estoque.service.js");
const app = ler("../public/app.js");
const migracao = ler("../tools/migrar-local-origem-estoque.mjs");

const rota = (inicio, fim) => routes.slice(routes.indexOf(inicio), routes.indexOf(fim, routes.indexOf(inicio)));

test("a chave de idempotência da OMIE é por linha: duas partes do mesmo produto não colidem", async () => {
  // Risco mais silencioso da divisão: com a mesma chave, o ON CONFLICT DO NOTHING descartaria a
  // segunda parte e a OMIE nunca a receberia. Provado também contra o banco real, com ROLLBACK.
  const { montarChaveIdempotencia } = await import("../server/services/integrations/core/stock-launches.repository.js");
  const base = { codigoPedido: "PED-1", sku: "SKU-X", evento: "RETIRADA", versao: 1 };
  const parte1 = montarChaveIdempotencia({ ...base, pedidoItemId: 101 });
  const parte2 = montarChaveIdempotencia({ ...base, pedidoItemId: 102 });
  assert.notEqual(parte1, parte2);
  assert.equal(parte1, montarChaveIdempotencia({ ...base, pedidoItemId: 101 }), "a mesma parte continua idempotente");
  // Cada parte vai com o seu id e a sua origem
  const baixa = routes.slice(routes.indexOf("export async function baixarEstoqueDaRetirada"), routes.indexOf("export async function avisarPdvPedidoAguardandoRetirada"));
  assert.match(baixa, /pedidoItemId: row\.id,\s*sku: row\.sku_produto,\s*pdvId: row\.pdv_id,\s*origemPdvId: origemDaLinha\(row\)/);
});

test("migração ganha origem_por_item (sem DEFAULT)", () => {
  assert.match(migracao, /ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origem_por_item BOOLEAN"/);
});

test("as fusões de linhas do mesmo produto respeitam a origem", () => {
  // Enviar para retirada e finalizar só fundem linhas da MESMA origem
  assert.equal((routes.match(/AND local_origem_pdv_id IS NOT DISTINCT FROM \$4/g) || []).length, 2);
  assert.match(routes, /RETURNING id, codigo_pedido, sku_produto, quantidade_liberada, local_origem_pdv_id`/);
  // Reabertura agrupa por PDV + produto + origem
  assert.match(routes, /const key = `\$\{row\.pdv_id\}::\$\{row\.sku_produto\}::\$\{origemDaLinha\(row\) \?\? "ALMOX"\}`;/);
  // PDV somando produto repetido cai na linha da origem padrão, nunca numa parte ajustada
  assert.equal((routes.match(/\$\{ORDEM_LINHA_PADRAO_PRIMEIRO\}/g) || []).length, 2);
  assert.match(origem, /export const ORDEM_LINHA_PADRAO_PRIMEIRO = "ORDER BY \(origem_por_item IS TRUE\), id";/);
});

test("origem por item: só admin, só antes de finalizar, id do próprio pedido, sem repetir origem", () => {
  const r = rota('"/api/admin/orders/origem" && method === "POST"', '"/api/admin/pedido/saldos-origem"');
  assert.match(r, /requireUser\(req, res, "admin"\)/);
  assert.match(r, /Pedido finalizado não muda de local de origem/);
  assert.match(r, /O item \$\{pedido\?\.id\} não pertence a este pedido\./);
  assert.match(r, /já tem uma parte saindo dessa origem/);
  assert.match(r, /origem_por_item = TRUE/);
  assert.match(r, /acao: "local_origem_item_alterado"/);
  // "Aplicar a todos" não reescreve os itens ajustados um a um
  assert.match(r, /WHERE codigo_pedido = \$1 AND origem_por_item IS NOT TRUE/);
});

test("dividir item: soma igual ao pedido, 2 a 5 partes, inteiras, origens distintas, só Em andamento", () => {
  const r = rota('"/api/admin/pedido/dividir-item"', '"/api/admin/pedido/juntar-item"');
  assert.match(r, /requireUser\(req, res, "admin"\)/);
  assert.match(r, /Só dá para dividir um item com o pedido Em andamento\./);
  assert.match(r, /Divida em 2 a 5 partes\./);
  assert.match(r, /quantidade inteira maior que zero/);
  assert.match(r, /A soma das partes \(\$\{soma\}\) precisa ser igual ao pedido \(\$\{pedida\}\)\./);
  assert.match(r, /Cada parte precisa de uma origem diferente\./);
  assert.match(r, /validarOrigem\(client, \{ origemPdvId: parte\.origem, destinoPdvId: linha\.pdv_id \}\)/);
  // A liberação já digitada é repartida sem mudar o total
  assert.match(r, /liberadas\[liberadas\.length - 1\] \+= liberadaRestante;/);
  assert.match(r, /'ALMOX', \$16, TRUE\)/);
  assert.match(r, /acao: "item_dividido"/);
});

test("desfazer divisão soma as partes e volta para a origem padrão", () => {
  const r = rota('"/api/admin/pedido/juntar-item"', "// TRANSFERÊNCIA RÁPIDA");
  assert.match(r, /Este produto não está dividido\./);
  assert.match(r, /const origem = await origemPadraoDoPedido\(client, orderCode, manter\.pdv_id\);/);
  assert.match(r, /acao: "divisao_desfeita"/);
});

test("pedido com item dividido não volta para Pendente (Kanban e painel)", () => {
  assert.match(origem, /Desfaça a divisão antes de voltar o pedido para Pendente\./);
  assert.match(routes, /if \(nextStatus === "Pendente"\) await exigirSemItemDividido\(client, orderCode\);/);
  assert.match(routes, /if \(codigoDoPedido\) await exigirSemItemDividido\(client, codigoDoPedido\);/);
});

test("tela: coluna Origem por item, dividir/desfazer, padrão com 'aplicar a todos'", () => {
  assert.match(app, /\["Produto", "Origem", "Estoque central", "Solicitado", "Liberado"\]/);
  assert.match(app, /function celulaOrigemDoItem\(item, contexto, editable\)/);
  assert.match(app, /class="link-action dividir-item"/);
  assert.match(app, /class="link-action juntar-item"/);
  assert.match(app, /function abrirDivisaoDeItem\(item, dados, destino, aoConcluir\)/);
  assert.match(app, /\/api\/admin\/pedido\/saldos-origem/);
  assert.match(app, /Origem padrão do pedido/);
  assert.match(app, /order-panel-aplicar-origem/);
});

test("produto dividido conta uma vez; PDV vê somado; cupom e comprovante dizem a origem", () => {
  assert.match(app, /return new Set\(group\.map\(\(item\) => item\.sku_produto \|\| item\.sku \|\| item\.id\)\)\.size;/);
  assert.doesNotMatch(app, /const totalItems = group\.length;/);
  assert.match(app, /const itensSomados = somarPartesDoMesmoProduto\(visibleItems\);/);
  assert.match(app, /if \(new Set\(rows\.map\(\(item\) => item\.origem\)\)\.size > 1\)/);
  assert.match(app, /function comOrigemQuandoMisturado\(itens = \[\]\)/);
});

test("os locais de estoque não dependem da rota de saldo (sem ela, só sobrava Almoxarifado)", () => {
  // Visto em 24/09/2026: o servidor rodando não tinha /saldos-origem, o erro era engolido e
  // os seletores ficavam só com "Almoxarifado". Locais vêm da rota estável; saldo é complemento.
  const bind = app.slice(app.indexOf("const preencherSeletores = () => {"), app.indexOf("// \"Aplicar a todos\""));
  assert.match(bind, /Promise\.allSettled\(\[\s*request\("\/api\/admin\/pdvs"/);
  assert.match(bind, /if \(locais\.status === "fulfilled"\)/);
  assert.match(bind, /Não foi possível carregar os locais de estoque\./);
  assert.doesNotMatch(bind, /\.catch\(\(\) => \{\}\)/, "erro de locais não pode ser engolido em silêncio");
  // Sem saldo, o local aparece sem número (nunca um "0" inventado): data-saldo vazio vira "—"
  assert.match(app, /data-saldo="\$\{saldo === null \? "" : esc\(saldo\)\}"/);
  assert.match(app, /if \(saldo === undefined \|\| saldo === null \|\| saldo === ""\) return `<span class="local-saldo is-desconhecido"/);
});

test("seletor de locais: componente sobre o <select> original, que continua sendo a fonte do valor", () => {
  assert.match(app, /function aprimorarSeletorDeLocal\(select, \{ titulo = "", compacto = false \} = \{\}\)/);
  // Escolher só muda o select e dispara "change": quem grava a origem não muda
  assert.match(app, /select\.value = valor;\s*atualizarSeletorDeLocal\(select\);\s*select\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\);/);
  // Aplicado no painel (padrão e item), na transferência e no local padrão do PDV
  assert.match(app, /aprimorarSeletorDeLocal\(origemSel, \{ titulo: "Origem padrão do pedido" \}\)/);
  assert.match(app, /aprimorarSeletorDeLocal\(sel, \{\s*titulo: `Origem de/);
  assert.match(app, /aprimorarSeletorDeLocal\(destinoSel, \{ titulo: "PDV de destino" \}\)/);
  assert.match(app, /aprimorarSeletorDeLocal\(localPadrao, \{ titulo: "Local de estoque padrão" \}\)/);
  // Saldo vai em data-saldo (o botão e a lista mostram como chip); marcador de posição não vira opção
  assert.match(app, /const atributoSaldo = sku \? ` data-saldo=/);
  assert.match(app, /<option value="" data-placeholder>Escolha o PDV<\/option>/);
  // Celular vira painel de baixo; no desktop fecha ao rolar, mas não no celular
  assert.match(app, /window\.matchMedia\("\(max-width: 720px\)"\)\.matches/);
  assert.match(app, /if \(celular \|\| Date\.now\(\) - abertoEm < 150 \|\| menu\.contains\(evento\?\.target\)\) return;/);
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.local-menu\.is-sheet \{/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\);/);
});

test("na linha do produto o seletor mostra só o selo; nome e saldo no título e na lista", () => {
  assert.match(app, /if \(botao\.classList\.contains\("is-compacto"\)\) \{[\s\S]{0,400}?botao\.innerHTML = avatar;/);
  assert.match(app, /botao\.title = `\$\{nome\}\$\{saldo\}`;/);
  assert.match(app, /const largura = Math\.max\(r\.width, 300\);/);
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.local-picker\.is-compacto \{\s*justify-content: center;\s*width: 38px;/);
});

test("tabela de produtos do pedido mostra 5 produtos por rolagem", () => {
  // Sem altura própria a tabela ficava com o que sobrava do painel (às vezes só o cabeçalho)
  assert.match(app, /function ajustarAlturaDaTabelaDoPedido\(overlay\)/);
  assert.match(app, /const cinco = linhas\.slice\(0, 5\)\.reduce/);
  assert.doesNotMatch(app, /if \(linhas\.length <= 5\)/, "poucos produtos também ganham altura fixa");
  assert.match(app, /bindReleasePanel\(overlay, group, context\);\s*ajustarAlturaDaTabelaDoPedido\(overlay\);/);
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.order-panel-content:has\(> \.order-panel-table\) \{\s*overflow-y: auto;/);
  assert.match(css, /\.order-panel-content > \.table-wrap\.order-panel-table\.tem-altura-fixa \{\s*flex: 0 0 auto;/);
});

test("o diálogo de divisão não lista o saldo por local (fica só na escolha da origem de cada parte)", () => {
  const dialogo = app.slice(app.indexOf("function abrirDivisaoDeItem"), app.indexOf("function abrirDivisaoDeItem") + 3000);
  assert.doesNotMatch(dialogo, /Saldo por local:/);
  assert.match(dialogo, /O PDV pediu <strong>\$\{pedida\}<\/strong>\.<\/p>/);
});

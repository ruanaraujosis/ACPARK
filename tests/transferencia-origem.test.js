import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (caminho) => fs.readFileSync(new URL(caminho, import.meta.url), "utf8");
const routes = ler("../server/modules/pedidos/pedidos.routes.js");
const origem = ler("../server/services/pedidos/origem-estoque.service.js");
const lancamentos = ler("../server/services/integrations/core/stock-launches.service.js");
const index = ler("../server/index.js");
const app = ler("../public/app.js");
const migracao = ler("../tools/migrar-local-origem-estoque.mjs");

test("migração só adiciona as duas colunas (NULL = Almoxarifado), simulação por padrão", () => {
  assert.match(migracao, /ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS local_estoque_padrao_pdv_id INTEGER/);
  assert.match(migracao, /ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS local_origem_pdv_id INTEGER/);
  assert.match(migracao, /process\.argv\.includes\("--executar"\)/);
  // Só a lista de DDL: nada de DEFAULT (reescreveria a tabela) nem UPDATE de dado
  const ddl = migracao.slice(migracao.indexOf("const DDL = ["), migracao.indexOf("];", migracao.indexOf("const DDL = [")));
  assert.doesNotMatch(ddl, /DEFAULT|UPDATE /);
});

test("origem Almoxarifado mantém a baixa em qtd_total; origem PDV baixa em estoque_pdv", () => {
  assert.match(origem, /if \(origemPdvId === null \|\| origemPdvId === undefined\) \{\s*const \{ rows \} = await client\.query\(\s*"UPDATE produtos SET qtd_total = qtd_total - \$1/);
  assert.match(origem, /ON CONFLICT \(pdv_id, sku_produto\) DO UPDATE SET quantidade = estoque_pdv\.quantidade - \$3::numeric/);
  // A baixa da retirada passa pela origem; não sobra débito direto em qtd_total na rota
  assert.match(routes, /const saldo = await debitarOrigem\(client, \{ origemPdvId: origemDaLinha\(row\)/);
  assert.doesNotMatch(routes, /qtd_total = qtd_total -/);
});

test("saldo negativo na origem não bloqueia: vira aviso com o nome do local", () => {
  assert.doesNotMatch(origem, /insuficiente/i);
  assert.match(routes, /negativos\.push\(\{ sku: saldo\.sku, nome: saldo\.nome, saldo: Number\(saldo\.saldo\), local: saldo\.local \}\)/);
});

test("o estorno da reabertura devolve ao mesmo local de origem (3 pontos)", () => {
  assert.doesNotMatch(routes, /qtd_total = qtd_total \+/);
  assert.equal((routes.match(/await estornarOrigem\(client, \{ origemPdvId: origemDaLinha\(current\)/g) || []).length, 3);
  assert.equal((routes.match(/origemPdvId: origemDaLinha\(current\), quantidade: oldQty/g) || []).length, 2, "compensação na OMIE também");
});

test("origem = destino e PDV administrativo como origem são recusados", () => {
  assert.match(origem, /O local de origem não pode ser o próprio PDV de destino\./);
  assert.match(origem, /PDV administrativo não tem estoque de revenda e não pode ser origem\./);
  assert.match(routes, /origemDaLinha\(row\) === Number\(row\.pdv_id\)/);
});

test("pedido novo herda a origem do pedido ou o padrão do PDV (todas as inserções)", () => {
  // A origem padrão é a das linhas NÃO ajustadas item a item (origem_por_item)
  assert.match(origem, /WHEN EXISTS \(SELECT 1 FROM pedidos po WHERE po\.codigo_pedido = \$\$\{parametroCodigo\} AND po\.origem_por_item IS NOT TRUE\)/);
  assert.equal((routes.match(/\$\{sqlOrigemDaNovaLinha\(1, [34]\)\}/g) || []).length, 3);
  assert.match(index, /\(SELECT local_estoque_padrao_pdv_id FROM pdvs WHERE id = \$2\)\)/, "autopedido usa o padrão");
});

test("mudar a origem: só admin, nunca em pedido finalizado, com auditoria", () => {
  const rota = routes.slice(routes.indexOf('"/api/admin/orders/origem"'), routes.indexOf('"/api/admin/transferencia-rapida"'));
  assert.match(rota, /requireUser\(req, res, "admin"\)/);
  assert.match(rota, /Pedido finalizado não muda de local de origem/);
  assert.match(rota, /acao: "local_origem_alterado"/);
  assert.match(rota, /validarOrigem\(client/);
});

test("transferência rápida: admin, finaliza sem assinatura e usa a mesma movimentação da retirada", () => {
  const rota = routes.slice(routes.indexOf('"/api/admin/transferencia-rapida"'), routes.indexOf("// Linha do tempo do pedido"));
  assert.match(rota, /requireUser\(req, res, "admin"\)/);
  assert.match(rota, /await baixarEstoqueDaRetirada\(client, orderCode, linhas\)/);
  assert.match(rota, /SET status = 'Finalizado'/);
  assert.doesNotMatch(rota, /retirada_assinatura = /, "sem assinatura do PDV");
  assert.match(rota, /acao: "transferencia_rapida"/);
  assert.match(rota, /'ALMOX'/);
  // A retirada com assinatura usa a mesma função: regra de estoque num lugar só
  const retirada = routes.slice(routes.indexOf('"/api/admin/order-withdrawal"'));
  assert.match(retirada, /await baixarEstoqueDaRetirada\(client, orderCode, targetRows\)/);
});

test("OMIE: origem vem do local do PDV de origem; sem vínculo ignora e avisa", () => {
  assert.match(lancamentos, /async function localDeOrigem\(client, integracao, origemPdvId\)/);
  assert.match(lancamentos, /Ha PDV de origem sem local de estoque vinculado/);
  assert.match(lancamentos, /const localRetorno = await localDeOrigem\(client, integracao, item\.origemPdvId\)/);
  assert.match(lancamentos, /localDestino: localRetorno/);
});

test("telas: local padrão no PDV, local atual/destino no painel e aba de transferência", () => {
  assert.match(app, /name="local_estoque_padrao_pdv_id"/);
  assert.match(app, /Origem padrão do pedido/);
  assert.match(app, /Aplicar a todos os itens/);
  assert.match(app, /Local de destino<strong>/);
  assert.match(app, /\/api\/admin\/orders\/origem/);
  assert.match(app, /id="release-transfer-tab"/);
  assert.match(app, /async function abrirTransferenciaRapida/);
  assert.match(app, /\/api\/admin\/transferencia-rapida/);
});

test("transferência rápida usa as mesmas peças do Novo pedido (sem HTML copiado)", () => {
  const transf = app.slice(app.indexOf("async function abrirTransferenciaRapida"), app.indexOf("async function viewRelease("));
  const pedido = app.slice(app.indexOf("async function viewOrder("), app.indexOf("async function viewMine("));
  for (const peca of ["htmlPainelAdicionarProduto({", "htmlCartaoCarrinho({", "htmlCartaoProdutosDisponiveis({", "ligarFiltroProdutosDisponiveis("]) {
    assert.ok(transf.includes(peca), `transferência usa ${peca}`);
    assert.ok(pedido.includes(peca), `novo pedido usa ${peca}`);
  }
  assert.match(transf, /ligarSeletorDeProduto\("transfer", adicionar\)/);
  assert.match(pedido, /ligarSeletorDeProduto\("order",/);
  // Sem datalist e sem rascunho; "Limpar" + botão principal de largura total
  assert.doesNotMatch(transf, /<datalist/);
  assert.doesNotMatch(transf, /Salvar rascunho/);
  assert.match(transf, /id="transfer-limpar"/);
  assert.match(transf, /class="btn mt-3 w-full" id="transfer-concluir"/);
  assert.match(transf, /table\(\["SKU", "Produto", "Categoria", "Ação"\]/);
  // Quantidade inteira e catálogo do sistema inteiro (produtos ativos)
  assert.match(transf, /passo: "1"/);
  assert.match(transf, /Number\.isInteger\(qtd\)/);
  assert.match(transf, /\(state\.products \|\| \[\]\)\.filter\(\(p\) => p\.ativo !== false\)/);
});

test("retirada e transferência avisam em diálogo quando a OMIE foi ignorada", () => {
  assert.match(app, /async function avisarSeOmieIgnorada\(integracao\)/);
  assert.match(app, /title: "Estoque não lançado na OMIE"/);
  assert.match(app, /await avisarSeOmieIgnorada\(r\.integracao\);/);
  assert.match(app, /await avisarSeOmieIgnorada\(resultado\?\.integracao\);/);
});

test("transferência rápida salva o rascunho sozinha e tem o botão Salvar ao lado de Limpar", () => {
  const transf = app.slice(app.indexOf("async function abrirTransferenciaRapida"), app.indexOf("async function viewRelease("));
  assert.match(transf, /id="transfer-salvar" type="button">Salvar<\/button>\s*<button class="btn secondary" id="transfer-limpar"/);
  assert.match(transf, /const renderCarrinho = \(\) => \{\s*salvarRascunhoTransferencia\(\);/);
  assert.match(transf, /origemSel\.addEventListener\("change", salvarRascunhoTransferencia\);/);
  assert.match(transf, /secao\.querySelector\("#transfer-obs"\)\.addEventListener\("input", salvarRascunhoTransferencia\);/);
  // Restaura antes do primeiro desenho (senão o carrinho vazio sobrescreveria o rascunho)
  assert.ok(transf.indexOf("localStorage.getItem(CHAVE_RASCUNHO_TRANSFERENCIA)") < transf.lastIndexOf("  renderCarrinho();\n  origemSel.addEventListener"));
  // Concluir e Limpar apagam o rascunho
  assert.equal((transf.match(/apagarRascunhoTransferencia\(\);/g) || []).length, 2);
});

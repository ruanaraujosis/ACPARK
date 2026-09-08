import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const routes = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

// Recorta só o corpo do DELETE /api/admin/orders, do início do handler até a próxima rota.
// Ancora numa frase exclusiva desta rota e busca o "if (method === "DELETE")" mais próximo
// antes dela, para não pegar outro handler que também comece com essa mesma linha.
const marcaExclusiva = routes.indexOf("Confirme o código do pedido para excluir.");
const inicioRota = routes.lastIndexOf('if (method === "DELETE") {', marcaExclusiva);
const deleteRota = routes.slice(
  inicioRota,
  routes.indexOf('const from = url.searchParams.get("from");', inicioRota)
);

test("item incluído pelo Almoxarifado não bloqueia mais a exclusão", () => {
  // Decisão do usuário (08/09/2026): a barreira específica de item_origem saiu -- as outras
  // continuam (é isso que os próximos testes travam).
  assert.doesNotMatch(deleteRota, /item incluído fora do pedido original do PDV/);
  assert.doesNotMatch(deleteRota, /rowsToDelete\.some\(\(item\) => item\.item_origem !== "PDV"\)/);
});

test("as outras barreiras de exclusão continuam intactas", () => {
  assert.match(deleteRota, /blockedReasons\.push\("status já avançado"\)/);
  assert.match(deleteRota, /blockedReasons\.push\("quantidade liberada"\)/);
  assert.match(deleteRota, /blockedReasons\.push\("retirada, assinatura ou liberação registrada"\)/);
  assert.match(deleteRota, /blockedReasons\.push\("operação de liberação parcial em andamento"\)/);
  assert.match(deleteRota, /blockedReasons\.push\("impressão em processamento"\)/);
  assert.match(deleteRota, /allowedCleanStatuses = new Set\(\["Pendente", "Em Andamento"\]\)/);
});

test("um registro de auditoria por item cancelado, antes do DELETE -- não um resumo agregado só", () => {
  const posLoop = deleteRota.indexOf("for (const item of rowsToDelete)");
  const posDelete = deleteRota.indexOf('client.query("DELETE FROM pedidos');
  assert.ok(posLoop > -1, "precisa existir um laço por item");
  assert.ok(posDelete > posLoop, "o laço de auditoria por item precisa rodar antes do DELETE");
  const loop = deleteRota.slice(posLoop, posDelete);
  assert.match(loop, /"item_cancelado"/);
  // Cada linha carrega produto, SKU, quantidade solicitada/liberada e a origem do item
  assert.match(loop, /produto: item\.produto \|\| null/);
  assert.match(loop, /sku_produto: item\.sku_produto/);
  assert.match(loop, /quantidade_solicitada: asInt\(item\.quantidade_solicitada\)/);
  assert.match(loop, /quantidade_liberada: asInt\(item\.quantidade_liberada\) \|\| null/);
  assert.match(loop, /item_origem: item\.item_origem/);
});

test("a palavra \"cancelado\" aparece no próprio registro do item, não só implícita", () => {
  const posLoop = deleteRota.indexOf("for (const item of rowsToDelete)");
  const posDelete = deleteRota.indexOf('client.query("DELETE FROM pedidos');
  const loop = deleteRota.slice(posLoop, posDelete);
  assert.match(loop, /`Item cancelado: \$\{item\.produto \|\| item\.sku_produto\}/);
});

test("o resumo agregado do pedido (pedido_excluido_definitivamente) continua existindo, além do detalhe por item", () => {
  const posDelete = deleteRota.indexOf('client.query("DELETE FROM pedidos');
  const resto = deleteRota.slice(posDelete);
  assert.match(resto, /"pedido_excluido_definitivamente"/);
});

test("a query FOR UPDATE traz produto e quantidade solicitada, e não perde linha se o produto sumiu do cadastro", () => {
  assert.match(deleteRota, /LEFT JOIN produtos pr ON pr\.sku = p\.sku_produto/);
  assert.match(deleteRota, /pr\.nome AS produto/);
  assert.match(deleteRota, /p\.quantidade_solicitada/);
});

test("FOR UPDATE trava só pedidos, nunca o LEFT JOIN com produtos", () => {
  // Bug real pego na verificação de ponta a ponta: Postgres recusa FOR UPDATE no lado nulo de
  // um LEFT JOIN ("FOR UPDATE não pode ser aplicado ao lado com valores nulos de uma junção
  // externa") -- sem o "OF p", a exclusão quebrava com erro 0A000 em qualquer pedido.
  assert.match(deleteRota, /FOR UPDATE OF p`/);
  assert.doesNotMatch(deleteRota, /FOR UPDATE`/, "FOR UPDATE sem escopo voltaria a travar o LEFT JOIN inteiro");
});

test("exclusão continua sendo local -- nenhum lançamento na OMIE nem estorno de estoque nesta rota", () => {
  assert.doesNotMatch(deleteRota, /chamarOmie|integration_stock_launches|estoque_pdv/);
});

test("o rótulo do relatório de edição usa a ação real gravada (pedido_excluido_definitivamente), não a antiga que nunca batia", () => {
  // Bug adjacente encontrado ao mexer aqui: a rota grava "pedido_excluido_definitivamente", mas
  // o rótulo comparava com "pedido_excluido" (sem sufixo) -- nunca batia, caía no texto cru.
  const fn = app.slice(app.indexOf("function releaseTimelineLabel"), app.indexOf("function releaseTimelineLabel") + 700);
  assert.match(fn, /if \(acao === "pedido_excluido_definitivamente"\) return "Pedido excluído";/);
  assert.match(fn, /if \(acao === "item_cancelado"\) return "Item cancelado";/);
});

test("o modal de histórico mostra produto, SKU, quantidade e origem de cada item cancelado", () => {
  const modal = app.slice(app.indexOf("async function openReleaseTimelineModal"), app.indexOf("// Abre o fluxo de finalizacao com assinatura"));
  assert.match(modal, /linha\.acao === "item_cancelado"/);
  assert.match(modal, /linha\.dados\?\.produto \|\| linha\.dados\?\.sku_produto/);
  assert.match(modal, /Solicitado \$\{Number\(linha\.dados\?\.quantidade_solicitada\) \|\| 0\}/);
  assert.match(modal, /linha\.dados\?\.item_origem === "PDV" \? "Pedido original do PDV" : "Incluído pelo Almoxarifado"/);
});

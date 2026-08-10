// Protege as regras das etapas de status do pedido (quadro Kanban, painel e retirada).
// O ciclo completo contra o banco real fica em tools/e2e-status-pedidos.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routes = readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

// Trecho da rota do Kanban, onde ficam as regras de data e quantidade por status de destino
const kanbanBlock = routes.slice(routes.indexOf("/api/admin/orders/status"), routes.indexOf("/api/admin/orders\"") || routes.length);

test("mover o card para Aguardando Retirada libera a quantidade solicitada", () => {
  // Sem isso o pedido chegava na coluna com quantidade zerada e a retirada não podia ser confirmada
  assert.match(kanbanBlock, /quantidade_liberada = CASE[\s\S]*ELSE quantidade_solicitada[\s\S]*END/);
  assert.match(kanbanBlock, /LEAST\(quantidade_liberada, quantidade_solicitada\)/);
  assert.match(kanbanBlock, /RETURNING id, codigo_pedido, status, quantidade_liberada, updated_at/);
  assert.match(kanbanBlock, /quantidade_liberada: totalLiberado/);
});

test("voltar o card de etapa desfaz a liberação e limpa as datas", () => {
  const paraAndamento = kanbanBlock.match(/nextStatus === "Em Andamento"\s*\?\s*`([^`]*)`/);
  assert.ok(paraAndamento, "regra de volta para Em Andamento deve existir");
  assert.match(paraAndamento[1], /quantidade_liberada = 0/);
  assert.match(paraAndamento[1], /liberado_em = NULL/);
  assert.match(paraAndamento[1], /pronto_retirada_em = NULL/);
  assert.match(paraAndamento[1], /release_mode = NULL/);

  const paraPendente = kanbanBlock.match(/:\s*`, em_andamento_em = NULL([^`]*)`/);
  assert.ok(paraPendente, "regra de volta para Pendente deve existir");
  assert.match(paraPendente[1], /quantidade_liberada = 0/);
  assert.match(paraPendente[1], /liberado_em = NULL/);
  assert.match(paraPendente[1], /pronto_retirada_em = NULL/);
});

test("liberar mais do que o solicitado é permitido, com aviso", () => {
  // Regra de negócio: o almoxarifado pode liberar acima do pedido; o sistema só registra e avisa
  assert.match(routes, /if \(qty > requestedQty\) \{\s*\n\s*excedentes\.push/);
  assert.doesNotMatch(routes, /A quantidade liberada não pode ser maior que a solicitada/);
  assert.doesNotMatch(app, /A quantidade liberada não pode ser maior que a solicitada/);
  // Nenhum dos campos de liberação pode voltar a limitar pelo solicitado
  assert.doesNotMatch(app, /class="liberada release-qty-input" type="number" min="0" max=/);
  assert.match(routes, /send\(res, 200, \{ ok: true, excedentes \}\)/);
  assert.match(app, /produto\$\{excedentes\.length === 1 \? "" : "s"\} com liberação acima do solicitado/);
});

test("a quantidade liberada negativa continua recusada", () => {
  assert.match(routes, /A quantidade liberada não pode ser negativa/);
});

test("a sobra da liberação parcial não vira pendência, só informação", () => {
  // A retirada movimenta apenas o que foi liberado; a diferença fica registrada como aviso
  assert.match(routes, /const pendente = asInt\(row\.quantidade_solicitada\) - qty;/);
  assert.match(routes, /if \(pendente > 0\) sobras\.push/);
  assert.match(routes, /send\(res, 200, \{ ok: true, sobras, saldos_negativos: negativos \}\)/);
  assert.match(app, /não geram pendência|Não geram pendência/i);
  // Nada de pedido complementar nem saldo aberto
  assert.doesNotMatch(routes, /pedido_complementar/);
});

test("saldo central negativo avisa mas não bloqueia a retirada", () => {
  assert.match(routes, /RETURNING sku, nome, qtd_total/);
  assert.match(routes, /if \(saldo && asInt\(saldo\.qtd_total\) < 0\)/);
  assert.match(app, /Estoque central negativo em/);
  // A baixa continua acontecendo mesmo com saldo negativo
  assert.doesNotMatch(routes, /Estoque central insuficiente/);
});

test("toda mudança de etapa é registrada na auditoria", () => {
  assert.match(routes, /async function registrarAuditoriaStatus/);
  for (const acao of ["status_alterado_kanban", "status_alterado_painel", "retirada_confirmada"]) {
    assert.match(routes, new RegExp(`acao: "${acao}"`));
  }
  assert.match(routes, /\/api\/admin\/order-timeline/);
  // O relatório de edição abre em modal sob demanda pelo ícone de relógio, não embutido no painel
  assert.match(app, /function openReleaseTimelineModal/);
  assert.match(app, /order-panel-timeline-open/);
  assert.match(app, /order-panel-timeline-list/);
  assert.doesNotMatch(app, /function loadReleaseTimeline/);
  assert.doesNotMatch(app, /<section class="order-panel-timeline"/);
});

test("mudança de etapa é publicada no SSE sem tirar o fallback de polling", () => {
  const eventos = readFileSync(new URL("../server/services/order-alerts/order-alerts.events.js", import.meta.url), "utf8");
  assert.match(eventos, /export function publishOrderStatusChange/);
  assert.match(eventos, /ORDER_STATUS_CHANGED/);
  assert.match(routes, /publishOrderStatusChange\(\{/);
  const alerts = readFileSync(new URL("../public/js/services/order-alerts.js", import.meta.url), "utf8");
  assert.match(alerts, /addEventListener\("ORDER_STATUS_CHANGED"/);
  assert.match(alerts, /runAutoRefreshNow\(\)/);
  // O polling de fallback não pode ser removido
  assert.match(alerts, /startFallbackPolling/);
  const autoRefresh = readFileSync(new URL("../public/js/ui/auto-refresh.js", import.meta.url), "utf8");
  assert.match(autoRefresh, /export async function runAutoRefreshNow/);
});

test("as duas rotas de movimentação aceitam as mesmas transições", () => {
  const mapas = [...routes.matchAll(/"Aguardando Retirada": \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.equal(mapas.length, 2, "order-flow tem dois mapas de transição");
  for (const mapa of mapas) {
    assert.match(mapa, /"Pendente"/);
    assert.match(mapa, /"Em Andamento"/);
  }
});

test("reabrir e voltar de etapa limpa as datas de liberação", () => {
  assert.match(routes, /liberado_em = NULL,\s*\n\s*pronto_retirada_em = NULL,/);
  assert.match(routes, /em_andamento_em = CURRENT_TIMESTAMP, liberado_em = NULL, pronto_retirada_em = NULL/);
  assert.match(routes, /", em_andamento_em = NULL, liberado_em = NULL, pronto_retirada_em = NULL"/);
});

test("a finalização continua exigindo assinatura da retirada", () => {
  assert.match(routes, /Finalize o pedido pela confirmação de retirada com assinatura/);
  assert.match(routes, /A retirada só pode ser confirmada para produtos com quantidade liberada/);
  assert.match(routes, /A retirada deste pedido já foi confirmada/);
});

test("o quadro avisa quanto foi liberado ao mover o card", () => {
  assert.match(app, /Pedido movido para Aguardando Retirada com \$\{liberadoNoQuadro\} unidade\(s\) liberada\(s\)/);
});

test("excluir itens e adicionar produto atualizam o painel aberto, sem fechá-lo", () => {
  // As três edições de itens dentro do painel precisam refletir na hora, sem exigir fechar/reabrir
  assert.match(app, /async function refreshReleasePanelAfterEdit\(card, context = \{\}\) \{/);
  assert.match(app, /const overlay = card\?\.closest\("\.release-detail-overlay"\);/);

  const excluirSelecionadosStart = app.indexOf('root.querySelectorAll(".delete-selected-order-items")');
  const excluirItemStart = app.indexOf('root.querySelectorAll(".delete-order-item")');
  const confirmWithdrawalStart = app.indexOf('root.querySelectorAll(".confirm-order-withdrawal-open")');
  assert.ok(excluirSelecionadosStart > 0 && excluirItemStart > excluirSelecionadosStart && confirmWithdrawalStart > excluirItemStart, "handlers devem existir nesta ordem");

  const excluirSelecionados = app.slice(excluirSelecionadosStart, excluirItemStart);
  assert.match(excluirSelecionados, /await refreshReleasePanelAfterEdit\(card, \{ from, to, pdvId, q \}\)/);
  // O quadro ao fundo é sincronizado de forma leve (auto), sem recarregar a tela toda com o painel aberto
  assert.match(excluirSelecionados, /viewRelease\(\{ from, to, pdvId, q, status: activeStatus, auto: true \}\)/);

  const excluirItem = app.slice(excluirItemStart, confirmWithdrawalStart);
  assert.match(excluirItem, /await refreshReleasePanelAfterEdit\(card, \{ from, to, pdvId, q \}\)/);
  // A remoção manual do nó (que podia apagar o painel inteiro ao excluir o último item) foi removida
  assert.doesNotMatch(excluirItem, /card\.remove\(\)/);
  // O request agora fica dentro de um try/catch: antes um erro aqui não mostrava nenhum aviso ao usuário
  assert.match(excluirItem, /\} catch \(error\) \{\s*\n\s*toast\(error\.message \|\| "Não foi possível excluir o produto\."/);

  const adicionarProduto = app.slice(app.indexOf("function openAddAlmoxProductModal"), app.indexOf("function openAddAlmoxProductModal") + 10000);
  assert.match(adicionarProduto, /const atualizouPainel = await refreshReleasePanelAfterEdit\(card, filters\);/);
  assert.match(adicionarProduto, /viewRelease\(\{ \.\.\.filters, auto: true \}\)/);
});

test("pdv order creation reports item inválido/produto não liberado como 400, não 500", () => {
  // Antes essas duas validações lançavam Error sem statusCode e caíam no 500 genérico
  // (error.statusCode || 500) do handler global, poluindo o log como se fosse falha interna
  const pdvOrderBlock = routes.slice(
    routes.indexOf('if (url.pathname === "/api/pdv/order" && method === "POST")'),
    routes.indexOf('if (url.pathname === "/api/pdv/orders")')
  );
  const itemInvalido = pdvOrderBlock.match(/if \(!sku \|\| qty <= 0\) \{([\s\S]*?)\}/);
  assert.ok(itemInvalido, "validação de item inválido deve existir");
  assert.match(itemInvalido[1], /error\.statusCode = 400/);

  const produtoNaoLiberado = pdvOrderBlock.match(/if \(!allowed\.rows\[0\]\) \{([\s\S]*?)\}/);
  assert.ok(produtoNaoLiberado, "validação de produto não liberado deve existir");
  assert.match(produtoNaoLiberado[1], /error\.statusCode = 400/);
});

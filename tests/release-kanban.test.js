import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const routes = readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");

assert.match(app, /const releaseKanbanStatuses = \["Pendente", "Em Andamento", "Aguardando Retirada"\]/);
assert.match(app, /release-kanban-board/);
assert.match(app, /release-kanban-column/);
assert.match(app, /release-card-status-select/);
assert.match(app, /zone\.dataset\.dropBound === "true"/);
assert.match(app, /zone\.__releaseDropContext/);
assert.match(app, /board\.__releaseDraggedCard/);
assert.match(app, /lastInvalidMoveToast/);
assert.match(app, /data-release-view-mode="finalized"/);
assert.match(app, /release-finalized-view/);

// Painel do pedido em tela cheia
assert.match(app, /release-detail-overlay order-panel-overlay/);
assert.match(app, /has-order-panel/);
assert.match(app, /function releasePanelHtml/);
assert.match(app, /function releasePanelItemsTable/);
assert.match(app, /function releasePanelStepsHtml/);
assert.match(app, /function releasePanelStepHint/);
assert.match(app, /function releasePanelShell/);
assert.match(app, /function bindReleasePanel/);
assert.match(app, /function bindReleasePanelClose/);
assert.match(app, /loadReleaseOrderDetails/);
assert.match(app, /releaseAllowedTransitions/);
assert.match(app, /order-panel-primary/);
assert.match(app, /order-panel-close/);
assert.match(app, /order-panel-fill/);
assert.match(app, /Liberar tudo/);
assert.match(app, /Iniciar separação/);
assert.match(app, /Enviar para retirada/);
assert.match(app, /Finalizar com assinatura/);
assert.match(app, /Reabrir para edição/);

// O painel fecha apenas pelo X: nada de clique no fundo nem Escape
const abrirPainel = app.match(/async function openReleaseDetailPanel[\s\S]*?\r?\n\}/);
assert.ok(abrirPainel, "openReleaseDetailPanel deve existir");
assert.doesNotMatch(abrirPainel[0], /Escape/);
assert.doesNotMatch(abrirPainel[0], /event\.target === overlay/);
assert.match(abrirPainel[0], /bindReleasePanelClose\(overlay\)/);

// O painel reaproveita o contrato da tela de liberação em vez de embutir outro card
assert.match(app, /bindReleaseInteractions\(context\.from, context\.to, group\[0\]\?\.status \|\| "Pendente", panel, context\.pdvId, context\.q\)/);
assert.match(app, /function submitOrderFlow/);
assert.match(app, /const done = await submitOrderFlow\(button, context\)/);
// Ao avançar de etapa o painel se recarrega em vez de fechar: só o X fecha
assert.match(app, /if \(done\) await reloadReleasePanel\(overlay, orderCode, context\)/);
assert.match(app, /async function reloadReleasePanel/);
assert.match(app, /function renderReleasePanel/);
assert.match(app, /data-panel-flow="true"/);
assert.match(app, /updateReleaseBulkActions\(panel\)/);

// O visual antigo do painel foi descartado por completo
assert.doesNotMatch(app, /releaseControlPanelHtml/);
assert.doesNotMatch(app, /bindReleaseControlPanel/);
assert.doesNotMatch(app, /release-control-/);
assert.doesNotMatch(app, /release-detail-modal/);
assert.doesNotMatch(app, /release-detail-body/);
assert.doesNotMatch(styles, /\.release-control-/);
assert.doesNotMatch(styles, /\.release-detail-modal/);

// Ações rápidas nos cards do quadro
assert.match(app, /release-card-advance/);
assert.match(app, /release-card-finalize/);
assert.match(app, /Finalizar pedido/);
assert.match(app, /function openReleaseWithdrawalFlow/);
assert.match(app, /function finalizeReleaseOrder/);
assert.match(app, /first\.status === "Aguardando Retirada" && !first\.retirada_assinatura/);
assert.match(app, /openOrderWithdrawalModal/);
assert.match(app, /confirmOrderDeleteSystem/);
assert.match(app, /Visualizar/);
assert.match(app, /const orderCode = card\.dataset\.order \|\| ""/);
assert.match(app, /releaseKanbanStatuses\.filter\(\(nextStatus\) => nextStatus !== status\)/);
assert.match(app, /\/api\/admin\/orders\/status/);
assert.match(app, /function atualizarStatusPedido/);
assert.match(app, /const releaseKanbanOperations = new Map\(\)/);
assert.match(app, /const releaseKanbanKnownVersions = new Map\(\)/);
assert.match(app, /const releaseKanbanRecentStatuses = new Map\(\)/);
assert.match(app, /function beginReleaseKanbanOperation/);
assert.match(app, /function isCurrentReleaseKanbanOperation/);
assert.match(app, /function removeReleaseKanbanDuplicateCards/);
assert.match(app, /function placeReleaseKanbanCardOnce/);
assert.match(app, /function isStaleReleaseKanbanGroup/);
assert.match(app, /activeReleaseKanbanOperation\(orderId\)/);
assert.match(app, /activeReleaseKanbanOperation\(card\.dataset\.order \|\| ""\)/);
assert.match(app, /signal: operation\.controller\.signal/);
assert.match(app, /rememberReleaseKanbanState\(orderCode, nextStatus, optimisticVersion\)/);
assert.match(app, /groupsByOrder = new Map\(\)/);
assert.match(app, /statusByOrder = new Map\(\)/);
assert.match(app, /isStaleReleaseKanbanGroup\(orderId, group\)/);
assert.match(app, /new Set\(\[\.\.\.column\.querySelectorAll\("\.release-kanban-card"\)\]/);
assert.match(app, /expected_status: expectedStatusCode/);
assert.match(app, /status: nextStatusCode/);
assert.match(app, /PENDENTE/);
assert.match(app, /EM_ANDAMENTO/);
assert.match(app, /AGUARDANDO_RETIRADA/);
assert.match(app, /releaseStatusErrorMessage/);
assert.match(app, /httpStatus: error\?\.status/);
assert.match(app, /Pedido n[aã]o encontrado\. Atualize as solicitações para sincronizar o quadro\./);
assert.match(app, /Reinicie o servidor local ou atualize a versão publicada/);
assert.match(app, /\/api\/admin\/orders\?\$\{params\.toString\(\)\}/);
assert.doesNotMatch(app, /data-release-status="\$\{esc\(status\)\}" role="tab"/);
assert.doesNotMatch(app, /release-finalized-panel/);
assert.doesNotMatch(app, /load-finalized-release/);
assert.doesNotMatch(app, /Abrir detalhes/);
assert.doesNotMatch(app, /Clique em Visualizar para consultar os detalhes do pedido/);

// A tabela do painel mantém o contrato que os utilitários de liberação leem
assert.match(app, /class="bulk-order-item"/);
assert.match(app, /class="liberada release-qty-input"/);
assert.match(app, /class="release-product-name"/);
assert.match(app, /release-missing-cell/);
assert.match(app, /delete-order-item/);
assert.match(app, /delete-selected-order-items/);
assert.match(app, /save-release-draft/);
assert.match(app, /add-almox-product/);
assert.match(app, /data-selected-count/);
// Na leitura, Liberado precisa ser a última coluna: é dela que o comprovante lê as quantidades
assert.match(app, /\["Produto", "Estoque central", "Solicitado", "Liberado"\]/);

// Layout do painel: cabeçalho, corpo rolável e rodapé fixo em tela cheia
assert.match(styles, /body\.has-order-panel \{\s*overflow: hidden;/);
// O painel é centralizado e com tamanho limitado no desktop, não mais edge-to-edge
assert.match(styles, /\.release-detail-overlay \{[\s\S]*?display: grid;[\s\S]*?place-items: center;/);
assert.match(styles, /\.order-panel \{[\s\S]*?width: min\(1180px, 94vw\);[\s\S]*?height: min\(84vh, 780px\);[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) auto;/);
// No mobile volta a ocupar a tela inteira, onde a moldura só atrapalharia
assert.match(styles, /@media \(max-width: 720px\) \{\s*\/\* Em telas pequenas[\s\S]*?width: 100vw;\s*height: 100dvh;/);
assert.match(styles, /\.order-panel-content \{[\s\S]*?overflow: hidden;/);
assert.match(styles, /\.order-panel-content > \.table-wrap \{[\s\S]*?flex: 1 1 auto;/);
assert.match(styles, /\.order-panel-table thead th \{[\s\S]*?position: sticky;/);
assert.match(styles, /\.order-panel-foot \.btn\.danger \{[\s\S]*?background: transparent;/);

assert.match(routes, /\/api\/admin\/orders\/status/);
assert.match(routes, /expected_status/);
assert.match(routes, /function statusFromRequest/);
assert.match(routes, /PENDENTE: "Pendente"/);
assert.match(routes, /EM_ANDAMENTO: "Em Andamento"/);
assert.match(routes, /AGUARDANDO_RETIRADA: "Aguardando Retirada"/);
assert.match(routes, /FOR UPDATE/);
assert.match(routes, /statusCode = 409/);
assert.match(routes, /allowedTransitions/);
assert.match(routes, /\[\.\.\.kanbanStatuses\]\.map/);
assert.match(routes, /nextStatus !== status/);
assert.match(routes, /return send\(res, 422, \{ error: "Movimentação de status não permitida\." \}\), true/);
assert.match(routes, /expectedVersion/);
assert.match(routes, /status_alterado_kanban/);
assert.match(routes, /OFFSET \$8/);
assert.match(routes, /hasMore/);
assert.match(routes, /pedido_auditoria/);
assert.match(routes, /confirmation_code/);
assert.match(routes, /Exclusão bloqueada/);
assert.match(routes, /retirada_assinatura/);
assert.match(routes, /quantidade_liberada/);
const deleteRouteMatch = routes.match(/if \(method === "DELETE"\) \{[\s\S]*?send\(res, 200, \{ ok: true, total: deleted\.length \}\);/);
assert.ok(deleteRouteMatch, "delete route should be present");
assert.doesNotMatch(deleteRouteMatch[0], /UPDATE produtos SET qtd_total = qtd_total \+ \$1 WHERE sku = \$2/);
assert.doesNotMatch(deleteRouteMatch[0], /UPDATE estoque_pdv SET quantidade/);

console.log("release-kanban ok");

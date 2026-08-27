import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const rotas = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");
const alerts = fs.readFileSync("public/js/services/order-alerts.js", "utf8");

// ===== Junção de pedidos na janela =====

test("a junção só considera pedido com TODOS os itens em Pendente", () => {
  // Um pedido pode ficar em status misto (o painel move item a item). Se um único item já
  // saiu de Pendente, o Almoxarifado começou a separar e o pedido não pode mais crescer.
  assert.match(rotas, /HAVING bool_and\(status = 'Pendente'\)/);
});

test("a janela é contada do primeiro envio, não do último (não é deslizante)", () => {
  // Janela deslizante deixaria o pedido crescer indefinidamente, e o Almoxarifado nunca teria
  // certeza de que pode começar a separar.
  assert.match(rotas, /ORDER BY min\(criado_em\) ASC/);
  assert.match(rotas, /criado_em >= CURRENT_TIMESTAMP - \(\$2 \|\| ' minutes'\)::interval/);
});

test("a janela é configurável e tem padrão de 20 minutos", () => {
  assert.match(rotas, /JANELA_JUNCAO_MINUTOS = Number\(process\.env\.PEDIDO_JANELA_JUNCAO_MINUTOS \|\| 20\)/);
});

test("produto repetido soma na linha existente em vez de duplicar", () => {
  // Duas linhas do mesmo produto fariam o Almoxarifado separar o item duas vezes.
  assert.match(rotas, /SET quantidade_solicitada = quantidade_solicitada \+ \$2/);
  // FOR UPDATE evita que dois envios simultâneos leiam a mesma linha e uma soma se perca
  assert.match(rotas, /WHERE codigo_pedido = \$1 AND sku_produto = \$2 AND status = 'Pendente'[\s\S]{0,80}FOR UPDATE/);
});

test("juntar num pedido existente não dispara o alarme de pedido novo", () => {
  // O card já está na tela do Almoxarifado; repetir o som a cada envio viraria ruído.
  assert.match(rotas, /result\.juntouAoAnterior \? "ORDER_ITEMS_UPDATED" : "NEW_PENDING_ORDER"/);
});

test("o front atualiza a tela no evento novo, sem tocar alarme", () => {
  assert.match(alerts, /addEventListener\("ORDER_ITEMS_UPDATED"/);
  const bloco = alerts.slice(alerts.indexOf('addEventListener("ORDER_ITEMS_UPDATED"'), alerts.indexOf('addEventListener("ORDER_STATUS_CHANGED"'));
  assert.match(bloco, /runAutoRefreshNow\(\)/);
  // handleNewOrderEvent é o que dispara som/alerta visual de pedido novo — não pode ser chamado aqui
  assert.doesNotMatch(bloco, /handleNewOrderEvent/);
});

// ===== Edição pelo PDV =====

test("a rota de edição do PDV existe e é PATCH", () => {
  assert.match(rotas, /url\.pathname === "\/api\/pdv\/order-items" && method === "PATCH"/);
});

test("a edição exige que o pedido seja do próprio PDV", () => {
  // Não basta estar logado como PDV: precisa ser o dono do pedido.
  assert.match(rotas, /linhas\.rows\.some\(\(linha\) => linha\.pdv_id !== user\.pdvId\)/);
  assert.match(rotas, /Este pedido é de outro PDV/);
});

test("a edição é recusada se qualquer item já saiu de Pendente", () => {
  assert.match(rotas, /linhas\.rows\.some\(\(linha\) => normalizeOrderStatus\(linha\.status\) !== "Pendente"\)/);
  assert.match(rotas, /Almoxarifado já começou a separar este pedido/);
});

test("a checagem de dono e status roda antes de qualquer escrita", () => {
  const inicio = rotas.indexOf('url.pathname === "/api/pdv/order-items"');
  const trecho = rotas.slice(inicio, inicio + 3000);
  const posDono = trecho.indexOf("linha.pdv_id !== user.pdvId");
  const posStatus = trecho.indexOf('normalizeOrderStatus(linha.status) !== "Pendente"');
  const posUpdate = trecho.indexOf("UPDATE pedidos");
  const posDelete = trecho.indexOf("DELETE FROM pedidos");
  assert.ok(posDono > -1 && posStatus > -1);
  assert.ok(posDono < posUpdate && posDono < posDelete, "dono precisa ser checado antes de escrever");
  assert.ok(posStatus < posUpdate && posStatus < posDelete, "status precisa ser checado antes de escrever");
});

test("as linhas do pedido são travadas com FOR UPDATE durante a edição", () => {
  const inicio = rotas.indexOf('url.pathname === "/api/pdv/order-items"');
  const trecho = rotas.slice(inicio, inicio + 1200);
  assert.match(trecho, /FROM pedidos\s+WHERE codigo_pedido = \$1\s+ORDER BY id\s+FOR UPDATE/);
});

test("a edição do PDV fica registrada na auditoria", () => {
  assert.match(rotas, /acao: "pedido_editado_pdv"/);
});

test("/api/pdv/orders devolve o id do item, sem o qual a edição não teria o que referenciar", () => {
  assert.match(rotas, /SELECT p\.id, p\.version, p\.codigo_pedido/);
});

// ===== Tela do PDV =====

test("só o card Pendente ganha campos editáveis e botão de salvar", () => {
  const inicio = app.indexOf("function pdvOrderCard(group)");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /first\.status === "Pendente"/);
  assert.match(corpo, /pdv-item-qty/);
  assert.match(corpo, /pdv-save-order/);
  // Os controles ficam dentro do ramo de Pendente, antes dos ramos dos outros status
  const posPendente = corpo.indexOf('first.status === "Pendente"\n        ?');
  const posOutrosStatus = corpo.indexOf('["Aguardando Retirada", "Finalizado"].includes(first.status)');
  assert.ok(posPendente > -1 && posPendente < posOutrosStatus, "Pendente precisa ser o primeiro ramo");
});

test("o botão de salvar não carrega data-order (senão closest() acha o botão, não o card)", () => {
  // Bug real encontrado no teste de interface: com data-order no botão, closest("[data-order]")
  // devolvia o próprio botão, a lista de itens vinha vazia e [].every() dava a mensagem errada.
  assert.doesNotMatch(app, /class="btn pdv-save-order" type="button" data-order=/);
});

test("lista de itens vazia não é confundida com 'removeu tudo'", () => {
  const inicio = app.indexOf("async function salvarEdicaoPedidoPdv");
  const corpo = app.slice(inicio, inicio + 1600);
  const posVazio = corpo.indexOf("!items.length");
  const posTodosRemovidos = corpo.indexOf("items.every((item) => item.remover)");
  assert.ok(posVazio > -1, "precisa tratar lista vazia");
  assert.ok(posVazio < posTodosRemovidos, "a checagem de lista vazia precisa vir antes do every()");
});

test("a remoção só é aplicada ao salvar, permitindo desfazer", () => {
  const inicio = app.indexOf("function bindPdvOrderEdit");
  const corpo = app.slice(inicio, inicio + 1200);
  assert.match(corpo, /linha\.dataset\.remover = marcado \? "false" : "true"/);
  assert.match(corpo, /is-marked-remove/);
});

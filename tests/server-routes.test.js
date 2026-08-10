import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleEstoqueRoutes } from "../server/modules/estoque/estoque.routes.js";
import { handlePedidosRoutes } from "../server/modules/pedidos/pedidos.routes.js";
import { handleAvariasRoutes } from "../server/modules/avarias/avarias.routes.js";
import fs from "node:fs";

const pedidosRoutesSource = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");

function createResponse() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

function unauthorizedRequireUser(_req, res) {
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Login necessario." }));
  return null;
}

function contextFor(pathname, method = "GET", extra = {}) {
  return {
    method,
    requireUser: unauthorizedRequireUser,
    url: new URL(`http://localhost${pathname}`),
    user: null,
    ...extra
  };
}

function jsonRequest(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.headers = headers;
  return req;
}

test("estoque admin routes stay protected", async () => {
  const res = createResponse();
  const handled = await handleEstoqueRoutes({}, res, contextFor("/api/admin/stock"));

  assert.equal(handled, true);
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "Login necessario." });
});

test("pedidos admin routes stay protected", async () => {
  for (const [pathname, method] of [
    ["/api/admin/orders", "GET"],
    ["/api/admin/orders/status", "PATCH"],
    ["/api/admin/order-flow", "POST"],
    ["/api/admin/order-items", "DELETE"],
    ["/api/admin/history", "GET"]
  ]) {
    const res = createResponse();
    const handled = await handlePedidosRoutes({}, res, contextFor(pathname, method));

    assert.equal(handled, true, pathname);
    assert.equal(res.status, 401, pathname);
    assert.deepEqual(JSON.parse(res.body), { error: "Login necessario." }, pathname);
  }
});

test("avarias admin delete route stays protected", async () => {
  const res = createResponse();
  const handled = await handleAvariasRoutes({}, res, contextFor("/api/admin/avarias", "DELETE"));

  assert.equal(handled, true);
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "Login necessario." });
});

test("avarias admin delete requires an item or cancelled cleanup", async () => {
  const res = createResponse();
  const req = jsonRequest({});
  const handled = await handleAvariasRoutes(req, res, contextFor("/api/admin/avarias", "DELETE", {
    requireUser: () => ({ role: "admin", name: "Almoxarifado" }),
    user: { role: "admin", name: "Almoxarifado" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "Informe a devolução que deve ser excluída." });
});

test("pdv order creation rejects admin users before touching data", async () => {
  const res = createResponse();
  const handled = await handlePedidosRoutes({}, res, contextFor("/api/pdv/order", "POST", {
    user: { role: "admin", name: "Almoxarifado" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), { error: "Entre como PDV para solicitar produtos." });
});

test("pdv order creation requires idempotency key before touching data", async () => {
  const res = createResponse();
  const req = jsonRequest({
    solicitante: "Ruan",
    items: [{ sku: "1001", quantidade: 1 }]
  });
  const handled = await handlePedidosRoutes(req, res, contextFor("/api/pdv/order", "POST", {
    user: { role: "pdv", pdvId: 1, name: "PDV TESTE" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "Identificador da operação ausente. Atualize a página e tente novamente." });
});

test("admin order status route rejects status outside active kanban with 400", async () => {
  const res = createResponse();
  const req = jsonRequest({
    codigo_pedido: "PED-TESTE",
    expected_status: "PENDENTE",
    status: "FINALIZADO"
  });
  const handled = await handlePedidosRoutes(req, res, contextFor("/api/admin/orders/status", "PATCH", {
    requireUser: () => ({ role: "admin", name: "Almoxarifado" }),
    user: { role: "admin", name: "Almoxarifado" }
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { error: "Status ou pedido inválido." });
});

test("admin order status route uses free movement only between active statuses", () => {
  const routeMatch = pedidosRoutesSource.match(/if \(url\.pathname === "\/api\/admin\/orders\/status"[\s\S]*?send\(res, 200, \{ ok: true, \.\.\.result \}\);[\s\S]*?return true;/);
  assert.ok(routeMatch, "status route should be present");
  const routeSource = routeMatch[0];

  assert.match(routeSource, /new Set\(\["Pendente", "Em Andamento", "Aguardando Retirada"\]\)/);
  assert.match(routeSource, /Object\.fromEntries/);
  assert.match(routeSource, /\[\.\.\.kanbanStatuses\]\.map/);
  assert.match(routeSource, /nextStatus !== status/);
  assert.match(routeSource, /kanbanStatuses\.has\(expectedStatus\)/);
  assert.match(routeSource, /kanbanStatuses\.has\(nextStatus\)/);
  assert.doesNotMatch(routeSource, /Pendente:\s*\["Em Andamento"\]/);
  assert.doesNotMatch(routeSource, /"Liberação Parcial"|LIBERACAO_PARCIAL/);
});

test("admin order status route preserves saved quantities and products", () => {
  const routeMatch = pedidosRoutesSource.match(/if \(url\.pathname === "\/api\/admin\/orders\/status"[\s\S]*?send\(res, 200, \{ ok: true, \.\.\.result \}\);[\s\S]*?return true;/);
  assert.ok(routeMatch, "status route should be present");
  const routeSource = routeMatch[0];

  assert.match(routeSource, /SET status = \$1/);
  assert.match(routeSource, /version = COALESCE\(version, 1\) \+ 1/);
  assert.doesNotMatch(routeSource, /quantidade_solicitada\s*=/);
  assert.doesNotMatch(routeSource, /sku_produto\s*=/);
  // A quantidade já liberada pelo painel é preservada (limitada ao solicitado); só é preenchida
  // quando o card chega em Aguardando Retirada sem nenhuma liberação, e zerada ao voltar de etapa
  assert.match(routeSource, /WHEN COALESCE\(quantidade_liberada, 0\) > 0 THEN LEAST\(quantidade_liberada, quantidade_solicitada\)/);
  assert.match(routeSource, /ELSE quantidade_solicitada/);
  assert.equal((routeSource.match(/quantidade_liberada = 0/g) || []).length, 2);
});

test("pdv order quantity is not capped by maximum stock", () => {
  assert.doesNotMatch(pedidosRoutesSource, /Pedido acima do estoque maximo/);
  assert.doesNotMatch(pedidosRoutesSource, /current \+ qty > max/);
});

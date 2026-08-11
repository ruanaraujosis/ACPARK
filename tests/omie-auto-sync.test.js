import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { classifyOrigin } from "../server/services/integrations/omie/omie.mappers.js";
import { normalizePriority } from "../server/services/integrations/integration.service.js";
import { normalizeSyncScope } from "../server/services/integrations/omie/omie.sync.js";

const schema = fs.readFileSync("server/schema.sql", "utf8");
const sync = fs.readFileSync("server/services/integrations/omie/omie.sync.js", "utf8");
const scheduler = fs.readFileSync("server/services/integrations/omie/omie.scheduler.js", "utf8");
const client = fs.readFileSync("server/services/integrations/omie/omie.client.js", "utf8");
const routes = fs.readFileSync("server/modules/integrations/integrations.routes.js", "utf8");
const index = fs.readFileSync("server/index.js", "utf8");
const app = fs.readFileSync("public/app.js", "utf8");

test("scheduler automatico possui intervalos, cron e bloqueio de duplicidade", () => {
  assert.match(scheduler, /15_000/);
  assert.match(scheduler, /30_000/);
  assert.match(scheduler, /5 \* 60_000/);
  assert.match(scheduler, /10 \* 60_000/);
  assert.match(scheduler, /enqueueDueOmieJobs/);
  assert.match(scheduler, /runOmieSchedulerTick/);
  assert.match(index, /startOmieScheduler/);
  assert.match(index, /\/api\/cron\/omie-sync/);
  assert.match(fs.readFileSync("server/services/integrations/integration.service.js", "utf8"), /status IN \('PENDENTE', 'PROCESSANDO'/);
});

test("jobs possuem prioridade e processamento ordenado por prioridade", () => {
  assert.equal(normalizePriority("critica"), "CRITICA");
  assert.equal(normalizePriority("alta"), "ALTA");
  assert.equal(normalizePriority("invalida"), "NORMAL");
  assert.match(schema, /priority_rank INTEGER NOT NULL DEFAULT 50/);
  assert.match(sync, /ORDER BY priority_rank DESC, created_at/);
});

test("movimentos usam cursor, sobreposicao e criam saldo direcionado sem nova baixa", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_sync_state/);
  assert.match(sync, /last_success_at/);
  assert.match(sync, /INTERVAL '2 minutes'/);
  assert.match(sync, /enqueueStockRefresh/);
  assert.match(sync, /SYNC_OMIE_STOCK_ITEM/);
  assert.match(sync, /lista_produtos/);
  assert.doesNotMatch(sync, /IncluirMovimentoEstoque|AlterarProduto|IncluirProduto|ExcluirProduto/);
});

test("rate limit, circuit breaker e metricas estao no cliente OMIE", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_runtime_state/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS integration_metrics/);
  assert.match(client, /OMIE_LOCAL_RATE_LIMIT/);
  assert.match(client, /circuit_state = 'OPEN'/);
  assert.match(client, /omie_request_duration_ms/);
});

test("SSE e saude da integracao estao expostos para a interface", () => {
  assert.match(routes, /\/api\/admin\/integrations\/events/);
  assert.match(routes, /\/api\/admin\/integrations\/health/);
  assert.match(app, /new EventSource\(\"\/api\/admin\/integrations\/events\"\)/);
  assert.match(app, /stock\.updated/);
});

test("produtos sao classificados por temperatura operacional", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS product_sync_temperature/);
  assert.match(sync, /QUENTE/);
  assert.match(sync, /MORNO/);
  assert.match(sync, /FRIO/);
});

test("venda Orion importada continua sendo somente leitura", () => {
  assert.equal(classifyOrigin({ operacao: "12", cancelamento: "N", devolucao: "N" }), "ORION_VENDA");
  assert.equal(classifyOrigin({ operacao: "12", cancelamento: "S" }), "ORION_CANCELAMENTO");
  assert.equal(classifyOrigin({ operacao: "13", devolucao: "S" }), "ORION_DEVOLUCAO");
  assert.equal(normalizeSyncScope("saldo_item"), "SYNC_OMIE_STOCK_ITEM");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");
const pedidosRoutes = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");
const repo = fs.readFileSync("server/services/integrations/core/fator-conversao.repository.js", "utf8");

test("obterFatoresEmLote busca por lista de SKUs, não por linha (evita N+1)", () => {
  // Medido neste projeto: LEFT JOIN LATERAL por linha custava 98ms mesmo com índice dedicado
  // (o planejador preferia varredura por causa do ORDER BY externo); esta forma custa 1,6ms.
  const inicio = repo.indexOf("export async function obterFatoresEmLote");
  assert.ok(inicio > -1);
  const corpo = repo.slice(inicio, repo.indexOf("\n}\n", inicio));
  assert.match(corpo, /sku_produto = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(corpo, /JOIN LATERAL/, "não deveria ter voltado a fazer o join por linha");
});

test("GET /api/admin/orders anexa o fator de conversão em lote, depois da consulta principal", () => {
  assert.match(pedidosRoutes, /import \{ converterQuantidadeDoPedido, obterFatoresEmLote \}/);
  const posConsulta = pedidosRoutes.indexOf("LIMIT \\$7 OFFSET \\$8".replace(/\\/g, ""));
  const posFatores = pedidosRoutes.indexOf("obterFatoresEmLote(pool");
  assert.ok(posFatores > -1, "a rota deveria chamar obterFatoresEmLote");
  assert.ok(posFatores > posConsulta, "o fator precisa ser buscado depois da consulta principal de pedidos");
  assert.match(pedidosRoutes, /fator_conversao: info\.fator, fator_status: info\.status, embalagem: info\.embalagem/);
});

test("o índice de fator por SKU está no dump de estrutura versionado, não só em produção", () => {
  // Medido: 32,3ms sem índice -> 1,6ms com idx_mappings_sku_ativo (sku_produto) WHERE active.
  // Criar o índice só em produção não bastaria: db/estrutura.dump é a fonte da verdade para
  // instalação nova (ver DEPLOY_LOCAL.md) — sem regenerar o dump, todo cliente novo nasceria
  // sem o índice e a consulta voltaria a ser 20x mais lenta silenciosamente.
  const estrutura = fs.readFileSync("db/estrutura.sql", "utf8");
  assert.match(estrutura, /idx_mappings_sku_ativo/);
  assert.match(repo, /WHERE active = TRUE AND sku_produto = ANY/);
});

test("formatarSolicitadoEmbalagem deriva do liberado (unidades), não do solicitado original", () => {
  // Regra explícita do produto: a coluna "Solicitado" (em EMB) acompanha o que está sendo
  // liberado, não fica presa ao pedido original. Ex: liberar 15 un com fator 15 = "1,00 EMB".
  assert.match(app, /function formatarSolicitadoEmbalagem\(unidadesLiberadas, fator\)/);
  const corpo = app.slice(app.indexOf("function formatarSolicitadoEmbalagem"), app.indexOf("function formatarSolicitadoEmbalagem") + 300);
  assert.match(corpo, /toFixed\(2\)/);
  assert.match(corpo, /replace\("\.", ","\)/);
  assert.match(corpo, /EMB/);
});

// updateReleaseItemRowState é o único handler disparado em input/change de .liberada (também
// recalcula "Falta") — isola só o corpo dessa função para as próximas asserções
const inicioFn = app.indexOf("function updateReleaseItemRowState");
const fimFn = app.indexOf("\n}\n", inicioFn);
const corpoUpdateRowState = app.slice(inicioFn, fimFn);

test("a coluna Solicitado recalcula ao vivo a cada tecla em Liberar, no ponto único que já existe para Falta", () => {
  assert.match(corpoUpdateRowState, /formatarSolicitadoEmbalagem\(released, fator\)/);
  assert.match(corpoUpdateRowState, /requestedCell\?\.dataset\.fator/);
});

test("produto sem fator válido mantém Solicitado em unidades, sem quebrar Falta (que segue em unidades)", () => {
  assert.match(corpoUpdateRowState, /Number\.isSafeInteger\(fator\) && fator > 1/);
  // Falta continua calculada em unidades a partir de data-requested, não do texto formatado em EMB
  assert.match(corpoUpdateRowState, /parseQty\(row\.dataset\.requested \|\| requestedCell\?\.textContent\)/);
});

test("o painel do pedido e o card do Kanban aplicam a mesma regra (não duplicam lógica divergente)", () => {
  const ocorrencias = [...app.matchAll(/data-fator="\$\{fator/g)].length
    + [...app.matchAll(/data-fator="\$\{fatorKanban/g)].length;
  assert.ok(ocorrencias >= 2, "as duas telas (painel do pedido e card do Kanban) precisam marcar data-fator");
  assert.match(app, /formatarSolicitadoEmbalagem\(released, fator\)/);
  assert.match(app, /formatarSolicitadoEmbalagem\(releasedQty, fatorKanban\)/);
});

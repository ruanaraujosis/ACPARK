import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildOmiePayload, omieRequestWithConfig, resolveOmieEndpointUrl } from "../server/services/integrations/omie/omie.client.js";
import { classifyOrigin, mapOmieMovement, mapOmieProduct, mapOmieStock } from "../server/services/integrations/omie/omie.mappers.js";
import { normalizeSyncScope } from "../server/services/integrations/omie/omie.sync.js";

const syncSource = fs.readFileSync("server/services/integrations/omie/omie.sync.js", "utf8");
const productsSource = fs.readFileSync("server/services/integrations/omie/omie.products.js", "utf8");
const routesSource = fs.readFileSync("server/modules/integrations/integrations.routes.js", "utf8");
const schemaSource = fs.readFileSync("server/schema.sql", "utf8");
const appSource = fs.readFileSync("public/app.js", "utf8");

test("cliente OMIE monta payload sem expor segredo no retorno", async () => {
  const payload = buildOmiePayload({ call: "ListarProdutos", params: { pagina: 1 }, appKey: "key-real", appSecret: "secret-real" });
  assert.deepEqual(payload, { call: "ListarProdutos", app_key: "key-real", app_secret: "secret-real", param: [{ pagina: 1 }] });

  const response = await omieRequestWithConfig({
    loaded: {
      integration: { id: 1, provedor: "OMIE", ativo: true, url_base: "https://app.omie.com.br/api/v1" },
      secrets: { app_key: "key-real", app_secret: "secret-real" }
    },
    endpoint: "/geral/produtos/",
    call: "ListarProdutos",
    params: { pagina: 1 },
    fetchImpl: async (url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({ pagina: 1, total_de_paginas: 1, produto_servico_cadastro: [] })
    })
  });
  assert.equal(response.call, "ListarProdutos");
  assert.equal(JSON.stringify(response).includes("secret-real"), false);
});

test("cliente OMIE aceita URL base generica ou endpoint especifico de produtos", () => {
  assert.equal(
    resolveOmieEndpointUrl("https://app.omie.com.br/api/v1", "/geral/produtos/"),
    "https://app.omie.com.br/api/v1/geral/produtos/"
  );
  assert.equal(
    resolveOmieEndpointUrl("https://app.omie.com.br/api/v1/geral/produtos/", "/geral/produtos/"),
    "https://app.omie.com.br/api/v1/geral/produtos"
  );
});

test("cliente OMIE diferencia credencial ausente, integracao inativa e erro no corpo", async () => {
  await assert.rejects(
    () => omieRequestWithConfig({
      loaded: { integration: { provedor: "OMIE", ativo: false }, secrets: { app_key: "k", app_secret: "s" } },
      endpoint: "/geral/produtos/",
      call: "ListarProdutos"
    }),
    /inativa/i
  );
  await assert.rejects(
    () => omieRequestWithConfig({
      loaded: { integration: { provedor: "OMIE", ativo: true }, secrets: { app_key: "", app_secret: "" } },
      endpoint: "/geral/produtos/",
      call: "ListarProdutos"
    }),
    /Credenciais/
  );
  await assert.rejects(
    () => omieRequestWithConfig({
      loaded: { integration: { provedor: "OMIE", ativo: true, url_base: "https://app.omie.com.br/api/v1" }, secrets: { app_key: "k", app_secret: "s" } },
      endpoint: "/geral/produtos/",
      call: "ListarProdutos",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ faultstring: "app_key invalida" }) })
    }),
    /Credenciais/
  );
});

test("mapeadores preservam chave OMIE e nao classificam Orion sem evidencia", () => {
  const product = mapOmieProduct({ codigo_produto: 123, codigo: "SKU-1", descricao: "Coca-cola zero", unidade: "UN", info: { dAlt: "23/07/2026" } });
  assert.equal(product.externalId, "123");
  assert.equal(product.sku, "SKU-1");
  assert.equal(product.updatedAt, "2026-07-23 00:00:00");

  const stock = mapOmieStock({ codigo_produto: 123, codigo_local_estoque: 55, saldo: "10,5" });
  assert.equal(stock.quantity, 10.5);

  assert.equal(classifyOrigin({ descricao: "Saida de estoque sem referencia externa" }), "ORIGEM_NAO_IDENTIFICADA");
  assert.equal(classifyOrigin({ referencia: "ORION VENDA CUPOM 321" }), "ORION_VENDA");
  assert.equal(mapOmieMovement({ id_prod: 123, data: "23/07/2026", quantidade: 2, tipo_movimento: "S" }).operationType, "SAIDA");
});

test("sincronizacao de leitura nao possui chamadas de escrita no OMIE", () => {
  assert.match(syncSource, /SYNC_OMIE_PRODUCTS/);
  assert.match(syncSource, /SYNC_OMIE_LOCATIONS/);
  assert.match(syncSource, /SYNC_OMIE_STOCK/);
  assert.match(syncSource, /SYNC_OMIE_MOVEMENTS/);
  assert.match(syncSource, /RECONCILE_OMIE_STOCK/);
  assert.match(syncSource, /ultima_sincronizacao = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(syncSource, /IncluirMovimentoEstoque|AlterarProduto|IncluirProduto|ExcluirProduto/);
  assert.doesNotMatch(routesSource, /callOmie\(|OMIE_APP_KEY|OMIE_APP_SECRET/);
  assert.match(productsSource, /ListarProdutos/);
  assert.match(productsSource, /produto_servico_cadastro/);
  assert.match(productsSource, /sem_filtros_opcionais/);
  assert.match(productsSource, /somente_importados_api/);
  assert.match(productsSource, /OMIE respondeu a listagem de produtos, mas nao retornou produtos/);
  assert.match(syncSource, /CONCLUIDO_COM_ALERTAS/);
  assert.doesNotMatch(productsSource, /IncluirMovimentoEstoque|AlterarProduto|IncluirProduto|ExcluirProduto/);
});

test("schema e interface possuem leitura, mapeamento e reconciliacao sem ativar modo OMIE", () => {
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS omie_stock_locations/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS stock_reconciliation_items/);
  assert.match(schemaSource, /stock_mode TEXT NOT NULL DEFAULT 'MANUAL'/);
  assert.match(appSource, /Mapeamento PDV x local OMIE/);
  assert.match(appSource, /formatIntegrationJobResult/);
  assert.match(appSource, /recebidos/);
  assert.match(appSource, /Divergências de reconciliação/);
});

test("escopos de sincronizacao viram jobs especificos", () => {
  assert.equal(normalizeSyncScope("produtos"), "SYNC_OMIE_PRODUCTS");
  assert.equal(normalizeSyncScope("locais"), "SYNC_OMIE_LOCATIONS");
  assert.equal(normalizeSyncScope("saldos"), "SYNC_OMIE_STOCK");
  assert.equal(normalizeSyncScope("movimentos"), "SYNC_OMIE_MOVEMENTS");
  assert.equal(normalizeSyncScope("reconciliação"), "RECONCILE_OMIE_STOCK");
  assert.equal(normalizeSyncScope("completa"), "SYNC_OMIE_FULL");
});

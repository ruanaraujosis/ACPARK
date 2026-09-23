import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const routes = fs.readFileSync(new URL("../server/modules/inventarios/inventarios.routes.js", import.meta.url), "utf8");
const schema = fs.readFileSync(new URL("../server/modules/inventarios/inventarios.schema.js", import.meta.url), "utf8");
const ajuste = fs.readFileSync(new URL("../server/services/inventarios/ajuste-inventario.service.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("tabela nova e independente de pdv_categorias, criada em runtime", () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS inventario_categorias_liberadas/);
  assert.match(schema, /PRIMARY KEY \(pdv_id, categoria\)/);
});

test("PDV sem liberação vê o catálogo inteiro; com liberação, só as marcadas (no SQL)", () => {
  const filtro = routes.slice(routes.indexOf("const FILTRO_CATEGORIAS_LIBERADAS_PARA_CONTAGEM"), routes.indexOf("const SQL_PRODUTOS_DO_PDV"));
  assert.match(filtro, /NOT EXISTS \(SELECT 1 FROM inventario_categorias_liberadas lc WHERE lc\.pdv_id = e\.pdv_id\)/);
  assert.match(filtro, /lc\.categoria = prc\.categoria/);
  const sqlPdv = routes.slice(routes.indexOf("const SQL_PRODUTOS_DO_PDV"), routes.indexOf("const comClient"));
  assert.match(sqlPdv, /\$\{FILTRO_CATEGORIAS_LIBERADAS_PARA_CONTAGEM\}/);
  // O "sem contagem" do resumo também respeita o recorte
  const resumo = routes.slice(routes.indexOf("async function resumoDaContagem"), routes.indexOf("// ===== Aba INVENTÁRIOS"));
  assert.match(resumo, /FILTRO_CATEGORIAS_LIBERADAS_PARA_CONTAGEM/);
});

test("o servidor recusa SKU fora do recorte no salvamento parcial", () => {
  assert.match(routes, /async function exigirSkusDentroDoRecorte/);
  assert.match(routes, /await exigirSkusDentroDoRecorte\(client, user\.pdvId, itens\);/);
  assert.match(routes, /Produto fora das categorias liberadas para contagem/);
});

test("rotas do Almoxarifado: só admin, substituição atômica e recusa com contagem aberta", () => {
  const rota = routes.slice(routes.indexOf('"/api/admin/inventario/categorias-liberadas" && method === "GET"'), routes.indexOf('"/api/admin/inventario/relatorio/filtros"'));
  assert.equal((rota.match(/requireUser\(req, res, "admin"\)/g) || []).length, 2);
  assert.match(rota, /await tx\(/);
  assert.match(rota, /DELETE FROM inventario_categorias_liberadas WHERE pdv_id = \$1/);
  assert.match(rota, /inventarioAbertoDoPdv\(comClient\(client\), pdvId\)/);
  assert.match(rota, /categoria desconhecida|Categoria desconhecida/);
});

test("o ajuste continua sem tocar em produto não contado (recorte não zera nada)", () => {
  assert.match(ajuste, /if \(semContagem\) \{/);
  assert.match(ajuste, /preservados\.push/);
  assert.doesNotMatch(ajuste, /inventario_categorias_liberadas/);
});

test("tela do Almoxarifado tem o painel de categorias de contagem", () => {
  assert.match(app, /id="abrir-categorias-contagem"/);
  assert.match(app, /async function openCategoriasContagemModal/);
  assert.match(app, /\/api\/admin\/inventario\/categorias-liberadas/);
});

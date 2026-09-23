import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("server/services/integrations/providers/omie/tarefas/produtos.js", "utf8").split("\r\n").join("\n");
const gravarProduto = src.slice(src.indexOf("async function gravarProduto"), src.indexOf("// O vinculo usa a chave unica"));

test("produtoNovo é calculado uma vez, a partir da mesma consulta que decide criar ou atualizar", () => {
  assert.match(gravarProduto, /const produtoNovo = !existente\.rows\[0\];/);
});

test("o vínculo em produto_categorias só é gravado na criação do produto, nunca em atualização", () => {
  // Bug real: antes o INSERT rodava em TODO ciclo de sincronização (client existia ou não),
  // então uma remoção manual pela tela "Gerenciar categorias" era desfeita no próximo tick --
  // o INSERT só verifica "o vínculo existe?", nunca "alguém tirou de propósito?". Confirmado
  // com teste direto (DELETE seguido do mesmo INSERT reinseria a linha).
  const trechoVinculo = gravarProduto.slice(gravarProduto.indexOf("// A categoria tambem entra"));
  assert.match(trechoVinculo, /if \(categoria && produtoNovo\) \{/);
  assert.doesNotMatch(trechoVinculo, /if \(categoria\) \{/, "não pode voltar a rodar em toda sincronização, só na criação");
});

test("o branch de produto existente não muda -- só passou a usar produtoNovo em vez de existente.rows[0]", () => {
  const trechoExistente = gravarProduto.slice(gravarProduto.indexOf("if (!produtoNovo)"), gravarProduto.indexOf("} else {"));
  assert.match(trechoExistente, /categoria = COALESCE\(NULLIF\(categoria, ''\), \$4\)/, "o campo categoria singular continua só preenchendo quando vazio");
  assert.match(trechoExistente, /if \(!produto\.ativo\) return "desativado";/);
});

test("produto novo continua classificado automaticamente pela família da OMIE", () => {
  const trechoNovo = gravarProduto.slice(gravarProduto.indexOf("} else {"), gravarProduto.indexOf("// A categoria tambem entra"));
  assert.match(trechoNovo, /INSERT INTO produtos/);
  assert.match(trechoNovo, /\[produto\.sku, produto\.nome, produto\.ativo, categoria\]/);
});

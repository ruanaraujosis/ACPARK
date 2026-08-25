import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8");

test("embalagem é a unidade padrão ao adicionar produto com fator de conversão", () => {
  // unidadePadraoDoProduto decide o valor inicial de unidade_medida; precisa existir e ser
  // usada no lugar do "UNIDADE" fixo que havia antes em addProductToCart
  assert.match(app, /const unidadePadraoDoProduto = \(sku\) => \{/);
  assert.match(app, /unidade_medida: unidadePadraoDoProduto\(sku\)/);
  assert.doesNotMatch(
    app,
    /state\.cart\.push\(\{ sku, nome: product\.nome, quantidade: qty, unidade_medida: "UNIDADE" \}\)/,
    "addProductToCart não pode mais fixar UNIDADE — precisa consultar o fator do produto"
  );
});

test("produto sem fator confiável (inválido ou unitário) continua caindo em unidade", () => {
  const inicio = app.indexOf("const unidadePadraoDoProduto = (sku) => {");
  const trecho = app.slice(inicio, inicio + 250);
  assert.match(trecho, /invalido/);
  assert.match(trecho, /fator > 1/);
  assert.match(trecho, /"UNIDADE"/);
});

test("o rascunho salvo continua respeitando a unidade escolhida ao recarregar", () => {
  // Já existia essa proteção para o PDV não perder a escolha ao recarregar a página —
  // não pode virar sempre UNIDADE nem sempre EMBALAGEM ao restaurar o rascunho
  assert.match(app, /unidade_medida: item\.unidade_medida === "EMBALAGEM" \? "EMBALAGEM" : "UNIDADE"/);
});

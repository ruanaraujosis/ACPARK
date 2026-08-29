import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Inventário confirmado é imutável: não há reabertura nem lançamento compensatório.
// Corrigir uma contagem já confirmada é abrir um inventário NOVO.
//
// Decidido com o usuário em 29/08/2026. O motivo de não haver compensação está no tipo de
// escrita: o inventário grava SALDO ABSOLUTO (SLD), e saldo não compensa como movimento —
// dois SLD em sequência não se anulam, o segundo sobrescreve o primeiro, o que é
// indistinguível de uma recontagem.
//
// A verificação empírica (bater em todas as rotas de escrita com um inventário confirmado e
// conferir que nada muda) foi feita contra banco descartável: 11 tentativas, 0 brechas.
// Estes testes travam o que aquela verificação provou, para não regredir em silêncio.

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");
const rotas = ler("server/modules/inventarios/inventarios.routes.js");
const ajuste = ler("server/services/inventarios/ajuste-inventario.service.js");
const app = ler("public/app.js");
const docs = ler("docs/INTEGRACOES.md");

test("nenhuma rota reabre um inventário confirmado", () => {
  // Uma rota de reabertura seria o caminho que a decisão descarta. Se alguém criar uma,
  // este teste cai — e a decisão volta para a mesa em vez de escorregar para dentro.
  assert.doesNotMatch(rotas, /reabrir|reabertura/i, "não pode existir rota nem função de reabertura");
  assert.doesNotMatch(rotas, /compensa(r|cao|ção)/i, "o inventário não gera lançamento compensatório");
});

test("editar itens de um inventário confirmado é recusado", () => {
  assert.match(rotas, /Esta contagem já foi confirmada\. Para corrigir, abra um novo inventário\./);
  assert.match(rotas, /Esta contagem já foi concluída\. Para corrigir, abra um novo inventário\./);
});

test("assinar e confirmar duas vezes é recusado", () => {
  assert.match(rotas, /Este inventário já foi assinado/);
  assert.match(rotas, /Este inventário já foi concluído/);
  assert.match(rotas, /Só é possível confirmar uma contagem enviada/);
});

test("excluir um inventário confirmado é recusado", () => {
  // O ajuste já foi aplicado: apagar o registro deixaria o estoque sem explicação.
  assert.match(rotas, /Inventário confirmado não pode ser excluído: o ajuste já foi aplicado/);
});

test("o estado Confirmado não está entre os que aceitam escrita", () => {
  // A vaga do PDV é liberada por Confirmado justamente para o inventário novo poder abrir.
  const schema = ler("server/modules/inventarios/inventarios.schema.js");
  assert.doesNotMatch(schema, /STATUS_ABERTOS[\s\S]{0,200}CONFIRMADO/);
});

test("a tela mostra o confirmado como somente leitura e diz o caminho da correção", () => {
  const detalhe = app.slice(app.indexOf("async function abrirDetalheInventario"));
  assert.match(detalhe, /const editavel = inventario\.status === "Enviado"/);
  assert.match(detalhe, /Contagem confirmada\. Para corrigir, é preciso abrir um novo inventário\./);
});

test("a regra está documentada onde as demais regras de inventário estão", () => {
  // Sem isto vira dúvida de novo mais adiante — foi o motivo de a decisão ter sido reaberta.
  assert.match(ajuste, /CONFIRMADO É IMUTÁVEL/);
  assert.match(ajuste, /saldo não\s*\n?\/\/\s*compensa como movimento/);
  assert.match(docs, /Inventário confirmado é imutável — corrigir é contar de novo/);
  assert.match(docs, /saldo absoluto não compensa como\s*\n?movimento/);
});

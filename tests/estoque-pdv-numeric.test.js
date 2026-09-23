import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const migracao = fs.readFileSync(new URL("../tools/migrar-estoque-pdv-numeric.mjs", import.meta.url), "utf8");

test("migração de estoque_pdv.quantidade: só widening para NUMERIC, simulação por padrão", () => {
  assert.match(migracao, /ALTER TABLE estoque_pdv ALTER COLUMN quantidade TYPE NUMERIC USING quantidade::numeric/);
  assert.match(migracao, /process\.argv\.includes\("--executar"\)/);
});

test("a soma do saldo do PDV não arredonda para inteiro (saldo fracionário conta)", () => {
  assert.doesNotMatch(index, /SUM\(quantidade\), 0\)::int/);
  assert.match(index, /SUM\(quantidade\), 0\)::numeric AS total FROM estoque_pdv/);
  assert.match(index, /Number\(saldo\[0\]\.total\) > 0/);
});

test("saldo do PDV não é arredondado: SALDOS grava o valor exato e avarias lê com Number", () => {
  const saldos = fs.readFileSync(new URL("../server/services/integrations/providers/omie/tarefas/saldos.js", import.meta.url), "utf8");
  const avarias = fs.readFileSync(new URL("../server/modules/avarias/avarias.routes.js", import.meta.url), "utf8");
  assert.doesNotMatch(saldos, /Math\.round/);
  assert.match(saldos, /\[pdvId, sku, exato, exato\]/);
  assert.match(avarias, /const saldoAtual = Number\(stock\.rows\[0\]\.quantidade\) \|\| 0;/);
  assert.match(avarias, /const saldoAnterior = Number\(stock\.rows\[0\]\.quantidade\) \|\| 0;/);
});

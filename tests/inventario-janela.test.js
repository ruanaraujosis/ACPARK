import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { avaliarJanela, formatarDataBr, hojeEmSaoPaulo } from "../server/services/inventarios/janela-contagem.service.js";
import { STATUS_ABERTOS } from "../server/modules/inventarios/inventarios.schema.js";

const schema = fs.readFileSync("server/modules/inventarios/inventarios.schema.js", "utf8").split("\r\n").join("\n");

// ===== Janela de contagem =====

test("configuração ausente significa bloqueado, nunca liberado", () => {
  // Mesmo princípio do modo_escrita: ausência de configuração não pode virar permissão.
  const estado = avaliarJanela({});
  assert.equal(estado.liberado, false);
  assert.equal(estado.bloqueioManual, true);
  assert.ok(estado.motivo, "PDV precisa ver o motivo, não um formulário mudo");
});

test("valor desconhecido também conta como bloqueado", () => {
  for (const valor of ["", "talvez", "0", "sim", "TRUE"]) {
    assert.equal(avaliarJanela({ bloqueio: valor }).liberado, false, `"${valor}" não pode liberar`);
  }
});

test("só o valor explícito 'false' desliga o bloqueio manual", () => {
  assert.equal(avaliarJanela({ bloqueio: "false" }).liberado, true);
  assert.equal(avaliarJanela({ bloqueio: "FALSE" }).liberado, true);
});

test("a data agendada destrava sozinha no dia, mesmo com bloqueio manual ligado", () => {
  const agora = new Date("2026-09-15T14:00:00-03:00");
  const estado = avaliarJanela({ bloqueio: "true", agendamento: "2026-09-15", agora });
  assert.equal(estado.diaAgendado, true);
  assert.equal(estado.liberado, true);
});

test("fora do dia agendado volta a travar", () => {
  const agora = new Date("2026-09-16T09:00:00-03:00");
  const estado = avaliarJanela({ bloqueio: "true", agendamento: "2026-09-15", agora });
  assert.equal(estado.liberado, false);
  assert.match(estado.motivo, /15\/09\/2026/, "o motivo precisa dizer a data agendada");
});

test("a virada do dia usa o fuso de São Paulo, não o do servidor", () => {
  // 15/09 23:30 em São Paulo é 16/09 02:30 em UTC. Sem fixar o fuso, a contagem travaria
  // três horas antes da meia-noite local, no meio do expediente.
  const aindaDia15 = new Date("2026-09-16T02:30:00Z");
  assert.equal(hojeEmSaoPaulo(aindaDia15), "2026-09-15");
  assert.equal(avaliarJanela({ bloqueio: "true", agendamento: "2026-09-15", agora: aindaDia15 }).liberado, true);
});

test("data em formato de timestamp completo continua funcionando", () => {
  const agora = new Date("2026-09-15T10:00:00-03:00");
  assert.equal(avaliarJanela({ bloqueio: "true", agendamento: "2026-09-15T00:00:00.000Z", agora }).liberado, true);
});

test("formatarDataBr não inventa data a partir de valor vazio", () => {
  assert.equal(formatarDataBr(""), "");
  assert.equal(formatarDataBr(null), "");
  assert.equal(formatarDataBr("2026-09-15"), "15/09/2026");
});

// ===== Estrutura =====

test("quantidade contada aceita nulo e não tem default zero", () => {
  // Branco ≠ zero é a regra central do inventário: não contado não é tocado na OMIE,
  // contado como zero é zerado. Um DEFAULT 0 apagaria essa distinção em silêncio.
  // Recorta o CREATE TABLE antes de olhar a coluna: o comentário acima dela cita o mesmo
  // nome, e casar com o comentário deixaria o teste passar sem olhar o SQL de verdade.
  const criacao = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS inventario_itens"));
  const coluna = criacao.match(/^\s*quantidade_contada[^,\n]*/m)?.[0] || "";
  assert.match(coluna, /NUMERIC/);
  assert.doesNotMatch(coluna, /DEFAULT/, "quantidade_contada não pode ter DEFAULT");
  assert.doesNotMatch(coluna, /NOT NULL/, "quantidade_contada precisa aceitar NULL (não contado)");
});

test("um inventário aberto por PDV por vez, incluindo o do Almoxarifado", () => {
  // pdv_id nulo é o inventário do Almoxarifado; sem o COALESCE o índice único não o
  // restringiria, porque NULLs são distintos entre si no Postgres.
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_inventario_aberto_por_pdv/);
  assert.match(schema, /ON inventarios \(COALESCE\(pdv_id, -1\)\)/);
  // O WHERE é montado a partir de STATUS_ABERTOS, então a garantia está no valor da
  // constante, não no texto do arquivo — é ela que precisa cobrir os três status abertos.
  assert.match(schema, /WHERE status IN \('\$\{STATUS_ABERTOS\.join\("', '"\)\}'\)/);
  assert.deepEqual(STATUS_ABERTOS, ["Em contagem", "Enviado", "Aguardando assinatura"]);
});

test("o inventário confirmado não ocupa a vaga do PDV", () => {
  // Decisão do usuário: confirmado é imutável e corrigir é contar de novo. Se 'Confirmado'
  // entrasse na lista de status abertos, o PDV nunca conseguiria abrir o inventário seguinte.
  assert.doesNotMatch(schema, /STATUS_ABERTOS[\s\S]{0,200}CONFIRMADO/);
});

test("os itens somem junto com o inventário excluído", () => {
  assert.match(schema, /inventario_id INTEGER REFERENCES inventarios\(id\) ON DELETE CASCADE/);
});

test("a auditoria guarda valor anterior e novo", () => {
  assert.match(schema, /valor_anterior TEXT/);
  assert.match(schema, /valor_novo TEXT/);
  // Guarda o código também: a auditoria precisa sobreviver à exclusão do inventário
  assert.match(schema, /codigo_inventario TEXT/);
});

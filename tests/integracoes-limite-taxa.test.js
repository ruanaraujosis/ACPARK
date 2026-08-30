import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CODIGOS_ERRO, IntegrationError } from "../server/services/integrations/core/errors.js";
import { ehLimiteDeTaxa, segundosDeEspera } from "../server/services/integrations/core/pausa-integracao.js";
import { lerBloqueioPorConsumo } from "../server/services/integrations/providers/omie/omie.api.js";

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");

// Incidente de 29/08/2026: a OMIE bloqueou a conta por consumo excessivo e pediu para esperar
// até 1690s. O agendador tentava de novo em 5 minutos, ANTES do prazo, e cada tentativa
// renovava a punição — 50 chamadas bloqueadas por ciclo, indefinidamente, 387 lançamentos
// represados. Estes testes travam a correção que quebra esse laço.

test("a mensagem de bloqueio da OMIE é reconhecida e o prazo é lido", () => {
  const lido = lerBloqueioPorConsumo("ERROR: API bloqueada por consumo indevido. Tente novamente em 1690 segundos.");
  assert.equal(lido?.segundos, 1690);
  // Uma mensagem de negócio qualquer não pode virar bloqueio
  assert.equal(lerBloqueioPorConsumo("O saldo de estoque do produto poderá ficar negativo"), null);
  assert.equal(lerBloqueioPorConsumo(""), null);
});

test("bloqueio vira LIMITE_TAXA, não erro de dados", () => {
  // Classificar como DADOS estava errado: o payload nem foi olhado. E o código é o que
  // decide o destino do job.
  const api = ler("server/services/integrations/providers/omie/omie.api.js");
  const bloco = api.slice(api.indexOf("const bloqueio = lerBloqueioPorConsumo"));
  assert.match(bloco.slice(0, 500), /codigo: CODIGOS_ERRO\.LIMITE_TAXA/);
  assert.match(bloco.slice(0, 500), /retomarEmSegundos: bloqueio\.segundos/);
  // E vem ANTES da classificação genérica, senão nunca seria alcançado
  const posBloqueio = api.indexOf("const bloqueio = lerBloqueioPorConsumo");
  const posGenerico = api.indexOf("codigo: credencial ? CODIGOS_ERRO.AUTENTICACAO");
  assert.ok(posBloqueio < posGenerico, "o bloqueio precisa ser checado antes da classificação genérica");
});

test("o núcleo reconhece o pedido de espera sem saber de qual API veio", () => {
  const erro = new IntegrationError("qualquer coisa", {
    codigo: CODIGOS_ERRO.LIMITE_TAXA,
    detalhes: { retomarEmSegundos: 900 }
  });
  assert.equal(ehLimiteDeTaxa(erro), true);
  assert.equal(segundosDeEspera(erro), 900);
  assert.equal(ehLimiteDeTaxa(new IntegrationError("outro")), false);
  assert.equal(segundosDeEspera(new IntegrationError("outro")), null);
});

test("a pausa é da integração inteira, não da operação que falhou", () => {
  // Conferido no incidente: o bloqueio atingiu transferência, inventário e leitura de fatores
  // na mesma janela — é limite de conta, não de endpoint.
  const pausa = ler("server/services/integrations/core/pausa-integracao.js");
  assert.match(pausa, /export async function pausarIntegracao\(client, integrationId/);
  assert.doesNotMatch(pausa, /capacidade|scope|job_type/, "a pausa não é por operação");
});

test("duas esperas concorrentes ficam com a MAIOR, nunca com a menor", () => {
  // Encurtar a espera por uma resposta mais otimista foi o que manteve o laço vivo.
  const pausa = ler("server/services/integrations/core/pausa-integracao.js");
  assert.match(pausa, /half_open_after = GREATEST\(/);
});

test("o agendador não enfileira nada enquanto a pausa vale", () => {
  const sched = ler("server/services/integrations/core/scheduler.js");
  assert.match(sched, /const pausadaAte = await pausaAtiva\(client, integracao\.id\)/);
  // A checagem vem antes do laço de capacidades, senão enfileiraria mesmo pausado
  const posPausa = sched.indexOf("const pausadaAte = await pausaAtiva");
  const posLaco = sched.indexOf("for (const capacidade of provider.capacidades)");
  assert.ok(posPausa > -1 && posPausa < posLaco, "a pausa precisa ser checada antes das capacidades");
});

test("o núcleo da pausa continua agnóstico de provider", () => {
  // Teste de arquitetura do projeto já cobre a pasta core; aqui a checagem é do arquivo novo.
  const pausa = ler("server/services/integrations/core/pausa-integracao.js")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(pausa, /\bOMIE\b|app_key|bloqueada por consumo/i,
    "o núcleo não pode reconhecer a mensagem de uma API específica");
});

test("a tarefa para o lote ao levar bloqueio, em vez de queimar as chamadas restantes", () => {
  for (const arquivo of ["inventarios.js", "transferencias.js"]) {
    const src = ler(`server/services/integrations/providers/omie/tarefas/${arquivo}`);
    assert.match(src, /if \(ehLimiteDeTaxa\(erro\)\) \{/, `${arquivo}: precisa detectar o bloqueio`);
    assert.match(src, /await pausarIntegracao\(client, integracao\.id/, `${arquivo}: precisa registrar a pausa`);
    assert.match(src, /return resumo;/, `${arquivo}: precisa parar o lote`);
  }
});

// ===== Correção 3: FATORES não descarta mais a mensagem =====

test("FATORES guarda a mensagem real do erro", () => {
  const src = ler("server/services/integrations/providers/omie/tarefas/fatores.js");
  const bloco = src.slice(src.indexOf("resumo.falhas += 1;"));
  assert.match(bloco.slice(0, 600), /resumo\.erro = erro\?\.message \|\| String\(erro\)/);
  assert.match(bloco.slice(0, 600), /resumo\.erro_codigo = erro\?\.codigo/);
  // E o alerta mostra a causa em vez do texto genérico
  assert.match(src, /A leitura parou apos \$\{resumo\.lidos\} produto\(s\): \$\{resumo\.erro\}/);
});

// ===== Correção 4: a fila preserva causas distintas =====

test("cada causa distinta é preservada, sem apagar as anteriores", () => {
  // 10 dos 12 lançamentos recusados por saldo negativo tiveram a causa substituída por
  // "API bloqueada por consumo" — o diagnóstico só foi recuperado pelo que sobrou.
  const repo = ler("server/services/integrations/core/stock-launches.repository.js");
  assert.match(repo, /historico_erros = CASE/);
  assert.match(repo, /WHEN historico_erros @> jsonb_build_array\(jsonb_build_object\('erro', \$6::text\)\) THEN historico_erros/,
    "causa repetida não pode duplicar");
  assert.match(repo, /WHEN jsonb_array_length\(historico_erros\) >= 5 THEN historico_erros/,
    "precisa de teto para a coluna não crescer sem fim");
  // A coluna nasce em runtime, e o ensure é memoizado (a fila chama isto em laço)
  assert.match(repo, /ADD COLUMN IF NOT EXISTS historico_erros JSONB/);
  assert.match(repo, /historicoPronto \|\|=/);
});

test("`erro` continua sendo a causa mais recente, para a tela não mudar", () => {
  const repo = ler("server/services/integrations/core/stock-launches.repository.js");
  assert.match(repo, /erro = \$6,/);
});

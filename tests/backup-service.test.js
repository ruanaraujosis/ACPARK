import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Testes estaticos do servico de backup/restauracao -- nao tocam em banco nenhum. A prova real
// contra um banco descartavel fica em npm run backup:validar-restauracao (fora da suite regular
// porque exige CREATEDB e um arquivo de backup gerado).
const servico = fs.readFileSync("server/services/backup/backup.service.js", "utf8");
const runtimeSchema = fs.readFileSync("server/services/backup/runtime-schema.service.js", "utf8");

test("validarArquivoBackup confere assinatura magica antes de qualquer conexao com banco", () => {
  assert.match(servico, /PGDMP/);
  assert.match(servico, /export function validarArquivoBackup/);
  // A checagem de assinatura precisa vir antes de qualquer 'new pg.Client' no arquivo
  const posAssinatura = servico.indexOf("PGDMP");
  const posPrimeiraConexao = servico.indexOf("new pg.Client");
  assert.ok(posAssinatura < posPrimeiraConexao, "validacao de arquivo deve rodar antes de abrir conexao");
});

test("restaurarBackup exige confirmacao explicita quando o destino ja tem dados", () => {
  assert.match(servico, /DESTINO_TEM_DADOS/);
  assert.match(servico, /confirmarSobrescrita/);
  assert.match(servico, /if \(estado\.temDados && !confirmarSobrescrita\)/);
});

test("restaurarBackup reatribui a propriedade de tabelas e sequences apos restaurar", () => {
  assert.match(servico, /ALTER TABLE public\.\$\{t\.tablename\} OWNER TO \$\{conexao\.usuario\}/);
  assert.match(servico, /ALTER SEQUENCE public\.\$\{s\.sequencename\} OWNER TO \$\{conexao\.usuario\}/);
});

test("restaurarBackup chama ensureAllRuntimeTables quando fornecido", () => {
  assert.match(servico, /ensureAllRuntimeTables/);
  assert.match(servico, /typeof ensureAllRuntimeTables === "function"/);
});

test("a senha nunca vai na linha de comando do pg_restore", () => {
  assert.match(servico, /PGPASSWORD/);
  assert.doesNotMatch(servico, /conexao\.senha.*args\.push|args\.push.*conexao\.senha/);
});

test("runtime-schema.service centraliza todas as rotinas ensureXxxTable conhecidas", () => {
  for (const fn of [
    "ensurePedidoIdempotencyTable",
    "ensurePedidoDraftTable",
    "ensurePedidoEditColumns",
    "ensurePedidoAuditTable",
    "ensureAvariaColumns",
    "ensureAvariaIdempotencyTable",
    "ensureOrderAlertTables"
  ]) {
    assert.match(runtimeSchema, new RegExp(fn), `${fn} deveria ser importada e chamada`);
  }
  assert.match(runtimeSchema, /export async function ensureAllRuntimeTables/);
});

test("as funcoes ensureXxxTable estao exportadas nos modulos de origem", () => {
  const pedidos = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");
  const avarias = fs.readFileSync("server/modules/avarias/avarias.routes.js", "utf8");
  const alerts = fs.readFileSync("server/modules/order-alerts/order-alerts.routes.js", "utf8");
  assert.match(pedidos, /export function ensurePedidoIdempotencyTable/);
  assert.match(pedidos, /export function ensurePedidoDraftTable/);
  assert.match(pedidos, /export function ensurePedidoEditColumns/);
  assert.match(pedidos, /export function ensurePedidoAuditTable/);
  assert.match(avarias, /export function ensureAvariaColumns/);
  assert.match(avarias, /export function ensureAvariaIdempotencyTable/);
  assert.match(alerts, /export function ensureOrderAlertTables/);
});

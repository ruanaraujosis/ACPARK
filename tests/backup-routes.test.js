import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleBackupRoutes } from "../server/modules/backup/backup.routes.js";
import { resolverCaminhoBackup, BackupError } from "../server/services/backup/backup.service.js";

function createResponse() {
  return {
    status: null,
    body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; }
  };
}

function unauthorizedRequireUser(_req, res) {
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Login necessario." }));
  return null;
}

function contextFor(pathname, method = "GET", extra = {}) {
  return {
    method,
    requireUser: unauthorizedRequireUser,
    url: new URL(`http://localhost${pathname}`),
    user: null,
    ...extra
  };
}

function jsonRequest(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.headers = {};
  return req;
}

test("todas as rotas de backup exigem admin autenticado", async () => {
  for (const [pathname, method] of [
    ["/api/admin/backup/listar", "GET"],
    ["/api/admin/backup/gerar", "POST"],
    ["/api/admin/backup/validar", "POST"],
    ["/api/admin/backup/destino-tem-dados", "GET"],
    ["/api/admin/backup/restaurar", "POST"]
  ]) {
    const res = createResponse();
    const handled = await handleBackupRoutes({}, res, contextFor(pathname, method));

    assert.equal(handled, true, pathname);
    assert.equal(res.status, 401, pathname);
    assert.deepEqual(JSON.parse(res.body), { error: "Login necessario." }, pathname);
  }
});

test("validar recusa arquivo inexistente com mensagem em portugues, sem vazar erro tecnico", async () => {
  const res = createResponse();
  const req = jsonRequest({ caminho: "backup-que-nao-existe.dump" });
  const handled = await handleBackupRoutes(req, res, contextFor("/api/admin/backup/validar", "POST", {
    requireUser: () => ({ role: "admin", name: "Almoxarifado" })
  }));

  assert.equal(handled, true);
  assert.equal(res.status, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.codigo, "ARQUIVO_INEXISTENTE");
  assert.match(body.error, /não encontrado/i);
  assert.doesNotMatch(body.error, /ENOENT|Error:|at Object/);
});

test("resolverCaminhoBackup recusa tentativa de escapar da pasta backups/ com ../", () => {
  assert.throws(
    () => resolverCaminhoBackup("../../../windows/system32/config.dump"),
    (e) => e instanceof BackupError && e.codigo === "ARQUIVO_INEXISTENTE"
  );
});

test("resolverCaminhoBackup aceita caminho absoluto (midia externa) e nome simples (dentro de backups/)", () => {
  const absoluto = resolverCaminhoBackup("D:\\pendrive\\meu-backup.dump");
  assert.equal(absoluto, "D:\\pendrive\\meu-backup.dump");

  const simples = resolverCaminhoBackup("meu-backup.dump");
  assert.match(simples, /backups[\\/]meu-backup\.dump$/);
});

test("rota de restaurar so chama pg_restore depois de checar confirmarSobrescrita -- nunca sobrescreve sem o flag", async () => {
  // Este teste e estatico (le o codigo-fonte), nao chama a rota de verdade contra banco nenhum --
  // a prova com banco real (temporario, nunca producao) esta em npm run backup:validar-restauracao.
  const fs = await import("node:fs");
  const src = fs.readFileSync("server/modules/backup/backup.routes.js", "utf8");
  assert.match(src, /confirmarSobrescrita: body\.confirmarSobrescrita === true/);
  const servico = fs.readFileSync("server/services/backup/backup.service.js", "utf8");
  assert.match(servico, /if \(estado\.temDados && !confirmarSobrescrita\)/);
});

test("erro de conflito (DESTINO_TEM_DADOS) responde 409, os demais respondem 400", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("server/modules/backup/backup.routes.js", "utf8");
  assert.match(src, /error\.codigo === "DESTINO_TEM_DADOS" \? 409 : 400/);
});

test("rota de restaurar so opera sobre o DATABASE_URL do proprio servidor, nunca um alvo arbitrario do cliente", async () => {
  // O corpo da requisicao nunca deve poder escolher para qual banco restaurar -- isso impediria
  // que a rota fosse usada para atacar outro banco na rede a partir de uma sessao admin comprometida.
  const fs = await import("node:fs");
  const src = fs.readFileSync("server/modules/backup/backup.routes.js", "utf8");
  assert.match(src, /databaseUrlDestino: process\.env\.DATABASE_URL/);
  assert.doesNotMatch(src, /databaseUrlDestino: body\./);
});

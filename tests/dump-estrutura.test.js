import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// O dump de estrutura e a fonte da verdade para instalacoes novas (o schema.sql e legado).
// Estes testes sao estaticos: nao tocam em banco nenhum, so conferem o arquivo versionado.
const dumpBinario = "db/estrutura.dump";
const dumpTexto = "db/estrutura.sql";

test("o dump de estrutura esta versionado no repositorio", () => {
  assert.ok(fs.existsSync(dumpBinario), "db/estrutura.dump deveria existir (rode: npm run dump:gerar)");
  assert.ok(fs.existsSync(dumpTexto), "db/estrutura.sql deveria existir (rode: npm run dump:gerar)");
  assert.ok(fs.statSync(dumpBinario).size > 50_000, "dump binario parece truncado");
});

test("o dump contem estrutura e nenhum dado", () => {
  const sql = fs.readFileSync(dumpTexto, "utf8");
  // Nenhuma linha de dados: o instalador restaura estrutura, os dados vem do assistente ou de backup
  assert.doesNotMatch(sql, /^INSERT INTO/m, "o dump nao pode conter INSERT (deveria ser --schema-only)");
  assert.doesNotMatch(sql, /^COPY .* FROM stdin/m, "o dump nao pode conter COPY (deveria ser --schema-only)");
  // Sem dono fixo: a propriedade e reatribuida na restauracao para o usuario da instalacao
  assert.doesNotMatch(sql, /^ALTER TABLE .* OWNER TO/m, "o dump deveria ser gerado com --no-owner");
});

test("o dump cobre as tabelas que o schema.sql nao cobre", () => {
  const sql = fs.readFileSync(dumpTexto, "utf8");
  const noDump = new Set(
    [...sql.matchAll(/^CREATE TABLE (?:public\.)?(\w+)/gim)].map((m) => m[1])
  );
  // Tabelas criadas em runtime por ensureXxxTable(), ausentes do schema.sql
  for (const tabela of ["pedido_auditoria", "pedido_rascunhos", "order_alert_sounds", "pedido_idempotencia"]) {
    assert.ok(noDump.has(tabela), `${tabela} deveria estar no dump (e criada em runtime, nao esta no schema.sql)`);
  }
  // Tabelas centrais do sistema
  for (const tabela of ["pedidos", "produtos", "pdvs", "estoque_pdv", "categorias"]) {
    assert.ok(noDump.has(tabela), `${tabela} deveria estar no dump`);
  }
  const schemaSql = fs.readFileSync("server/schema.sql", "utf8");
  const noSchema = new Set(
    [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1])
  );
  assert.ok(
    noDump.size > noSchema.size,
    `o dump (${noDump.size} tabelas) deveria cobrir mais que o schema.sql (${noSchema.size}) -- ele e a fonte da verdade`
  );
});

test("as ferramentas de dump existem e nao expoem senha na linha de comando", () => {
  for (const arquivo of ["tools/gerar-dump-estrutura.mjs", "tools/validar-dump-estrutura.mjs"]) {
    assert.ok(fs.existsSync(arquivo), `${arquivo} deveria existir`);
    const src = fs.readFileSync(arquivo, "utf8");
    // A senha vai pelo ambiente do processo filho; nunca como argumento (fica visivel na lista de processos)
    assert.match(src, /PGPASSWORD/, `${arquivo} deveria passar a senha por PGPASSWORD`);
    assert.doesNotMatch(src, /--dbname["'\s]*,\s*bruta|postgres:\/\/\$\{/, `${arquivo} nao pode montar URL com senha nos argumentos`);
    // Carregamento de env pelo caminho correto do projeto
    assert.match(src, /import "\.\.\/server\/env\.js"/, `${arquivo} deveria usar server/env.js, nunca dotenv/config`);
  }
});

test("o dump versionado acompanha a estrutura declarada no repositorio", () => {
  const sql = fs.readFileSync(dumpTexto, "utf8");
  const noDump = new Set(
    [...sql.matchAll(/^CREATE TABLE (?:public\.)?(\w+)/gim)].map((m) => m[1])
  );
  // Toda tabela declarada no schema.sql precisa existir no dump; se nao existir, o dump esta velho
  const schemaSql = fs.readFileSync("server/schema.sql", "utf8");
  const noSchema = [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
  const faltando = noSchema.filter((t) => !noDump.has(t));
  assert.deepEqual(
    faltando, [],
    `tabelas do schema.sql ausentes do dump (regere com: npm run dump:gerar): ${faltando.join(", ")}`
  );
});

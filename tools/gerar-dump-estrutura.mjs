// Gera o dump de ESTRUTURA do banco (sem dados), versionado no repositorio.
// Esse dump e a fonte da verdade da estrutura para instalacoes novas -- o server/schema.sql
// e legado e nao cobre todas as tabelas que existem de fato em producao.
//
// Uso:
//   node tools/gerar-dump-estrutura.mjs            (gera db/estrutura.dump + db/estrutura.sql)
//   node tools/gerar-dump-estrutura.mjs --limpo    (exclui as tabelas mortas listadas abaixo)
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destino = path.join(raiz, "db");

// Tabelas sem nenhuma referencia no codigo (residuo de versoes antigas do sistema).
// So sao excluidas com a flag --limpo; por padrao o dump e fiel a producao.
const TABELAS_MORTAS = [
  "logs_atividades",
  "pedido_historico",
  "pedido_impressao_historico",
  "pedido_impressao_jobs",
  "pedido_operacao_idempotencia",
  "security_hardening_backup_privileges",
  "solicitacoes",
  "stock_refresh_queue",
  "vendas_orion"
];

// Localiza o pg_dump: primeiro no PATH, depois nos caminhos padrao do PostgreSQL no Windows
function acharPgDump() {
  const noPath = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
  if (noPath.status === 0) return "pg_dump";
  for (const versao of ["18", "17", "16", "15"]) {
    const alvo = `C:\\Program Files\\PostgreSQL\\${versao}\\bin\\pg_dump.exe`;
    if (fs.existsSync(alvo)) return alvo;
  }
  throw new Error("pg_dump nao encontrado. Instale o PostgreSQL ou adicione a pasta bin ao PATH.");
}

// Quebra a DATABASE_URL em partes; a senha vai por variavel de ambiente, nunca na linha de comando
function lerConexao() {
  const bruta = process.env.DATABASE_URL;
  if (!bruta) throw new Error("DATABASE_URL ausente. Confira o .env.local.");
  const url = new URL(bruta);
  return {
    host: url.hostname,
    porta: url.port || "5432",
    banco: decodeURIComponent(url.pathname.replace(/^\//, "")),
    usuario: decodeURIComponent(url.username),
    senha: decodeURIComponent(url.password)
  };
}

// Executa o pg_dump no formato pedido, gravando no arquivo de saida
function gerar(pgDump, conexao, formato, saida, excluir) {
  const args = [
    "--host", conexao.host,
    "--port", conexao.porta,
    "--username", conexao.usuario,
    "--dbname", conexao.banco,
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    "--format", formato,
    "--file", saida
  ];
  for (const tabela of excluir) args.push("--exclude-table", tabela);

  const resultado = spawnSync(pgDump, args, {
    encoding: "utf8",
    // A senha vai pelo ambiente do processo filho para nao aparecer na linha de comando
    env: { ...process.env, PGPASSWORD: conexao.senha }
  });
  if (resultado.status !== 0) {
    throw new Error(`pg_dump falhou (${formato}): ${resultado.stderr || resultado.error?.message || "erro desconhecido"}`);
  }
}

const limpo = process.argv.includes("--limpo");
const excluir = limpo ? TABELAS_MORTAS : [];
const pgDump = acharPgDump();
const conexao = lerConexao();

fs.mkdirSync(destino, { recursive: true });

const arquivoDump = path.join(destino, "estrutura.dump");
const arquivoSql = path.join(destino, "estrutura.sql");

// Formato custom: e o que o pg_restore consome na instalacao
gerar(pgDump, conexao, "custom", arquivoDump, excluir);
// Formato texto: serve para revisar a diferenca de estrutura no git (o custom e binario)
gerar(pgDump, conexao, "plain", arquivoSql, excluir);

// O pg_dump 17+ escreve um token aleatorio nas linhas \restrict/\unrestrict a cada execucao.
// Sem remover, toda regeracao suja o diff do Git mesmo sem mudanca de estrutura -- o que anula
// o motivo de versionar a versao em texto. O arquivo .sql serve so para revisao; quem restaura
// e o .dump (formato custom, via pg_restore), entao remover essas linhas daqui nao afeta nada.
function normalizarSql(arquivo) {
  const original = fs.readFileSync(arquivo, "utf8");
  const semToken = original
    .split(/\r?\n/)
    .filter((linha) => !/^\\(un)?restrict\s/.test(linha))
    .join("\n");
  const cabecalho = [
    "-- ATENCAO: arquivo gerado por tools/gerar-dump-estrutura.mjs (npm run dump:gerar).",
    "-- Serve apenas para revisar diferencas de estrutura no Git -- nao edite a mao.",
    "-- Para restaurar, use db/estrutura.dump com pg_restore (ver docs/DEPLOY_LOCAL.md).",
    ""
  ].join("\n");
  fs.writeFileSync(arquivo, cabecalho + semToken, "utf8");
}

normalizarSql(arquivoSql);

const tamanhoDump = fs.statSync(arquivoDump).size;
const sql = fs.readFileSync(arquivoSql, "utf8");
const tabelas = new Set([...sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)/gim)].map((m) => m[1]));
const sequences = new Set([...sql.matchAll(/^CREATE SEQUENCE (?:public\.)?(\w+)/gim)].map((m) => m[1]));
const indices = [...sql.matchAll(/^CREATE (?:UNIQUE )?INDEX/gim)].length;
const comRls = [...sql.matchAll(/ENABLE ROW LEVEL SECURITY/gi)].length;

console.log(JSON.stringify({
  modo: limpo ? "limpo (sem tabelas mortas)" : "fiel a producao",
  banco: conexao.banco,
  arquivos: {
    dump: path.relative(raiz, arquivoDump),
    sql: path.relative(raiz, arquivoSql)
  },
  tamanho_dump_kb: Math.round(tamanhoDump / 1024),
  tabelas: tabelas.size,
  sequences: sequences.size,
  indices,
  tabelas_com_rls: comRls,
  excluidas: excluir.length
}, null, 2));

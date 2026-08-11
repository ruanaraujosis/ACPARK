// Valida o dump de estrutura restaurando-o num banco temporario e conferindo o resultado.
// Cria e apaga o proprio banco de teste -- nao toca no banco de producao em momento algum.
//
// Uso: node tools/validar-dump-estrutura.mjs
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arquivoDump = path.join(raiz, "db", "estrutura.dump");

// Localiza um binario do PostgreSQL: primeiro no PATH, depois nos caminhos padrao no Windows
function acharBinario(nome) {
  if (spawnSync(nome, ["--version"], { encoding: "utf8" }).status === 0) return nome;
  for (const versao of ["18", "17", "16", "15"]) {
    const alvo = `C:\\Program Files\\PostgreSQL\\${versao}\\bin\\${nome}.exe`;
    if (fs.existsSync(alvo)) return alvo;
  }
  throw new Error(`${nome} nao encontrado no PATH nem na instalacao padrao do PostgreSQL.`);
}

// Quebra a DATABASE_URL; a senha e usada por variavel de ambiente, nunca na linha de comando
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

// Abre uma conexao avulsa num banco especifico (usa o pool nao serve: precisamos trocar de banco)
async function conectar(conexao, banco) {
  const cliente = new pg.Client({
    host: conexao.host,
    port: Number(conexao.porta),
    user: conexao.usuario,
    password: conexao.senha,
    database: banco,
    ssl: false
  });
  await cliente.connect();
  return cliente;
}

const conexao = lerConexao();
const pgRestore = acharBinario("pg_restore");
const bancoTeste = `myestoque_valida_${Date.now()}`;
const resultados = [];

// Registra o resultado de uma verificacao para o relatorio final
function checar(nome, condicao, detalhe = "") {
  resultados.push({ nome, ok: Boolean(condicao), detalhe });
}

if (!fs.existsSync(arquivoDump)) {
  throw new Error("db/estrutura.dump nao existe. Rode antes: node tools/gerar-dump-estrutura.mjs");
}

// Estrutura esperada, lida do banco de producao (somente leitura)
const producao = await conectar(conexao, conexao.banco);
const espTabelas = (await producao.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
const espSeq = (await producao.query("SELECT count(*)::int n FROM information_schema.sequences WHERE sequence_schema='public'")).rows[0].n;
const espRls = (await producao.query(
  "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relrowsecurity"
)).rows[0].n;
await producao.end();

const admin = await conectar(conexao, "postgres").catch(() => conectar(conexao, conexao.banco));
let cliente;

try {
  // 1. Cria o banco temporario
  await admin.query(`CREATE DATABASE ${bancoTeste}`);
  checar("Criar banco temporario", true, bancoTeste);

  // 2. Restaura o dump de estrutura
  const restore = spawnSync(pgRestore, [
    "--host", conexao.host,
    "--port", conexao.porta,
    "--username", conexao.usuario,
    "--dbname", bancoTeste,
    "--no-owner",
    "--no-privileges",
    arquivoDump
  ], { encoding: "utf8", env: { ...process.env, PGPASSWORD: conexao.senha } });
  checar("Restaurar dump sem erro", restore.status === 0, (restore.stderr || "").trim().split("\n").slice(0, 3).join(" | "));

  cliente = await conectar(conexao, bancoTeste);

  // 3. Confere se a estrutura bate com producao
  const tabelas = (await cliente.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
  checar("Contagem de tabelas confere", tabelas === espTabelas, `restaurado=${tabelas} producao=${espTabelas}`);

  const seq = (await cliente.query("SELECT count(*)::int n FROM information_schema.sequences WHERE sequence_schema='public'")).rows[0].n;
  checar("Contagem de sequences confere", seq === espSeq, `restaurado=${seq} producao=${espSeq}`);

  const rls = (await cliente.query(
    "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname='public' AND c.relrowsecurity"
  )).rows[0].n;
  checar("Estado de RLS preservado", rls === espRls, `restaurado=${rls} producao=${espRls}`);

  // 4. Reatribui a propriedade -- passo obrigatorio do instalador
  const donoAlvo = conexao.usuario;
  const tabsParaDono = (await cliente.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
  for (const t of tabsParaDono) {
    await cliente.query(`ALTER TABLE public.${t.tablename} OWNER TO ${donoAlvo}`);
  }
  const seqsParaDono = (await cliente.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")).rows;
  for (const s of seqsParaDono) {
    await cliente.query(`ALTER SEQUENCE public.${s.sequencename} OWNER TO ${donoAlvo}`);
  }
  const donosErrados = (await cliente.query(
    "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tableowner <> $1", [donoAlvo]
  )).rows[0].n;
  checar("Todas as tabelas com o dono correto", donosErrados === 0, `fora do padrao=${donosErrados}`);

  // 5. A armadilha do RLS: com RLS ligada e zero politicas, quem nao e dono nao le nada.
  //    Depois do passo 4 o usuario da aplicacao e dono, entao a leitura precisa funcionar.
  const rlsTabs = (await cliente.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND c.relrowsecurity AND c.relkind='r' ORDER BY c.relname`
  )).rows;
  let lidas = 0;
  for (const t of rlsTabs) {
    await cliente.query(`SELECT count(*) FROM public.${t.relname}`);
    lidas += 1;
  }
  checar("Tabelas com RLS legiveis pela aplicacao", lidas === rlsTabs.length, `${lidas}/${rlsTabs.length} legiveis`);

  // 6. As tabelas que o codigo cria em runtime precisam existir no dump
  const criticas = ["pedidos", "produtos", "pdvs", "pedido_auditoria", "pedido_rascunhos", "order_alert_sounds"];
  const presentes = (await cliente.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])", [criticas]
  )).rows.map((r) => r.tablename);
  checar("Tabelas criticas presentes", presentes.length === criticas.length,
    `${presentes.length}/${criticas.length}` + (presentes.length !== criticas.length
      ? " faltando: " + criticas.filter((c) => !presentes.includes(c)).join(", ") : ""));

  // 7. Banco restaurado nasce sem dado nenhum (instalacao nova comeca vazia)
  const pedidos = (await cliente.query("SELECT count(*)::int n FROM pedidos")).rows[0].n;
  checar("Banco restaurado esta vazio", pedidos === 0, `pedidos=${pedidos}`);
} finally {
  // Limpeza: derruba conexoes e apaga o banco de teste, aconteca o que acontecer
  if (cliente) await cliente.end().catch(() => {});
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [bancoTeste]
  ).catch(() => {});
  const apagou = await admin.query(`DROP DATABASE IF EXISTS ${bancoTeste}`).then(() => true).catch(() => false);
  checar("Banco temporario removido", apagou, bancoTeste);
  await admin.end().catch(() => {});
}

console.log("\n=== Validacao do dump de estrutura ===\n");
for (const r of resultados) {
  console.log(`${r.ok ? "OK  " : "FALHA"}  ${r.nome}${r.detalhe ? "  (" + r.detalhe + ")" : ""}`);
}
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificacoes passaram.`);
process.exit(falhas ? 1 : 0);

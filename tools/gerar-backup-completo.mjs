// Gera um backup COMPLETO do banco (estrutura + dados), usado para mover a operacao de maquina
// ou como rede de seguranca antes de uma mudanca de estrutura.
//
// O arquivo cai em backups/ (ignorado pelo Git -- contem dados reais de producao).
//
// Uso: node tools/gerar-backup-completo.mjs [--motivo "texto curto"]
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destino = path.join(raiz, "backups");

// Localiza o pg_dump: primeiro no PATH, depois nos caminhos padrao do PostgreSQL no Windows
function acharPgDump() {
  if (spawnSync("pg_dump", ["--version"], { encoding: "utf8" }).status === 0) return "pg_dump";
  for (const versao of ["18", "17", "16", "15"]) {
    const alvo = `C:\\Program Files\\PostgreSQL\\${versao}\\bin\\pg_dump.exe`;
    if (fs.existsSync(alvo)) return alvo;
  }
  throw new Error("pg_dump nao encontrado. Instale o PostgreSQL ou adicione a pasta bin ao PATH.");
}

// Quebra a DATABASE_URL; a senha vai por variavel de ambiente, nunca na linha de comando
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

// Carimbo de data/hora para o nome do arquivo, no formato AAAAMMDD-HHMMSS
function carimbo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const argMotivo = process.argv.indexOf("--motivo");
const motivo = argMotivo !== -1 ? (process.argv[argMotivo + 1] || "") : "";
const conexao = lerConexao();
const pgDump = acharPgDump();

fs.mkdirSync(destino, { recursive: true });
const arquivo = path.join(destino, `myestoque-${conexao.banco}-${carimbo()}.dump`);

// Totais antes do backup, para o resumo poder ser conferido na restauracao
const cliente = new pg.Client({
  host: conexao.host, port: Number(conexao.porta), user: conexao.usuario,
  password: conexao.senha, database: conexao.banco, ssl: false
});
await cliente.connect();
const contar = async (tabela) => {
  try {
    return (await cliente.query(`SELECT count(*)::int n FROM ${tabela}`)).rows[0].n;
  } catch {
    return null;
  }
};
const totais = {
  pedidos: await contar("pedidos"),
  produtos: await contar("produtos"),
  pdvs: await contar("pdvs"),
  tabelas: (await cliente.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n
};
await cliente.end();

// Backup completo em formato custom: e o que o pg_restore consome na maquina de destino
const resultado = spawnSync(pgDump, [
  "--host", conexao.host,
  "--port", conexao.porta,
  "--username", conexao.usuario,
  "--dbname", conexao.banco,
  "--format", "custom",
  "--no-owner",
  "--no-privileges",
  "--file", arquivo
], { encoding: "utf8", env: { ...process.env, PGPASSWORD: conexao.senha } });

if (resultado.status !== 0) {
  throw new Error(`pg_dump falhou: ${resultado.stderr || resultado.error?.message || "erro desconhecido"}`);
}

// Manifesto ao lado do backup: permite conferir na restauracao se os dados vieram completos
const manifesto = {
  gerado_em: new Date().toISOString(),
  banco: conexao.banco,
  arquivo: path.basename(arquivo),
  tamanho_mb: Number((fs.statSync(arquivo).size / 1024 / 1024).toFixed(2)),
  totais,
  motivo: motivo || null
};
fs.writeFileSync(arquivo.replace(/\.dump$/, ".json"), JSON.stringify(manifesto, null, 2), "utf8");

console.log(JSON.stringify({ ...manifesto, caminho_completo: arquivo }, null, 2));

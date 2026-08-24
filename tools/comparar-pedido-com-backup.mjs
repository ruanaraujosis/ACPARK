import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

// Compara um pedido entre um backup e o banco atual, para decidir se vale restaurar.
//
// SOMENTE LEITURA na producao: o backup e restaurado num banco temporario descartavel, que e
// apagado no fim. Nada e alterado no banco de producao por este script.
//
// Uso: node tools/comparar-pedido-com-backup.mjs <CODIGO_PEDIDO> [caminho-do-backup.dump]

const codigoPedido = process.argv[2];
if (!codigoPedido) {
  console.error("Informe o codigo do pedido. Ex: node tools/comparar-pedido-com-backup.mjs PED-20260821165642-757D");
  process.exit(1);
}

const raiz = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pastaBackups = path.join(raiz, "backups");

// Sem caminho informado, usa o backup mais recente
function backupMaisRecente() {
  const arquivos = fs
    .readdirSync(pastaBackups)
    .filter((n) => n.endsWith(".dump"))
    .sort();
  if (!arquivos.length) throw new Error("Nenhum backup encontrado em backups/");
  return path.join(pastaBackups, arquivos[arquivos.length - 1]);
}

const arquivoBackup = process.argv[3] ? path.resolve(process.argv[3]) : backupMaisRecente();

// Mesma busca de binario que o servico de backup usa
function acharBinario(nome) {
  if (spawnSync(nome, ["--version"], { encoding: "utf8" }).status === 0) return nome;
  for (const versao of ["18", "17", "16", "15"]) {
    const alvo = path.join("C:\\Program Files\\PostgreSQL", versao, "bin", `${nome}.exe`);
    if (fs.existsSync(alvo)) return alvo;
  }
  throw new Error(`${nome} nao encontrado no PATH nem na instalacao padrao do PostgreSQL.`);
}

const CAMPOS = [
  "sku_produto",
  "pdv_id",
  "quantidade_solicitada",
  "quantidade_liberada",
  "status",
  "solicitante",
  "observacao"
];

const SELECT = `SELECT id, ${CAMPOS.join(", ")}, criado_em
   FROM pedidos WHERE codigo_pedido = $1 ORDER BY id`;

const url = new URL(process.env.DATABASE_URL);
const conexao = {
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password)
};
const bancoProducao = url.pathname.slice(1);
const bancoTemp = `myestoque_cmp_${Date.now()}`;

const admin = new pg.Client({ ...conexao, database: "postgres" });
await admin.connect();

try {
  console.log(`Comparando ${codigoPedido}`);
  console.log(`  backup: ${path.basename(arquivoBackup)}`);
  console.log("");

  await admin.query(`CREATE DATABASE ${bancoTemp}`);
  const restore = spawnSync(
    acharBinario("pg_restore"),
    [
      "-h",
      conexao.host,
      "-p",
      String(conexao.port),
      "-U",
      conexao.user,
      "-d",
      bancoTemp,
      "--no-owner",
      "--no-privileges",
      arquivoBackup
    ],
    { env: { ...process.env, PGPASSWORD: conexao.password }, encoding: "utf8" }
  );
  if (restore.error) throw restore.error;

  const temp = new pg.Client({ ...conexao, database: bancoTemp });
  await temp.connect();
  const noBackup = (await temp.query(SELECT, [codigoPedido])).rows;
  await temp.end();

  const producao = new pg.Client({ ...conexao, database: bancoProducao });
  await producao.connect();
  const noBanco = (await producao.query(SELECT, [codigoPedido])).rows;
  await producao.end();

  console.log(`  itens no backup: ${noBackup.length}`);
  console.log(`  itens no banco : ${noBanco.length}`);
  console.log("");

  const porId = new Map(noBackup.map((linha) => [linha.id, linha]));
  const diferencas = [];

  for (const agora of noBanco) {
    const antes = porId.get(agora.id);
    if (!antes) {
      diferencas.push(`item ${agora.id} (${agora.sku_produto}): existe no banco, NAO existe no backup`);
      continue;
    }
    for (const campo of CAMPOS) {
      if (String(antes[campo] ?? "") !== String(agora[campo] ?? "")) {
        diferencas.push(
          `item ${agora.id} (${agora.sku_produto}): ${campo} era "${antes[campo]}", agora "${agora[campo]}"`
        );
      }
    }
    porId.delete(agora.id);
  }
  for (const sumiu of porId.values()) {
    diferencas.push(`item ${sumiu.id} (${sumiu.sku_produto}): estava no backup, SUMIU do banco`);
  }

  if (!diferencas.length) {
    console.log("  NENHUMA DIFERENCA -- o pedido no banco esta identico ao do backup.");
  } else {
    console.log(`  ${diferencas.length} diferenca(s):`);
    for (const linha of diferencas.slice(0, 60)) console.log(`    ${linha}`);
    if (diferencas.length > 60) console.log(`    ... e mais ${diferencas.length - 60}`);
  }

  if (noBanco.length) {
    const porStatus = {};
    for (const linha of noBanco) porStatus[linha.status] = (porStatus[linha.status] || 0) + 1;
    console.log("");
    console.log("  estado atual:", JSON.stringify(porStatus));
    console.log(
      "  solicitado:",
      noBanco.reduce((soma, l) => soma + Number(l.quantidade_solicitada || 0), 0),
      "| liberado:",
      noBanco.reduce((soma, l) => soma + Number(l.quantidade_liberada || 0), 0)
    );
  }
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${bancoTemp}`).catch(() => {});
  await admin.end();
  console.log("");
  console.log("banco temporario removido; nada foi alterado em producao.");
}

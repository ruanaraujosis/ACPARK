// Prova de ponta a ponta do servico de backup/restauracao (server/services/backup/*), usando
// SOMENTE um banco temporario descartavel -- nunca toca no banco de producao.
//
// Cobre: arquivo invalido e recusado, restauracao em banco vazio funciona, banco com dados exige
// confirmacao, sobrescrita com confirmacao funciona, reatribuicao de dono, tabelas com RLS ficam
// legiveis, ensureAllRuntimeTables recupera uma tabela de runtime que faltava, e limpeza final.
//
// Uso: node tools/validar-restauracao-backup.mjs [caminho-do-backup.dump]
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Aceita o caminho do backup por argumento; por padrao usa o mais recente em backups/
function acharBackupMaisRecente() {
  const dir = path.join(raiz, "backups");
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith(".dump")).map((f) => ({
    caminho: path.join(dir, f),
    mtime: fs.statSync(path.join(dir, f)).mtimeMs
  }));
  if (!arquivos.length) throw new Error("Nenhum backup encontrado em backups/. Rode: npm run backup:gerar");
  arquivos.sort((a, b) => b.mtime - a.mtime);
  return arquivos[0].caminho;
}
const arquivoBackup = process.argv[2] ? path.resolve(process.argv[2]) : acharBackupMaisRecente();

function acharBinario(nome) {
  if (spawnSync(nome, ["--version"], { encoding: "utf8" }).status === 0) return nome;
  for (const versao of ["18", "17", "16", "15"]) {
    const alvo = `C:\\Program Files\\PostgreSQL\\${versao}\\bin\\${nome}.exe`;
    if (fs.existsSync(alvo)) return alvo;
  }
  throw new Error(`${nome} nao encontrado.`);
}

function lerConexao() {
  const bruta = process.env.DATABASE_URL;
  if (!bruta) throw new Error("DATABASE_URL ausente. Confira o .env.local.");
  const url = new URL(bruta);
  return {
    host: url.hostname, porta: url.port || "5432",
    banco: decodeURIComponent(url.pathname.replace(/^\//, "")),
    usuario: decodeURIComponent(url.username), senha: decodeURIComponent(url.password)
  };
}

async function conectar(conexao, banco) {
  const cliente = new pg.Client({
    host: conexao.host, port: Number(conexao.porta), user: conexao.usuario,
    password: conexao.senha, database: banco, ssl: false
  });
  await cliente.connect();
  return cliente;
}

const conexao = lerConexao();
const bancoTeste = `myestoque_valida_restore_${Date.now()}`;
const databaseUrlTeste = `postgres://${conexao.usuario}:${encodeURIComponent(conexao.senha)}@${conexao.host}:${conexao.porta}/${bancoTeste}`;
const resultados = [];
function checar(nome, condicao, detalhe = "") {
  resultados.push({ nome, ok: Boolean(condicao), detalhe });
}

const admin = await conectar(conexao, "postgres").catch(() => conectar(conexao, conexao.banco));
let cliente;

try {
  await admin.query(`CREATE DATABASE ${bancoTeste}`);
  checar("Criar banco temporario", true, bancoTeste);

  // A partir daqui, tudo roda contra o banco de teste -- process.env.DATABASE_URL e trocado
  // ANTES de importar o servico (e a cadeia que leva a server/db.js), entao o pool interno do
  // servico nasce ja apontando para o banco temporario, nunca para producao.
  process.env.DATABASE_URL = databaseUrlTeste;
  const backupService = await import("../server/services/backup/backup.service.js");
  const { validarArquivoBackup, bancoDestinoTemDados, restaurarBackup, BackupError } = backupService;
  const { ensureAllRuntimeTables } = await import("../server/services/backup/runtime-schema.service.js");

  // 1. Arquivo inexistente e recusado
  try {
    validarArquivoBackup(path.join(raiz, "backups", "nao-existe.dump"));
    checar("Arquivo inexistente e recusado", false, "deveria ter lancado erro");
  } catch (e) {
    checar("Arquivo inexistente e recusado", e instanceof BackupError && e.codigo === "ARQUIVO_INEXISTENTE", e.codigo);
  }

  // 2. Arquivo muito pequeno (truncado) e recusado
  const arquivoCurto = path.join(raiz, "backups", "_teste_arquivo_truncado.dump");
  fs.writeFileSync(arquivoCurto, "PGDMP-curto-demais");
  try {
    validarArquivoBackup(arquivoCurto);
    checar("Arquivo truncado e recusado", false, "deveria ter lancado erro");
  } catch (e) {
    checar("Arquivo truncado e recusado", e instanceof BackupError && e.codigo === "ARQUIVO_TRUNCADO", e.codigo);
  } finally {
    fs.unlinkSync(arquivoCurto);
  }

  // 3. Arquivo com tamanho normal mas sem a assinatura magica do formato custom e recusado
  const arquivoFalso = path.join(raiz, "backups", "_teste_arquivo_invalido.dump");
  fs.writeFileSync(arquivoFalso, "isto nao e um backup valido, so um texto qualquer repetido para simular corrupcao real\n".repeat(5));
  try {
    validarArquivoBackup(arquivoFalso);
    checar("Arquivo com formato invalido e recusado", false, "deveria ter lancado erro");
  } catch (e) {
    checar("Arquivo com formato invalido e recusado", e instanceof BackupError && e.codigo === "FORMATO_INVALIDO", e.codigo);
  } finally {
    fs.unlinkSync(arquivoFalso);
  }

  // 3. Backup real e validado com sucesso
  const validacao = validarArquivoBackup(arquivoBackup);
  checar("Backup real e validado", validacao.valido && validacao.tabelasComDados > 0,
    `${validacao.tabelasComDados} tabelas com dados`);

  // 4. Banco vazio nao tem dados -- restauracao nao deveria exigir confirmacao
  const estadoAntes = await bancoDestinoTemDados(databaseUrlTeste);
  checar("Banco novo detectado como vazio", estadoAntes.temDados === false, `tabelas=${estadoAntes.tabelas}`);

  // 5. Restaura no banco vazio, sem confirmarSobrescrita. Nao passa ensureAllRuntimeTables aqui de
  // proposito: essas funcoes sao memoizadas por processo (ensurePedidoAuditTable etc. usam
  // `xxxReady ||= tx(...)`), entao a primeira chamada real fica reservada para o teste 6 abaixo --
  // chamar duas vezes no mesmo processo so provaria memoizacao, nao recriacao de verdade.
  const resultado1 = await restaurarBackup({
    caminhoArquivo: arquivoBackup,
    databaseUrlDestino: databaseUrlTeste
  });
  checar("Restauracao em banco vazio funciona sem confirmacao", resultado1.ok && !resultado1.sobrescreveu,
    JSON.stringify(resultado1.resumo));

  cliente = await conectar(conexao, bancoTeste);
  const producao = await conectar(conexao, conexao.banco);
  const tabelasProducao = (await producao.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
  const pedidosProducao = (await producao.query("SELECT count(*)::int n FROM pedidos")).rows[0].n;
  await producao.end();

  const tabelasRestauradas = (await cliente.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
  const pedidosRestaurados = (await cliente.query("SELECT count(*)::int n FROM pedidos")).rows[0].n;
  checar("Contagem de tabelas bate com a origem", tabelasRestauradas === tabelasProducao,
    `restaurado=${tabelasRestauradas} origem=${tabelasProducao}`);
  checar("Contagem de pedidos bate com a origem", pedidosRestaurados === pedidosProducao,
    `restaurado=${pedidosRestaurados} origem=${pedidosProducao}`);

  const donosErrados = (await cliente.query(
    "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tableowner <> $1", [conexao.usuario]
  )).rows[0].n;
  checar("Todas as tabelas com o dono correto apos restore", donosErrados === 0, `fora do padrao=${donosErrados}`);

  const rlsTabs = (await cliente.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND c.relrowsecurity AND c.relkind='r'`
  )).rows;
  let legiveis = 0;
  for (const t of rlsTabs) { await cliente.query(`SELECT count(*) FROM public.${t.relname}`); legiveis++; }
  checar("Tabelas com RLS legiveis apos restore", legiveis === rlsTabs.length, `${legiveis}/${rlsTabs.length}`);

  // 6. Simula um backup antigo: apaga uma tabela de runtime e confere que ensureAllRuntimeTables recupera
  await cliente.query("DROP TABLE IF EXISTS pedido_auditoria");
  const antesRecuperar = (await cliente.query(
    "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename='pedido_auditoria'"
  )).rows[0].n;
  checar("Tabela de runtime removida para simular backup antigo", antesRecuperar === 0);
  await ensureAllRuntimeTables();
  const depoisRecuperar = (await cliente.query(
    "SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename='pedido_auditoria'"
  )).rows[0].n;
  checar("ensureAllRuntimeTables recria tabela de runtime ausente", depoisRecuperar === 1);

  // 7. Restaurar de novo, agora com dados presentes, SEM confirmar -- deve ser recusado
  const estadoDepois = await bancoDestinoTemDados(databaseUrlTeste);
  checar("Banco com dados e detectado corretamente", estadoDepois.temDados === true, `tabelas=${estadoDepois.tabelas}`);
  try {
    await restaurarBackup({ caminhoArquivo: arquivoBackup, databaseUrlDestino: databaseUrlTeste });
    checar("Restauracao sem confirmacao e recusada quando ha dados", false, "deveria ter lancado erro");
  } catch (e) {
    checar("Restauracao sem confirmacao e recusada quando ha dados",
      e instanceof BackupError && e.codigo === "DESTINO_TEM_DADOS", e.codigo);
  }

  // 8. Restaurar de novo COM confirmacao -- deve funcionar e sobrescrever
  const resultado2 = await restaurarBackup({
    caminhoArquivo: arquivoBackup, databaseUrlDestino: databaseUrlTeste,
    confirmarSobrescrita: true
  });
  checar("Restauracao com confirmacao sobrescreve com sucesso", resultado2.ok && resultado2.sobrescreveu,
    JSON.stringify(resultado2.resumo));

  const tabelasFinal = (await cliente.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
  checar("Estrutura consistente apos sobrescrita", tabelasFinal === tabelasProducao, `final=${tabelasFinal}`);
} finally {
  process.env.DATABASE_URL = conexao ? undefined : process.env.DATABASE_URL;
  if (cliente) await cliente.end().catch(() => {});
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [bancoTeste]
  ).catch(() => {});
  const apagou = await admin.query(`DROP DATABASE IF EXISTS ${bancoTeste}`).then(() => true).catch(() => false);
  checar("Banco temporario removido", apagou, bancoTeste);
  await admin.end().catch(() => {});
}

console.log(`\n=== Validacao do servico de restauracao (arquivo: ${path.basename(arquivoBackup)}) ===\n`);
for (const r of resultados) console.log(`${r.ok ? "OK  " : "FALHA"}  ${r.nome}${r.detalhe ? "  (" + r.detalhe + ")" : ""}`);
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificacoes passaram.`);
process.exit(falhas ? 1 : 0);

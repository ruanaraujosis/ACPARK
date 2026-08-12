// Servico de validacao e restauracao de backup completo (estrutura + dados).
//
// Usado tanto pelo instalador (cenario "mesma operacao, maquina nova") quanto por qualquer
// interface futura (myestoqueConfig.exe) que precise restaurar sem passar por terminal.
//
// Todas as funcoes aqui operam sobre uma DATABASE_URL de DESTINO explicita, nunca sobre o pool
// global do servidor -- quem chama decide contra qual banco a operacao roda. Isso e o que permite
// testar restauracao de verdade contra um banco descartavel, sem tocar em producao.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raizProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Localiza um binario do PostgreSQL: primeiro no PATH, depois na instalacao padrao no Windows
function acharBinario(nome) {
  if (spawnSync(nome, ["--version"], { encoding: "utf8" }).status === 0) return nome;
  for (const versao of ["18", "17", "16", "15"]) {
    const alvo = `C:\\Program Files\\PostgreSQL\\${versao}\\bin\\${nome}.exe`;
    if (fs.existsSync(alvo)) return alvo;
  }
  throw new Error(`${nome} nao encontrado no PATH nem na instalacao padrao do PostgreSQL.`);
}

// Pasta onde os backups completos ficam (fora do Git -- contem dados reais de producao)
const pastaBackups = path.join(raizProjeto, "backups");

// Carimbo de data/hora para o nome do arquivo, no formato AAAAMMDD-HHMMSS
function carimbo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Quebra uma connection string em partes, sem nunca expor a senha em argumento de linha de comando
function quebrarConexao(databaseUrl) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    porta: url.port || "5432",
    banco: decodeURIComponent(url.pathname.replace(/^\//, "")),
    usuario: decodeURIComponent(url.username),
    senha: decodeURIComponent(url.password)
  };
}

// Erro com codigo estavel, para quem chama (rota HTTP, CLI) decidir a mensagem certa ao usuario
export class BackupError extends Error {
  constructor(codigo, mensagem, detalhe = null) {
    super(mensagem);
    this.name = "BackupError";
    this.codigo = codigo;
    this.detalhe = detalhe;
  }
}

// Valida o arquivo de backup SEM tocar em banco nenhum: confere assinatura, formato e conteudo.
// Sempre chamar antes de restaurar -- arquivo invalido/truncado precisa ser recusado cedo.
export function validarArquivoBackup(caminho) {
  if (!fs.existsSync(caminho)) {
    throw new BackupError("ARQUIVO_INEXISTENTE", "Arquivo de backup não encontrado.");
  }
  const tamanho = fs.statSync(caminho).size;
  if (tamanho < 100) {
    throw new BackupError("ARQUIVO_TRUNCADO", "Arquivo de backup parece truncado ou vazio.");
  }

  // Formato custom do pg_dump comeca sempre com a assinatura magica "PGDMP"
  const cabecalho = Buffer.alloc(5);
  const fd = fs.openSync(caminho, "r");
  fs.readSync(fd, cabecalho, 0, 5, 0);
  fs.closeSync(fd);
  if (cabecalho.toString("ascii") !== "PGDMP") {
    throw new BackupError(
      "FORMATO_INVALIDO",
      "Arquivo não é um backup válido do PostgreSQL (formato custom esperado, gerado por --format=custom)."
    );
  }

  const pgRestore = acharBinario("pg_restore");
  const listagem = spawnSync(pgRestore, ["--list", caminho], { encoding: "utf8" });
  if (listagem.status !== 0) {
    throw new BackupError(
      "ARQUIVO_ILEGIVEL",
      "Não foi possível ler o índice do backup. O arquivo pode estar corrompido ou ser de uma versão incompatível.",
      (listagem.stderr || "").trim().split("\n").slice(0, 3).join(" | ")
    );
  }

  const linhas = listagem.stdout.split("\n");
  const tabelasComDados = linhas.filter((l) => l.includes("TABLE DATA")).length;
  const totalTabelas = linhas.filter((l) => / TABLE /.test(l) && !l.includes("TABLE DATA")).length;

  if (tabelasComDados === 0) {
    throw new BackupError(
      "SEM_DADOS",
      "O arquivo não contém dados (parece ser um backup só de estrutura). Use a restauração de estrutura para este caso."
    );
  }

  return {
    valido: true,
    tamanhoBytes: tamanho,
    totalTabelas,
    tabelasComDados
  };
}

// Confere se o banco de destino ja tem dado -- usado para exigir confirmacao explicita antes de sobrescrever
export async function bancoDestinoTemDados(databaseUrlDestino) {
  const conexao = quebrarConexao(databaseUrlDestino);
  const cliente = new pg.Client({
    host: conexao.host, port: Number(conexao.porta), user: conexao.usuario,
    password: conexao.senha, database: conexao.banco, ssl: false
  });
  await cliente.connect();
  try {
    const tabelas = (await cliente.query(
      "SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'"
    )).rows[0].n;
    if (tabelas === 0) return { temDados: false, tabelas: 0 };
    // Existe estrutura -- confere se ha linhas em pelo menos uma tabela central
    const alvo = await cliente.query(
      `SELECT COALESCE((SELECT count(*) FROM pedidos), 0)
              + COALESCE((SELECT count(*) FROM produtos), 0)
              + COALESCE((SELECT count(*) FROM pdvs), 0) AS n`
    ).catch(() => ({ rows: [{ n: 0 }] }));
    return { temDados: Number(alvo.rows[0].n) > 0, tabelas };
  } finally {
    await cliente.end();
  }
}

// Restaura o backup no banco de destino. Se o destino ja tiver dados, exige confirmarSobrescrita=true
// (quem chama e responsavel por ter perguntado ao usuario antes). Reatribui a propriedade de todas
// as tabelas/sequences ao final -- passo obrigatorio, senao RLS herdado deixa tudo ilegivel.
export async function restaurarBackup({ caminhoArquivo, databaseUrlDestino, confirmarSobrescrita = false, ensureAllRuntimeTables }) {
  validarArquivoBackup(caminhoArquivo);

  const estado = await bancoDestinoTemDados(databaseUrlDestino);
  if (estado.temDados && !confirmarSobrescrita) {
    throw new BackupError(
      "DESTINO_TEM_DADOS",
      "O banco de destino já contém dados. Confirme explicitamente para sobrescrever.",
      estado
    );
  }

  const conexao = quebrarConexao(databaseUrlDestino);
  const pgRestore = acharBinario("pg_restore");

  const args = [
    "--host", conexao.host,
    "--port", conexao.porta,
    "--username", conexao.usuario,
    "--dbname", conexao.banco,
    "--no-owner",
    "--no-privileges"
  ];
  // --clean --if-exists derruba os objetos existentes antes de recriar, permitindo sobrescrever
  // um banco que ja tem estrutura sem precisar apagar o banco inteiro primeiro
  if (estado.temDados) args.push("--clean", "--if-exists");
  args.push(caminhoArquivo);

  const restore = spawnSync(pgRestore, args, {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: conexao.senha }
  });
  // pg_restore retorna status != 0 mesmo para avisos inofensivos (ex: objeto que nao existia
  // para o --clean apagar); só trata como falha real se nao restaurou nenhuma tabela
  const cliente = new pg.Client({
    host: conexao.host, port: Number(conexao.porta), user: conexao.usuario,
    password: conexao.senha, database: conexao.banco, ssl: false
  });
  await cliente.connect();
  let tabelasRestauradas = 0;
  try {
    tabelasRestauradas = (await cliente.query(
      "SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'"
    )).rows[0].n;
  } finally {
    await cliente.end();
  }

  if (tabelasRestauradas === 0) {
    throw new BackupError(
      "RESTAURACAO_FALHOU",
      "A restauração não recriou nenhuma tabela. O banco de destino não foi alterado de forma útil.",
      (restore.stderr || "").trim().split("\n").slice(0, 5).join(" | ")
    );
  }

  // Reatribui a propriedade de tabelas e sequences -- sem isso, RLS herdado deixa tudo ilegivel
  const clienteDono = new pg.Client({
    host: conexao.host, port: Number(conexao.porta), user: conexao.usuario,
    password: conexao.senha, database: conexao.banco, ssl: false
  });
  await clienteDono.connect();
  try {
    // Nomes de tabela/sequence vem do banco recem-restaurado, ou seja, do conteudo do arquivo de
    // backup -- que pode ter vindo de fora. Sem quoting, um dump com tabela chamada `x" ... --`
    // executaria SQL arbitrario aqui. escapeIdentifier faz o quoting correto do Postgres.
    const dono = clienteDono.escapeIdentifier(conexao.usuario);
    const tabelas = (await clienteDono.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
    for (const t of tabelas) {
      await clienteDono.query(`ALTER TABLE public.${clienteDono.escapeIdentifier(t.tablename)} OWNER TO ${dono}`);
    }
    const sequences = (await clienteDono.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public'")).rows;
    for (const s of sequences) {
      await clienteDono.query(`ALTER SEQUENCE public.${clienteDono.escapeIdentifier(s.sequencename)} OWNER TO ${dono}`);
    }
  } finally {
    await clienteDono.end();
  }

  // Garante as tabelas criadas em runtime, para o caso de o backup vir de uma versao anterior
  if (typeof ensureAllRuntimeTables === "function") {
    await ensureAllRuntimeTables();
  }

  // Resumo final para o usuario confirmar de imediato que os dados vieram
  const clienteResumo = new pg.Client({
    host: conexao.host, port: Number(conexao.porta), user: conexao.usuario,
    password: conexao.senha, database: conexao.banco, ssl: false
  });
  await clienteResumo.connect();
  let resumo;
  try {
    const contar = async (tabela) => {
      try { return (await clienteResumo.query(`SELECT count(*)::int n FROM ${tabela}`)).rows[0].n; }
      catch { return null; }
    };
    resumo = {
      tabelas: (await clienteResumo.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,
      pedidos: await contar("pedidos"),
      produtos: await contar("produtos"),
      pdvs: await contar("pdvs")
    };
  } finally {
    await clienteResumo.end();
  }

  return { ok: true, sobrescreveu: estado.temDados, resumo };
}

// Gera um backup completo (estrutura + dados) do banco indicado por databaseUrlOrigem, gravando em
// backups/ com um manifesto .json ao lado. Usado tanto pelo CLI (tools/gerar-backup-completo.mjs)
// quanto pela rota HTTP -- uma unica implementacao para os dois caminhos.
export async function gerarBackupCompleto({ databaseUrlOrigem, motivo = "" }) {
  const conexao = quebrarConexao(databaseUrlOrigem);
  const pgDump = acharBinario("pg_dump");

  fs.mkdirSync(pastaBackups, { recursive: true });
  const arquivo = path.join(pastaBackups, `myestoque-${conexao.banco}-${carimbo()}.dump`);

  const cliente = new pg.Client({
    host: conexao.host, port: Number(conexao.porta), user: conexao.usuario,
    password: conexao.senha, database: conexao.banco, ssl: false
  });
  await cliente.connect();
  let totais;
  try {
    const contar = async (tabela) => {
      try { return (await cliente.query(`SELECT count(*)::int n FROM ${tabela}`)).rows[0].n; }
      catch { return null; }
    };
    totais = {
      pedidos: await contar("pedidos"),
      produtos: await contar("produtos"),
      pdvs: await contar("pdvs"),
      tabelas: (await cliente.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n
    };
  } finally {
    await cliente.end();
  }

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
    throw new BackupError(
      "BACKUP_FALHOU",
      "Não foi possível gerar o backup.",
      (resultado.stderr || resultado.error?.message || "erro desconhecido").trim().split("\n").slice(0, 5).join(" | ")
    );
  }

  const manifesto = {
    gerado_em: new Date().toISOString(),
    banco: conexao.banco,
    arquivo: path.basename(arquivo),
    tamanho_mb: Number((fs.statSync(arquivo).size / 1024 / 1024).toFixed(2)),
    totais,
    motivo: motivo || null
  };
  fs.writeFileSync(arquivo.replace(/\.dump$/, ".json"), JSON.stringify(manifesto, null, 2), "utf8");

  return { ...manifesto, caminhoCompleto: arquivo };
}

// Lista os backups existentes em backups/, mais recente primeiro, com o manifesto de cada um
// quando disponivel -- usado pela tela de restauracao para o usuario escolher qual arquivo usar
export function listarBackups() {
  if (!fs.existsSync(pastaBackups)) return [];
  const arquivos = fs.readdirSync(pastaBackups).filter((f) => f.endsWith(".dump"));
  const itens = arquivos.map((nome) => {
    const caminhoCompleto = path.join(pastaBackups, nome);
    const caminhoManifesto = caminhoCompleto.replace(/\.dump$/, ".json");
    const stat = fs.statSync(caminhoCompleto);
    let manifesto = null;
    if (fs.existsSync(caminhoManifesto)) {
      try { manifesto = JSON.parse(fs.readFileSync(caminhoManifesto, "utf8")); } catch { manifesto = null; }
    }
    return {
      arquivo: nome,
      tamanhoMb: Number((stat.size / 1024 / 1024).toFixed(2)),
      modificadoEm: stat.mtime.toISOString(),
      manifesto
    };
  });
  return itens.sort((a, b) => new Date(b.modificadoEm) - new Date(a.modificadoEm));
}

// Resolve um nome de backup informado pelo usuario para um caminho absoluto seguro.
//
// So aceita arquivos dentro de backups/. Caminho absoluto arbitrario NAO e aceito: pela API HTTP
// isso daria a quem tem sessao de admin um oraculo de existencia/tamanho de qualquer arquivo do
// servidor (e ainda rodaria pg_restore --list sobre ele), que e acesso ao filesystem do host --
// coisa que admin do sistema nao deveria ter. Restaurar de outra midia (pendrive) e feito
// copiando o arquivo para backups/ antes.
export function resolverCaminhoBackup(caminhoOuNome) {
  if (!caminhoOuNome) {
    throw new BackupError("ARQUIVO_INEXISTENTE", "Informe o arquivo de backup.");
  }
  const resolvido = path.resolve(pastaBackups, caminhoOuNome);
  const relativo = path.relative(pastaBackups, resolvido);
  // relativo vazio = a propria pasta; comecando com ".." ou absoluto = escapou de backups/
  if (!relativo || relativo.startsWith("..") || path.isAbsolute(relativo)) {
    throw new BackupError("ARQUIVO_INEXISTENTE", "Caminho de backup inválido. Use um arquivo da pasta de backups.");
  }
  return resolvido;
}

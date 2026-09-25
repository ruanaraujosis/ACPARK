// Ambiente descartável para testes que precisam de banco e servidor de verdade.
//
// Cria um banco NOVO (myestoque_teste_<...>) a partir de db/estrutura.dump, sobe o
// server/index.js num processo filho numa porta livre apontando para ESSE banco, e no fim
// derruba o processo e apaga o banco. Nunca toca no banco de produção: a DATABASE_URL do
// .env.local só é usada para pegar host/usuário/senha e abrir a conexão administrativa
// (CREATE/DROP DATABASE); o servidor de teste recebe a URL do banco descartável.
import "../../server/env.js";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PREFIXO_BANCO = "myestoque_teste_";

// Localiza um binário do PostgreSQL: primeiro no PATH, depois nos caminhos padrão do Windows
function acharBinario(nome) {
  if (spawnSync(nome, ["--version"], { encoding: "utf8" }).status === 0) return nome;
  for (const versao of ["18", "17", "16", "15"]) {
    const alvo = `C:\\Program Files\\PostgreSQL\\${versao}\\bin\\${nome}.exe`;
    if (fs.existsSync(alvo)) return alvo;
  }
  throw new Error(`${nome} nao encontrado no PATH nem na instalacao padrao do PostgreSQL.`);
}

// Quebra a DATABASE_URL; a senha vai por variável de ambiente, nunca na linha de comando
function lerConexao() {
  const bruta = process.env.DATABASE_URL;
  if (!bruta) throw new Error("DATABASE_URL ausente. Confira o .env.local.");
  const url = new URL(bruta);
  return {
    url,
    host: url.hostname,
    porta: url.port || "5432",
    banco: decodeURIComponent(url.pathname.replace(/^\//, "")),
    usuario: decodeURIComponent(url.username),
    senha: decodeURIComponent(url.password)
  };
}

// Conexão avulsa num banco específico
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

// Porta TCP livre no momento (o sistema operacional escolhe)
function portaLivre() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.once("error", reject);
    servidor.listen(0, "127.0.0.1", () => {
      const { port } = servidor.address();
      servidor.close(() => resolve(port));
    });
  });
}

// Espera o servidor responder no /api/health, ou falha com o log do processo
async function esperarServidor(base, processo, saida) {
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    if (processo.exitCode !== null) throw new Error(`Servidor de teste saiu (codigo ${processo.exitCode}):\n${saida.join("")}`);
    try {
      const resposta = await fetch(`${base}/api/health`);
      if (resposta.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Servidor de teste nao respondeu em 20s:\n${saida.join("")}`);
}

// Cria o banco descartável, restaura a estrutura e sobe o servidor. Devolve { base, sql, encerrar }.
// `env` acrescenta variáveis ao servidor de teste (ex.: limite de upload menor).
export async function criarAmbienteDescartavel({ jwtSecret = crypto.randomBytes(24).toString("hex"), env = {} } = {}) {
  const conexao = lerConexao();
  const banco = `${PREFIXO_BANCO}${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  // Trava de segurança: o banco de teste nunca pode ser o da aplicação
  if (banco === conexao.banco || !banco.startsWith(PREFIXO_BANCO)) throw new Error("Nome de banco de teste inseguro.");

  const admin = await conectar(conexao, "postgres").catch(() => conectar(conexao, conexao.banco));
  await admin.query(`CREATE DATABASE ${banco}`);

  let processo = null;
  let cliente = null;
  // Fotos enviadas nos testes vão para uma pasta temporária, nunca para o .storage da produção
  const pastaStorage = fs.mkdtempSync(path.join(os.tmpdir(), "myestoque-teste-storage-"));
  // Limpeza que roda aconteça o que acontecer (também se a subida falhar no meio)
  const encerrar = async () => {
    if (processo && processo.exitCode === null) {
      const saiu = new Promise((resolve) => processo.once("exit", resolve));
      processo.kill();
      await Promise.race([saiu, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    if (cliente) await cliente.end().catch(() => {});
    await admin
      .query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [banco])
      .catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${banco}`).catch(() => {});
    fs.rmSync(pastaStorage, { recursive: true, force: true });
    await admin.end().catch(() => {});
  };

  try {
    const restauracao = spawnSync(
      acharBinario("pg_restore"),
      ["--host", conexao.host, "--port", conexao.porta, "--username", conexao.usuario, "--dbname", banco, "--no-owner", "--no-privileges", path.join(raiz, "db", "estrutura.dump")],
      { encoding: "utf8", env: { ...process.env, PGPASSWORD: conexao.senha } }
    );
    if (restauracao.status !== 0) throw new Error(`pg_restore falhou: ${(restauracao.stderr || "").slice(0, 400)}`);

    const urlTeste = new URL(conexao.url.toString());
    urlTeste.pathname = `/${banco}`;
    const porta = await portaLivre();
    const saida = [];
    processo = spawn(process.execPath, [path.join(raiz, "server", "index.js")], {
      cwd: raiz,
      env: {
        ...process.env,
        DATABASE_URL: urlTeste.toString(),
        PORT: String(porta),
        JWT_SECRET: jwtSecret,
        NODE_ENV: "test",
        INTEGRATIONS_SCHEDULER_ENABLED: "false",
        OMIE_SCHEDULER_ENABLED: "false",
        FORCE_SECURE_COOKIES: "false",
        STORAGE_DRIVER: "local",
        STORAGE_LOCAL_ROOT: pastaStorage,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    processo.stdout.on("data", (pedaco) => saida.push(String(pedaco)));
    processo.stderr.on("data", (pedaco) => saida.push(String(pedaco)));
    const base = `http://127.0.0.1:${porta}`;
    await esperarServidor(base, processo, saida);

    cliente = await conectar(conexao, banco);
    return { base, banco, pastaStorage, databaseUrl: urlTeste.toString(), jwtSecret, sql: (texto, params) => cliente.query(texto, params), saida, encerrar };
  } catch (erro) {
    await encerrar();
    throw erro;
  }
}

// Requisição HTTP simples com cookies manuais; devolve status, corpo JSON (ou texto) e cookies
export async function chamar(base, caminho, { method = "GET", corpo, cookie, headers = {} } = {}) {
  const resposta = await fetch(`${base}${caminho}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    redirect: "manual"
  });
  const texto = await resposta.text();
  let dados = texto;
  try {
    dados = JSON.parse(texto);
  } catch {
    // resposta não é JSON (arquivo estático)
  }
  return { status: resposta.status, dados, texto, headers: resposta.headers, cookies: resposta.headers.getSetCookie() };
}

// Extrai "nome=valor" de um Set-Cookie para reenviar no cabeçalho Cookie
export function cookieDe(cookies, nome) {
  const linha = (cookies || []).find((c) => c.startsWith(`${nome}=`));
  return linha ? linha.split(";")[0] : null;
}

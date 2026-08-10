// Carrega o ambiente aqui tambem (nao so no server/index.js): scripts de tools/
// importam este modulo direto e, sem isso, DATABASE_URL ficava vazia e a conexao
// caia no fallback legado do .streamlit/secrets.toml — ou seja, no banco da nuvem.
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

process.env.TZ ||= "America/Sao_Paulo";

const { Pool, types } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Mantém timestamps sem timezone como string crua, evitando conversão automática do driver
types.setTypeParser(1114, (value) => value);

// Fallback para pegar a string de conexão do Postgres do secrets.toml do Streamlit (deploy legado)
function readStreamlitSecret() {
  const file = path.join(rootDir, ".streamlit", "secrets.toml");
  if (!fs.existsSync(file)) return null;

  const text = fs.readFileSync(file, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-zA-Z_]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) values[match[1]] = match[2];
  }

  if (!values.host || !values.username || !values.password || !values.database) return null;
  const user = encodeURIComponent(values.username);
  const pass = encodeURIComponent(values.password);
  return `postgres://${user}:${pass}@${values.host}:${values.port || 5432}/${values.database}?sslmode=require`;
}

const rawConnectionString = process.env.DATABASE_URL || readStreamlitSecret();

if (!rawConnectionString) {
  throw new Error("Configure DATABASE_URL no .env ou mantenha .streamlit/secrets.toml com a conexao PostgreSQL.");
}

// Remove sslmode da querystring pois é tratado manualmente na opção `ssl` do Pool
const parsedConnection = new URL(rawConnectionString);
const sslmode = parsedConnection.searchParams.get("sslmode");
parsedConnection.searchParams.delete("sslmode");
const connectionString = parsedConnection.toString();
const hostname = parsedConnection.hostname.toLowerCase();
const usesHostedPostgres = sslmode !== "disable" && !["localhost", "127.0.0.1", "::1"].includes(hostname);
// Em Postgres hospedado (Supabase etc.) o pool fica limitado a 1 conexão por padrão, salvo override
const configuredPoolMax = Number(process.env.PGPOOL_MAX || process.env.DB_POOL_MAX || 0);
const poolMax = Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
  ? configuredPoolMax
  : usesHostedPostgres
    ? 1
    : 10;

export const pool = new Pool({
  connectionString,
  ssl: usesHostedPostgres ? { rejectUnauthorized: false } : undefined,
  max: poolMax,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
  // Supabase transaction pooler does not work well with traditional prepared statements.
  prepareThreshold: 0
});

// Garante que cada nova conexão do pool use o fuso horário de São Paulo
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'America/Sao_Paulo'").catch(() => {});
});

// Executa uma query simples no pool e retorna apenas as linhas
export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

// Executa uma transação: BEGIN/COMMIT em caso de sucesso, ROLLBACK em caso de erro
export async function tx(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const HASH_PREFIX = "pbkdf2_sha256";
const ITERATIONS = 260000;

// Gera hash de senha no formato pbkdf2_sha256$iteracoes$salt$digest
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, 32, "sha256").toString("base64");
  return `${HASH_PREFIX}$${ITERATIONS}$${salt}$${digest}`;
}

// Valida senha contra hash pbkdf2 ou, por compatibilidade, contra senha em texto puro antiga
export function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const value = String(stored);
  if (!value.startsWith(`${HASH_PREFIX}$`)) {
    // Senha legada sem hash: compara em tempo constante para evitar timing attack
    const entered = Buffer.from(String(password));
    const saved = Buffer.from(value);
    return entered.length === saved.length && crypto.timingSafeEqual(entered, saved);
  }

  const [, iterations, salt, digest] = value.split("$");
  if (!iterations || !salt || !digest) return false;
  const test = crypto.pbkdf2Sync(String(password), salt, Number(iterations), 32, "sha256").toString("base64");
  const entered = Buffer.from(test);
  const saved = Buffer.from(digest);
  return entered.length === saved.length && crypto.timingSafeEqual(entered, saved);
}

// Converte para inteiro com valor padrão seguro caso não seja um número válido
export function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Gera um código único legível (ex: PED-20260804120000-AB1C) para pedidos, avarias, etc.
export function code(prefix) {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date()).replace(/\D/g, "");
  return `${prefix}-${stamp}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

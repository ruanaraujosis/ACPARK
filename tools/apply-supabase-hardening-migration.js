// Script: aplica UMA migration de hardening (RLS/políticas) no banco de homologação
// Uso: node tools/apply-supabase-hardening-migration.js <nome-da-migration>
// Bloqueia execução caso as variáveis apontem para o projeto Supabase de produção
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Vem de env (nunca hardcoded) para não publicar o ref do projeto de produção no repositório;
// sem essa variável configurada, o .includes("") abaixo sempre bate e o script fica bloqueado
const PRODUCTION_PROJECT_REF = process.env.SUPABASE_PRODUCTION_PROJECT_REF || "";
// Lista branca de migrations de hardening permitidas por este script
const allowedMigrations = [
  "20260729_001_security_inventory.sql",
  "20260729_002_enable_rls_internal_tables.sql",
  "20260729_003_replace_permissive_policies.sql",
  "20260729_004_revoke_browser_internal_access.sql",
  "20260729_005_secure_functions_and_views.sql",
  "20260729_006_add_missing_fk_indexes.sql",
  "20260729_007_archive_legacy_print_tables.sql",
  "20260729_008_archive_orion_table.sql"
];

// Carrega variáveis de ambiente do arquivo local de homologação, se existir
loadEnv(".env.homologation.local");

const migrationName = process.argv[2] || "";
if (!allowedMigrations.includes(migrationName)) {
  console.error("Informe uma migracao permitida para homologacao:");
  for (const item of allowedMigrations) console.error(`- ${item}`);
  process.exit(1);
}

const databaseUrl = process.env.HOMOLOGATION_DATABASE_URL || "";
const supabaseUrl = process.env.HOMOLOGATION_SUPABASE_URL || "";
const serviceRoleKey = process.env.HOMOLOGATION_SUPABASE_SERVICE_ROLE_KEY || "";

if (!databaseUrl || !supabaseUrl || !serviceRoleKey) {
  console.error("Configure .env.homologation.local com HOMOLOGATION_DATABASE_URL, HOMOLOGATION_SUPABASE_URL e HOMOLOGATION_SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

// Trava de segurança: nunca deixar este script rodar contra o projeto de produção
if (databaseUrl.includes(PRODUCTION_PROJECT_REF) || supabaseUrl.includes(PRODUCTION_PROJECT_REF)) {
  console.error("Bloqueado: variaveis de homologacao apontam para o projeto Supabase de producao conhecido.");
  process.exit(1);
}

const migrationPath = path.join("server", "migrations", migrationName);
const sql = fs.readFileSync(migrationPath, "utf8");
const parsed = new URL(databaseUrl);
const sslmode = parsed.searchParams.get("sslmode");
parsed.searchParams.delete("sslmode");
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());

// Pool com apenas 1 conexão: script roda uma migration por vez e encerra
const pool = new pg.Pool({
  connectionString: parsed.toString(),
  ssl: sslmode !== "disable" && !isLocal ? { rejectUnauthorized: false } : undefined,
  max: 1,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 1000,
  allowExitOnIdle: true
});

try {
  // Confere qual papel/privilégios a conexão está usando antes de aplicar a migration
  const role = await pool.query(`
    select current_user, session_user, rolsuper, rolbypassrls
    from pg_roles
    where rolname = current_user
  `);
  const current = role.rows[0] || {};
  console.log(`Banco de homologacao conectado como: ${current.current_user || "desconhecido"}`);
  console.log(`BYPASSRLS: ${current.rolbypassrls === true ? "sim" : "nao"}`);
  console.log(`Superuser: ${current.rolsuper === true ? "sim" : "nao"}`);
  console.log(`Aplicando somente: ${migrationName}`);

  await pool.query(sql);
  console.log(`Migracao aplicada com sucesso: ${migrationName}`);
  console.log("Agora execute: npm run test:sequential");
} catch (error) {
  console.error(`Falha ao aplicar ${migrationName}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

// Lê um arquivo .env simples e preenche process.env sem sobrescrever valores já definidos
function loadEnv(file) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

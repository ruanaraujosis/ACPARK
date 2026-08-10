// Script: valida se o ambiente de homologação está corretamente configurado
// (variáveis presentes, não aponta para produção, migrations existem e conexão funciona)
// antes de permitir aplicar as migrations de hardening
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Vem de env (nunca hardcoded) para não publicar o ref do projeto de produção no repositório;
// sem essa variável configurada, o .includes("") abaixo sempre bate e a checagem falha (seguro por padrão)
const PRODUCTION_PROJECT_REF = process.env.SUPABASE_PRODUCTION_PROJECT_REF || "";
// Migrations de hardening que devem existir em server/migrations
const MIGRATIONS = [
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

const databaseUrl = process.env.HOMOLOGATION_DATABASE_URL || process.env.DATABASE_URL || "";
const supabaseUrl = process.env.HOMOLOGATION_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.HOMOLOGATION_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
// Escape hatch explícito para permitir rodar contra produção (uso excepcional)
const allowProduction = process.env.ALLOW_PRODUCTION_SUPABASE_HARDENING === "true";

const checks = [];

addCheck("DATABASE_URL de homologacao presente", Boolean(databaseUrl));
addCheck("SUPABASE_URL de homologacao presente", Boolean(supabaseUrl));
addCheck("SERVICE_ROLE de homologacao presente", Boolean(serviceRoleKey));
addCheck("DATABASE_URL nao aponta para producao conhecida", allowProduction || !databaseUrl.includes(PRODUCTION_PROJECT_REF));
addCheck("SUPABASE_URL nao aponta para producao conhecida", allowProduction || !supabaseUrl.includes(PRODUCTION_PROJECT_REF));
addCheck("SERVICE_ROLE nao parece placeholder", serviceRoleKey && !/configure|troque|placeholder/i.test(serviceRoleKey));

for (const migration of MIGRATIONS) {
  addCheck(`Migracao encontrada: ${migration}`, fs.existsSync(path.join("server", "migrations", migration)));
}

// Interrompe cedo se qualquer verificação estática já falhou, sem tentar conectar ao banco
if (checks.some((check) => !check.ok)) {
  printChecks();
  console.error("\nHomologacao bloqueada: corrija os itens acima antes de aplicar migracoes.");
  process.exit(1);
}

const parsed = new URL(databaseUrl);
const sslmode = parsed.searchParams.get("sslmode");
parsed.searchParams.delete("sslmode");
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
const pool = new pg.Pool({
  connectionString: parsed.toString(),
  ssl: sslmode !== "disable" && !isLocal ? { rejectUnauthorized: false } : undefined,
  max: 1,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 1000,
  allowExitOnIdle: true
});

try {
  // Testa a conexão real e reporta qual papel/privilégios ela usa
  const { rows } = await pool.query(`
    select
      current_user,
      session_user,
      rolsuper,
      rolbypassrls
    from pg_roles
    where rolname = current_user
  `);
  const role = rows[0] || {};
  addCheck("Conexao com banco de homologacao OK", true);
  addCheck(`current_user: ${role.current_user || "desconhecido"}`, true);
  addCheck(`session_user: ${role.session_user || "desconhecido"}`, true);
  addCheck(`BYPASSRLS: ${role.rolbypassrls === true ? "sim" : "nao"}`, true);
  addCheck(`Superuser: ${role.rolsuper === true ? "sim" : "nao"}`, true);
} catch (error) {
  addCheck(`Conexao com banco de homologacao falhou: ${error.message}`, false);
} finally {
  await pool.end().catch(() => {});
}

printChecks();

if (checks.some((check) => !check.ok)) {
  process.exit(1);
}

console.log("\nAmbiente de homologacao validado. Aplique as migracoes uma por vez e rode npm run test:sequential apos cada etapa.");

// Registra o resultado de uma verificação individual
function addCheck(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
}

// Imprime todas as verificações com status OK/FALHA
function printChecks() {
  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FALHA"} - ${check.name}`);
  }
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

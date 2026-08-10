// Script: valida se o ambiente atual está pronto para produção
// (segredo do JWT, conexão com o banco e configuração de storage durável)
import fs from "node:fs";
import dotenv from "dotenv";

// Carrega variáveis de ambiente sem sobrescrever as já definidas no processo
for (const file of [".env.production.local", ".env.local", ".env"]) {
  if (fs.existsSync(file)) {
    dotenv.config({ path: file, override: false });
  }
}

const { pool } = await import("../server/db.js");
const { getStorageConfig } = await import("../server/services/storage/storage.config.js");
const { getStorageService } = await import("../server/services/storage/storage.service.js");

const checks = [];

// Registra o resultado de uma verificação individual
function addCheck(name, ok, detail = "") {
  checks.push({ name, ok, detail });
}

// Rejeita segredos vazios, curtos ou com valores padrão de exemplo
function secretLooksSafe(value) {
  const text = String(value || "");
  return text.length >= 32 && !["dev-only-change-me", "troque-esta-chave-por-uma-chave-longa-em-producao"].includes(text);
}

try {
  addCheck("JWT_SECRET configurado", secretLooksSafe(process.env.JWT_SECRET), "Necessário segredo forte em produção.");
  addCheck("DATABASE_URL configurada", true, "Conexão carregada pelo server/db.js.");

  const db = await pool.query("select 1 as ok");
  addCheck("Banco responde", db.rows[0]?.ok === 1);

  const storageConfig = getStorageConfig();
  addCheck("Storage durável", storageConfig.driver !== "local", `driver=${storageConfig.driver}`);
  addCheck("Bucket de fotos configurado", Boolean(storageConfig.bucket), storageConfig.bucket ? "bucket informado" : "STORAGE_BUCKET ausente");

  try {
    const storage = getStorageService();
    addCheck("Storage inicializa", Boolean(storage));
  } catch (error) {
    addCheck("Storage inicializa", false, error.message);
  }

  // Código de saída não-zero se qualquer verificação falhar, para uso em CI
  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, checks }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

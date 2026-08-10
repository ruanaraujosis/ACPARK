// Script: copia as fotos de avaria do Supabase Storage para o disco local,
// preparando a virada de STORAGE_DRIVER=supabase para STORAGE_DRIVER=local
// (migração para rede local/offline). Não altera nenhuma linha do banco:
// o storage_key é o mesmo em qualquer adaptador, só o arquivo físico muda de lugar.
// Uso: node tools/migrate-storage-to-local.js [--apply]
import { pool, query } from "../server/db.js";
import { SupabaseStorageAdapter } from "../server/services/storage/supabase-storage.adapter.js";
import { LocalStorageAdapter } from "../server/services/storage/local-storage.adapter.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Sem --apply o script só analisa (dry run), sem gravar nada
const dryRun = process.argv.includes("--apply") === false;
const localRoot = process.env.STORAGE_LOCAL_ROOT || path.resolve("./.storage");

// Fonte: Supabase Storage (lê as credenciais atuais do .env, independente do STORAGE_DRIVER ativo)
const source = new SupabaseStorageAdapter({
  supabaseUrl: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  bucket: process.env.STORAGE_BUCKET
});
// Destino: disco local
const destination = new LocalStorageAdapter({ root: localRoot });

const summary = { total: 0, copied: 0, alreadyLocal: 0, failed: 0, dryRun, localRoot };
const failures = [];

// Verifica se o arquivo já existe localmente com o mesmo conteúdo (hash), para não baixar de novo
async function alreadyCopied(key, expectedSha256) {
  try {
    const existing = await destination.readFile(key);
    if (!expectedSha256) return true;
    const actualSha256 = crypto.createHash("sha256").update(existing).digest("hex");
    return actualSha256 === expectedSha256;
  } catch {
    return false;
  }
}

try {
  const rows = await query(
    `SELECT id, storage_key, sha256
     FROM devolucao_avaria_fotos
     WHERE storage_key IS NOT NULL AND storage_key <> ''
     ORDER BY id`
  );
  summary.total = rows.length;

  for (const row of rows) {
    try {
      if (await alreadyCopied(row.storage_key, row.sha256)) {
        summary.alreadyLocal += 1;
        continue;
      }
      if (dryRun) continue;
      const buffer = await source.readFile(row.storage_key);
      await destination.saveFile(row.storage_key, buffer);
      summary.copied += 1;
    } catch (error) {
      summary.failed += 1;
      failures.push({ id: row.id, storage_key: row.storage_key, error: error.message });
    }
  }

  console.log(JSON.stringify({ ...summary, failures }, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ...summary, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}

// Script: migra fotos legadas de avaria (armazenadas como base64 em coluna
// de texto) para o storage configurado (S3/R2/Supabase), gravando os
// metadados em devolucao_avaria_fotos
// Uso: node tools/migrate-avaria-photos.js [--apply]
import { pool, tx } from "../server/db.js";
import { getStorageConfig } from "../server/services/storage/storage.config.js";
import { getStorageService } from "../server/services/storage/storage.service.js";
import crypto from "node:crypto";

// Sem --apply o script só analisa (dry run), sem gravar nada
const dryRun = process.argv.includes("--apply") === false;
const batchSize = Number(process.env.MIGRATE_AVARIA_PHOTOS_BATCH || 25);
const storageConfig = getStorageConfig();

// Evita migrar para storage local (não durável) em produção sem confirmação explícita
if (!dryRun && storageConfig.driver === "local" && process.env.MIGRATE_AVARIA_PHOTOS_ALLOW_LOCAL !== "true") {
  console.error(JSON.stringify({
    dryRun,
    error: "Migração bloqueada: STORAGE_DRIVER=local não é seguro para produção/Vercel. Configure storage durável antes de usar --apply."
  }, null, 2));
  process.exit(1);
}

// Interpreta a coluna legada "fotos" (JSON de data URLs) e filtra apenas imagens válidas
function parseLegacyPhotos(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.startsWith("data:image/")) : [];
  } catch {
    return [];
  }
}

// Extrai mime type e buffer binário de uma data URL (base64)
function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  if (!match) return null;
  return {
    mime: match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase(),
    buffer: Buffer.from(match[2], "base64")
  };
}

const summary = {
  analyzed: 0,
  migrated: 0,
  alreadyMigrated: 0,
  invalidBase64: 0,
  duplicated: 0,
  failed: 0,
  dryRun
};

try {
  const storage = getStorageService();
  await tx(async (client) => {
    // Busca itens de avaria com fotos legadas ainda não migradas
    const items = await client.query(
      `SELECT i.id, i.devolucao_id, i.fotos, d.pdv_id, d.usuario_solicitante
       FROM devolucao_avaria_itens i
       JOIN devolucoes_avaria d ON d.id = i.devolucao_id
       WHERE i.fotos IS NOT NULL AND i.fotos <> ''
       ORDER BY i.id
       LIMIT $1`,
      [batchSize]
    );
    for (const item of items.rows) {
      const legacyPhotos = parseLegacyPhotos(item.fotos);
      for (const [index, dataUrl] of legacyPhotos.entries()) {
        summary.analyzed += 1;
        const decoded = decodeDataUrl(dataUrl);
        if (!decoded) {
          summary.invalidBase64 += 1;
          continue;
        }
        const validated = storage.validateImage({ buffer: decoded.buffer, originalName: `legacy-${item.id}-${index + 1}` });
        // Usa o hash do conteúdo para evitar duplicar a mesma foto já migrada
        const sha256 = crypto.createHash("sha256").update(decoded.buffer).digest("hex");
        const sha = await client.query(
          "SELECT 1 FROM devolucao_avaria_fotos WHERE item_id = $1 AND sha256 = $2 LIMIT 1",
          [item.id, sha256]
        );
        if (sha.rows[0]) {
          summary.alreadyMigrated += 1;
          continue;
        }
        if (dryRun) continue;
        const saved = await storage.saveImage({
          buffer: decoded.buffer,
          originalName: `legacy-${item.id}-${index + 1}.${validated.ext}`,
          folder: `avarias/legacy/${item.pdv_id || "sem-pdv"}`
        });
        // Grava os metadados da foto migrada; ON CONFLICT evita duplicar em reprocessamento
        await client.query(
          `INSERT INTO devolucao_avaria_fotos
             (devolucao_id, item_id, owner_role, owner_name, owner_pdv_id, storage_key,
              original_name, mime_type, size_bytes, width, height, sha256, uploaded_by, linked_at)
           VALUES ($1, $2, 'migration', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'migration', CURRENT_TIMESTAMP)
           ON CONFLICT (item_id, sha256) DO NOTHING`,
          [
            item.devolucao_id,
            item.id,
            item.usuario_solicitante || "migration",
            item.pdv_id,
            saved.storageKey,
            saved.originalName,
            saved.mimeType,
            saved.sizeBytes,
            saved.width,
            saved.height,
            saved.sha256
          ]
        );
        summary.migrated += 1;
      }
    }
  });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.failed += 1;
  console.error(JSON.stringify({ ...summary, error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}

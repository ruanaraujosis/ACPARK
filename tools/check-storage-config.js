// Script: testa o storage configurado fazendo upload, leitura e remoção
// de uma imagem PNG mínima (1x1 pixel) usada apenas como arquivo de prova
import { getStorageConfig } from "../server/services/storage/storage.config.js";
import { getStorageService } from "../server/services/storage/storage.service.js";

// PNG 1x1 pixel em hexadecimal, usado como arquivo de teste do storage
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000150a2f4a20000000049454e44ae426082",
  "hex"
);

const keepFile = process.argv.includes("--keep");
const requireDurable = process.argv.includes("--require-durable");
const config = getStorageConfig();
const result = {
  driver: config.driver,
  durable: config.driver !== "local",
  bucketConfigured: Boolean(config.bucket),
  endpointConfigured: Boolean(config.endpoint),
  maxImageMb: Math.round(config.maxImageBytes / 1024 / 1024),
  maxImagesPerItem: config.maxImagesPerItem,
  ok: false
};

try {
  // Opcionalmente exige storage durável (não local) antes de seguir com o teste
  if (requireDurable && config.driver === "local") {
    throw new Error("Storage local detectado. Configure STORAGE_DRIVER=s3, r2 ou supabase antes da migração definitiva.");
  }

  const storage = getStorageService();
  const saved = await storage.saveImage({
    buffer: PNG_1X1,
    originalName: "storage-healthcheck.png",
    folder: "healthcheck"
  });
  const loaded = await storage.readFile(saved.storageKey);
  if (!loaded.equals(PNG_1X1)) throw new Error("Arquivo lido do storage não confere com o arquivo enviado.");
  // Remove o arquivo de teste, a menos que --keep tenha sido passado
  if (!keepFile) await storage.deleteFile(saved.storageKey);

  result.ok = true;
  result.storageKey = keepFile ? saved.storageKey : "removido";
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ...result, error: error.message }, null, 2));
  process.exitCode = 1;
}

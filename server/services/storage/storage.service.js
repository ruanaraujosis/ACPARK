import crypto from "node:crypto";
import path from "node:path";
import { getStorageConfig } from "./storage.config.js";
import { LocalStorageAdapter } from "./local-storage.adapter.js";
import { S3StorageAdapter } from "./s3-storage.adapter.js";
import { SupabaseStorageAdapter } from "./supabase-storage.adapter.js";
import { StorageConfigurationError, StorageValidationError } from "./storage.errors.js";

// Assinaturas binarias (magic numbers) usadas para identificar o tipo real da imagem
const MIME_BY_SIGNATURE = [
  { mime: "image/jpeg", ext: "jpg", match: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", match: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", match: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" }
];

// Detecta o tipo real da imagem pelo conteudo do buffer (nao confia na extensao do arquivo)
export function detectImage(buffer) {
  return MIME_BY_SIGNATURE.find((entry) => entry.match(buffer)) || null;
}

// Le largura/altura direto dos bytes da imagem (sem depender de biblioteca externa)
export function imageDimensions(buffer, mime) {
  if (mime === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

// Fachada de storage: escolhe o adaptador (local/supabase/s3/r2) e valida imagens enviadas
export class StorageService {
  constructor(config = getStorageConfig()) {
    this.config = config;
    // Seleciona o adaptador conforme o driver configurado
    if (config.driver === "local") {
      // Storage local fica bloqueado em producao, salvo liberacao explicita
      if (config.productionLike && !config.allowLocalInProduction) {
        throw new StorageConfigurationError("Storage local bloqueado em produção. Configure STORAGE_DRIVER=supabase, s3 ou r2.");
      }
      this.adapter = new LocalStorageAdapter({ root: config.localRoot });
    }
    else if (config.driver === "supabase") this.adapter = new SupabaseStorageAdapter(config);
    else if (["s3", "r2"].includes(config.driver)) this.adapter = new S3StorageAdapter(config);
    else throw new StorageConfigurationError(`Driver de storage invalido: ${config.driver}`);
  }

  // Valida tamanho e formato do arquivo antes de salvar (JPG/PNG/WEBP apenas)
  validateImage({ buffer, originalName }) {
    if (!buffer?.length) throw new StorageValidationError("Arquivo vazio ou corrompido.");
    if (buffer.length > this.config.maxImageBytes) throw new StorageValidationError("Imagem acima do limite permitido.");
    const detected = detectImage(buffer);
    if (!detected) {
      const lower = String(originalName || "").toLowerCase();
      if (lower.endsWith(".heic") || lower.endsWith(".heif")) {
        throw new StorageValidationError("Fotos HEIC/HEIF ainda nao podem ser convertidas neste ambiente. Envie JPG, PNG ou WEBP.");
      }
      throw new StorageValidationError("Arquivo nao e uma imagem JPG, PNG ou WEBP valida.");
    }
    const dims = imageDimensions(buffer, detected.mime);
    return { ...detected, ...dims };
  }

  // Valida e salva a imagem usando uma chave deterministica baseada no hash sha256
  async saveImage({ buffer, originalName, folder = "avarias" }) {
    const detected = this.validateImage({ buffer, originalName });
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const key = path.posix.join(folder, `${new Date().toISOString().slice(0, 10)}`, `${sha256}.${detected.ext}`);
    await this.adapter.saveFile(key, buffer, detected.mime);
    return {
      storageKey: key,
      originalName,
      mimeType: detected.mime,
      sizeBytes: buffer.length,
      width: detected.width,
      height: detected.height,
      sha256
    };
  }

  async readFile(storageKey) {
    return this.adapter.readFile(storageKey);
  }

  async deleteFile(storageKey) {
    if (!storageKey) return;
    if (typeof this.adapter.deleteFile !== "function") return;
    return this.adapter.deleteFile(storageKey);
  }

  // Retorna a rota interna usada para servir a foto (proxy, nao URL direta do bucket)
  getSignedUrl(photoId) {
    return `/api/avarias/fotos/${encodeURIComponent(photoId)}`;
  }
}

let storageService;

// Retorna instancia unica (singleton) do servico de storage
export function getStorageService() {
  storageService ||= new StorageService();
  return storageService;
}

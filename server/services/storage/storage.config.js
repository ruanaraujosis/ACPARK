import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Resolve as configuracoes de storage (driver, limites e credenciais) a partir das env vars
export function getStorageConfig(env = process.env) {
  // Driver ativo: local, supabase, s3 ou r2
  const driver = env.STORAGE_DRIVER || "local";
  const maxImageMb = Number(env.UPLOAD_MAX_IMAGE_MB || 8);
  const maxImagesPerItem = Number(env.UPLOAD_MAX_IMAGES_PER_ITEM || 12);
  const signedUrlTtl = Number(env.STORAGE_SIGNED_URL_TTL || 300);
  return {
    driver,
    // Indica ambiente tipo producao, onde storage local fica bloqueado por padrao
    productionLike: env.NODE_ENV === "production" || Boolean(env.VERCEL),
    allowLocalInProduction: env.STORAGE_ALLOW_LOCAL_IN_PRODUCTION === "true",
    bucket: env.STORAGE_BUCKET || "",
    region: env.STORAGE_REGION || "",
    endpoint: env.STORAGE_ENDPOINT || "",
    accessKey: env.STORAGE_ACCESS_KEY || "",
    secretKey: env.STORAGE_SECRET_KEY || "",
    supabaseUrl: env.SUPABASE_URL || "",
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    publicUrl: env.STORAGE_PUBLIC_URL || "",
    signedUrlTtl: Number.isFinite(signedUrlTtl) && signedUrlTtl > 0 ? signedUrlTtl : 300,
    maxImageBytes: Math.max(1, maxImageMb) * 1024 * 1024,
    maxImagesPerItem: Math.max(1, maxImagesPerItem),
    localRoot: env.STORAGE_LOCAL_ROOT || path.join(rootDir, ".storage")
  };
}

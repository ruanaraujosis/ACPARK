import crypto from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1";

// Deriva a chave de criptografia AES a partir da env.
//
// Sem fallback para valor fixo: antes, uma instalação sem NODE_ENV=production caía em
// "local-integration-secret" (string que está neste arquivo, no repositório público) e gravava
// as credenciais da OMIE com uma chave que qualquer um conhece. Como os backups incluem a tabela
// integration_credentials, isso valeria para qualquer cópia do banco. A variável agora é sempre
// obrigatória — instalação nova precisa gerá-la, igual ao JWT_SECRET.
function getSecretKey(env = process.env) {
  const raw = env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw || raw === "dev-only-change-me") {
    throw new Error("Configure INTEGRATION_ENCRYPTION_KEY no .env.local para usar integrações.");
  }
  return crypto.createHash("sha256").update(String(raw)).digest();
}

// Criptografa uma credencial (ex: app_key/app_secret OMIE) com AES-256-GCM antes de persistir
export function encryptSecret(value, env = process.env) {
  if (value === null || value === undefined || value === "") return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getSecretKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_PREFIX, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

// Reverte encryptSecret; valores nao criptografados (legado) sao retornados como estao
export function decryptSecret(value, env = process.env) {
  if (!value || typeof value !== "string") return "";
  if (!value.startsWith(`${ENCRYPTION_PREFIX}:`)) return value;
  const [, , ivRaw, tagRaw, encryptedRaw] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getSecretKey(env), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

// Mascara um segredo para exibicao segura (ex: em telas de configuracao), preservando so as pontas
export function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

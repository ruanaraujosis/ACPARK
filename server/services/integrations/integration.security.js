import crypto from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1";

// Deriva a chave de criptografia AES a partir da env; exige chave real em producao
function getSecretKey(env = process.env) {
  const raw = env.INTEGRATION_ENCRYPTION_KEY || env.JWT_SECRET;
  if (env.NODE_ENV === "production" && (!raw || raw === "dev-only-change-me")) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY obrigatorio em producao.");
  }
  return crypto.createHash("sha256").update(String(raw || "local-integration-secret")).digest();
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

// Monta a versao publica da integracao para API/UI, nunca expondo o valor real das credenciais
export function sanitizeIntegration(integration = {}, credentials = []) {
  return {
    id: integration.id,
    nome: integration.nome,
    provedor: integration.provedor,
    tipo: integration.tipo,
    ambiente: integration.ambiente,
    ativo: integration.ativo,
    status: integration.status,
    url_base: integration.url_base,
    stock_mode: integration.stock_mode,
    empresa_vinculada: integration.empresa_vinculada,
    ultima_sincronizacao: integration.ultima_sincronizacao,
    last_connection_test_at: integration.last_connection_test_at,
    last_connection_duration_ms: integration.last_connection_duration_ms,
    last_error: integration.last_error,
    created_at: integration.created_at,
    updated_at: integration.updated_at,
    credentials: credentials.map((credential) => ({
      key: credential.credential_key || credential.key,
      masked_value: credential.masked_value || maskSecret(credential.value),
      configured: Boolean(credential.encrypted_value || credential.masked_value || credential.value)
    }))
  };
}

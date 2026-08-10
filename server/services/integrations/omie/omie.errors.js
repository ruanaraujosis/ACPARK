// Erro de dominio para falhas na integracao OMIE, com status HTTP e flag de retentativa
export class OmieIntegrationError extends Error {
  constructor(message, { status = 500, retryable = false, details = null } = {}) {
    super(message);
    this.name = "OmieIntegrationError";
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

// Identifica se a resposta da OMIE indica credenciais invalidas/ausentes (nao retentavel)
export function isOmieCredentialError(data) {
  const message = String(data?.faultstring || data?.message || "").toLowerCase();
  return message.includes("app_key") || message.includes("app_secret") || message.includes("credencial");
}

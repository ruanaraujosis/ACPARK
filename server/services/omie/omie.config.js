// Rotulos exibidos na UI para o status local da integracao com o OMIE
export const OMIE_LOCAL_STATUSES = Object.freeze({
  WAITING: "Aguardando integração",
  NOT_CONFIGURED: "Integração não configurada",
  PROCESSING: "Processando integração",
  SUCCESS: "Integrado com sucesso",
  FAILED: "Falha na integração"
});

// Le e normaliza as configuracoes da integracao OMIE a partir das env vars
export function getOmieConfig(env = process.env) {
  const enabled = String(env.OMIE_ENABLED || "false").toLowerCase() === "true";
  const baseUrl = env.OMIE_BASE_URL || "https://app.omie.com.br/api/v1";
  const timeoutMs = Number(env.OMIE_TIMEOUT_MS || 15000);
  const appKey = env.OMIE_APP_KEY || "";
  const appSecret = env.OMIE_APP_SECRET || "";
  // So considera configurado se estiver habilitado e com credenciais/URL presentes
  const configured = enabled && Boolean(appKey && appSecret && baseUrl);

  return {
    enabled,
    configured,
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
    appKey,
    appSecret
  };
}

// Determina o status inicial exibido antes de qualquer tentativa de integracao
export function omieInitialStatus(env = process.env) {
  const config = getOmieConfig(env);
  return config.configured ? OMIE_LOCAL_STATUSES.WAITING : OMIE_LOCAL_STATUSES.NOT_CONFIGURED;
}

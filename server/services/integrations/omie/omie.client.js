import { OmieIntegrationError, isOmieCredentialError } from "./omie.errors.js";

// Limite local de chamadas por janela de tempo para nao estourar o rate limit da OMIE
export const OMIE_LOCAL_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 60
};

// Monta o corpo da requisicao no formato esperado pela API OMIE (call + credenciais + parametros)
export function buildOmiePayload({ call, params = {}, appKey, appSecret }) {
  return {
    call,
    app_key: appKey,
    app_secret: appSecret,
    param: [params]
  };
}

// Resolve a URL final do endpoint evitando duplicar o caminho quando a base ja o inclui
export function resolveOmieEndpointUrl(baseUrl, endpoint) {
  const normalizedBase = String(baseUrl || "https://app.omie.com.br/api/v1").replace(/\/+$/, "");
  const normalizedEndpoint = `/${String(endpoint || "").replace(/^\/+/, "")}`;
  const endpointWithoutTrailingSlash = normalizedEndpoint.replace(/\/+$/, "");

  if (!endpointWithoutTrailingSlash) return normalizedBase;
  if (normalizedBase.endsWith(endpointWithoutTrailingSlash)) return normalizedBase;
  return `${normalizedBase}${normalizedEndpoint}`;
}

// Executa uma chamada OMIE validando integracao ativa e credenciais antes de enviar a requisicao
export async function omieRequestWithConfig({
  loaded,
  endpoint,
  call,
  params = {},
  fetchImpl = globalThis.fetch
}) {
  const integration = loaded?.integration || {};
  const secrets = loaded?.secrets || {};
  if (!integration.ativo) {
    throw new OmieIntegrationError("Integracao OMIE inativa.", { status: 400 });
  }
  if (!secrets.app_key || !secrets.app_secret) {
    throw new OmieIntegrationError("Credenciais OMIE nao configuradas.", { status: 400 });
  }

  const startedAt = Date.now();
  const url = resolveOmieEndpointUrl(integration.url_base, endpoint);
  const payload = buildOmiePayload({ call, params, appKey: secrets.app_key, appSecret: secrets.app_secret });

  // Circuit breaker guard: quando integration_runtime_state.circuit_state = 'OPEN',
  // o agendador deve evitar novas chamadas ate a janela de recuperacao.
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  const durationMetric = { name: "omie_request_duration_ms", value: Date.now() - startedAt };

  // Diferencia erro de credencial (nao retentavel) de outras falhas da API (retentaveis)
  if (!response.ok || data?.faultstring || data?.faultcode) {
    const credentialError = isOmieCredentialError(data);
    throw new OmieIntegrationError(
      credentialError ? "Credenciais OMIE recusadas." : (data?.faultstring || "Falha na chamada OMIE."),
      { status: response.status || 502, retryable: !credentialError, details: { data, durationMetric } }
    );
  }

  return {
    call,
    status: response.status,
    data,
    duration_ms: durationMetric.value,
    omie_request_duration_ms: durationMetric.value
  };
}

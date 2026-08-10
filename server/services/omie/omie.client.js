import { getOmieConfig } from "./omie.config.js";
import { OmieConfigurationError, OmieRequestError, isRetryableOmieStatus } from "./omie.errors.js";

// Faz uma chamada POST autenticada para a API do OMIE, com timeout e tratamento de erros
export async function callOmie(endpoint, payload, { fetchImpl = fetch, env = process.env } = {}) {
  const config = getOmieConfig(env);
  if (!config.configured) throw new OmieConfigurationError();

  const controller = new AbortController();
  // Aborta a requisicao se exceder o tempo limite configurado
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(`${config.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_key: config.appKey,
        app_secret: config.appSecret,
        ...payload
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    // OMIE pode retornar 200 com erro no corpo (faultstring/faultcode)
    if (!response.ok || data?.faultstring || data?.faultcode) {
      throw new OmieRequestError(data.faultstring || data.message || "Falha na comunicação com o OMIE.", {
        status: response.status,
        retryable: isRetryableOmieStatus(response.status),
        response: data
      });
    }
    return {
      data,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    // Timeout do AbortController vira erro retentavel para o job processar novamente
    if (error.name === "AbortError") {
      throw new OmieRequestError("Tempo limite ao comunicar com o OMIE.", { status: 408, retryable: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

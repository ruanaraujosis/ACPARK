import { beginLoading } from "../ui/loading.js";

// Cliente HTTP central: envia cookie de sessão, mostra loading global e normaliza erros da API
export async function request(path, options = {}) {
  const { loadingMessage = "Carregando dados...", silentLoading = false, ...fetchOptions } = options;
  // Só exibe o indicador de carregamento quando a chamada não é silenciosa
  const stopLoading = silentLoading ? () => {} : beginLoading(loadingMessage);
  try {
    const response = await fetch(path, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) },
      ...fetchOptions
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Repassa status/código/corpo do erro para quem chamou tratar (ex: 401 na sessão)
      const error = new Error(data.message || data.error || "Falha na operação.");
      error.status = response.status;
      error.code = data.error;
      error.details = data;
      throw error;
    }
    return data;
  } finally {
    stopLoading();
  }
}



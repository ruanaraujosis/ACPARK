import { CODIGOS_ERRO, IntegrationError } from "./errors.js";

const TIMEOUT_PADRAO_MS = 15_000;
const TRECHO_DIAGNOSTICO = 300;

// Codigos HTTP que valem nova tentativa (indisponibilidade momentanea, nao erro de uso)
const STATUS_RETENTAVEIS = new Set([408, 425, 429, 500, 502, 503, 504]);

// POST JSON usado por todos os providers.
//
// Tres protecoes que a versao anterior nao tinha, e que juntas causaram 25 dias de
// sincronizacao "bem-sucedida" importando zero produtos:
//
// 1. redirect: "manual" — um 301 era seguido silenciosamente pelo fetch, que converte
//    POST em GET; a resposta vinha em HTML, o JSON.parse falhava, o catch devolvia {} e
//    o codigo tratava isso como "a API respondeu, mas nao tem dados".
// 2. content-type obrigatoriamente JSON — corpo HTML agora vira erro explicito com trecho
//    da resposta, em vez de objeto vazio.
// 3. JSON invalido e erro, nunca {} — se a API respondeu algo que nao da para ler, isso e
//    uma falha, nao uma lista vazia.
export async function postarJson(
  url,
  corpo,
  { timeoutMs = TIMEOUT_PADRAO_MS, fetchImpl = globalThis.fetch, cabecalhos = {} } = {}
) {
  const controller = new AbortController();
  const limite = setTimeout(() => controller.abort(), timeoutMs);
  const iniciadoEm = Date.now();

  let resposta;
  try {
    resposta = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...cabecalhos
      },
      body: JSON.stringify(corpo),
      redirect: "manual",
      signal: controller.signal
    });
  } catch (erro) {
    if (erro?.name === "AbortError") {
      throw new IntegrationError(`Tempo limite de ${timeoutMs}ms excedido ao chamar a integracao.`, {
        codigo: CODIGOS_ERRO.TEMPORARIO,
        status: 408,
        retentavel: true
      });
    }
    throw new IntegrationError(`Falha de rede ao chamar a integracao: ${erro?.message || erro}`, {
      codigo: CODIGOS_ERRO.TEMPORARIO,
      status: 0,
      retentavel: true
    });
  } finally {
    clearTimeout(limite);
  }

  const duracaoMs = Date.now() - iniciadoEm;
  const status = Number(resposta.status || 0);

  // Redirecionamento e erro de configuracao de URL, nunca sucesso
  if (status >= 300 && status < 400) {
    const destino = typeof resposta.headers?.get === "function" ? resposta.headers.get("location") : null;
    throw new IntegrationError(
      `A integracao respondeu com redirecionamento HTTP ${status}. Verifique a URL base cadastrada${destino ? ` (o servidor aponta para ${destino})` : ""}.`,
      {
        codigo: CODIGOS_ERRO.CONFIGURACAO,
        status,
        retentavel: false,
        detalhes: { url, destino }
      }
    );
  }

  const texto = await resposta.text().catch(() => "");
  const contentType = (typeof resposta.headers?.get === "function" ? resposta.headers.get("content-type") : "") || "";
  const pareceJson = /json/i.test(contentType) || /^\s*[[{]/.test(texto);

  if (!pareceJson) {
    throw new IntegrationError(
      `A integracao respondeu em formato inesperado (${contentType || "sem content-type"}) em vez de JSON.`,
      {
        codigo: status >= 400 ? CODIGOS_ERRO.TEMPORARIO : CODIGOS_ERRO.DADOS,
        status,
        retentavel: STATUS_RETENTAVEIS.has(status),
        detalhes: { url, trecho: texto.slice(0, TRECHO_DIAGNOSTICO) }
      }
    );
  }

  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    throw new IntegrationError("A integracao respondeu com JSON invalido.", {
      codigo: CODIGOS_ERRO.DADOS,
      status,
      retentavel: false,
      detalhes: { url, trecho: texto.slice(0, TRECHO_DIAGNOSTICO) }
    });
  }

  return {
    status,
    dados,
    duracaoMs,
    retentavel: STATUS_RETENTAVEIS.has(status)
  };
}

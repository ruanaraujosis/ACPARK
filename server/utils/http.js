import zlib from "node:zlib";

// Só vale comprimir a partir de um tamanho mínimo: abaixo disso o cabeçalho e o custo de CPU
// comem o ganho, e a maioria das respostas da API é pequena.
const TAMANHO_MINIMO_GZIP = 2048;

// Nível 1 de propósito (medido neste projeto, com o payload real de ~646 KB do /api/bootstrap):
// reduz 85% gastando 6ms de CPU. O nível 9 gasta 31ms para ganhar só mais 13 KB — numa LAN
// rápida isso deixaria a resposta MAIS lenta do que mandar sem comprimir.
const NIVEL_GZIP = 1;

// Marca na resposta se o cliente aceita gzip; chamado uma vez por requisição no roteador principal
export function marcarSuporteGzip(req, res) {
  res.aceitaGzip = /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
}

// Comprime o corpo quando vale a pena e o cliente aceita; devolve o buffer e os cabeçalhos extras
export function comprimirSePossivel(res, corpo) {
  const bruto = Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo, "utf8");
  if (!res.aceitaGzip || bruto.length < TAMANHO_MINIMO_GZIP) return { corpo: bruto, headers: {} };
  const comprimido = zlib.gzipSync(bruto, { level: NIVEL_GZIP });
  return {
    corpo: comprimido,
    // Vary avisa caches intermediários de que a resposta muda conforme o Accept-Encoding
    headers: { "Content-Encoding": "gzip", Vary: "Accept-Encoding" }
  };
}

// Envia uma resposta JSON padronizada com o status HTTP informado
export function send(res, status, data, headers = {}) {
  const { corpo, headers: headersGzip } = comprimirSePossivel(res, JSON.stringify(data));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": corpo.length,
    ...headersGzip,
    ...headers
  });
  res.end(corpo);
}

// Lê e faz parse do corpo JSON da requisição, limitando o tamanho para evitar payloads excessivos
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 8_000_000) {
        tooLarge = true;
        reject(new Error("Arquivo muito grande para importar de uma vez. Tente novamente em lotes menores."));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON inválido."));
      }
    });
  });
}

// Remove espaços nas pontas e limita o tamanho de um texto vindo do cliente
export function normalizeText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

// Normaliza uma lista de categorias: maiúsculas, sem vazios e sem duplicadas
export function normalizeCategories(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => normalizeText(value, 120).toUpperCase()).filter(Boolean))];
}

// Aceita categorias como array ou string separada por ; , | e normaliza
export function normalizeCategoryList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;,|]/);
  return normalizeCategories(values);
}



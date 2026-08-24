import { CODIGOS_ERRO, IntegrationError } from "../../core/errors.js";
import { postarJson } from "../../core/http.client.js";

export const URL_BASE_PADRAO = "https://app.omie.com.br/api/v1";

// Endpoints usados pelas tarefas deste provider
export const ENDPOINTS = Object.freeze({
  PRODUTOS: "geral/produtos",
  LOCAIS: "estoque/local",
  CONSULTA: "estoque/consulta",
  // Resumo devolve o saldo de UM produto em todos os locais numa chamada so
  RESUMO: "estoque/resumo",
  AJUSTE: "estoque/ajuste",
  // Recebimento de NF-e: unica fonte de historico de compra com dado util nesta conta --
  // pedido de compra tem zero registros e nota de entrada tem uma, vazia
  RECEBIMENTOS: "produtos/recebimentonfe",
  // Caracteristicas do produto: onde o fator aprovado e gravado de volta no ERP
  CARACTERISTICAS: "geral/prodcaract"
});

// Normaliza a URL base cadastrada, cortando qualquer caminho depois de /api/vN.
//
// A instalacao atual tinha "https://app.omie.com.br/api/v1/geral/produtos/" salvo como url_base.
// A versao anterior tentava contornar isso detectando duplicacao de caminho e, no processo,
// removia a barra final — a OMIE responde 301 sem a barra, o fetch seguia o redirecionamento
// virando GET, a resposta vinha em HTML e o sistema entendia "nenhum produto encontrado".
// Aqui a base e reduzida a raiz da API, entao url_base torto nao quebra mais nada.
export function normalizarUrlBase(urlBase) {
  const bruto = String(urlBase || URL_BASE_PADRAO)
    .trim()
    .replace(/\/+$/, "");
  const raiz = bruto.match(/^(https?:\/\/[^/]+\/api\/v\d+)/i);
  return raiz ? raiz[1] : bruto;
}

// Monta a URL do endpoint sempre com barra final, que e o formato que a OMIE exige
export function resolverUrl(urlBase, endpoint) {
  const caminho = String(endpoint || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return `${normalizarUrlBase(urlBase)}/${caminho}/`;
}

// Corpo no formato da OMIE: a chamada, as credenciais e os parametros dentro de um array
export function montarCorpo({ call, params = {}, appKey, appSecret }) {
  return { call, app_key: appKey, app_secret: appSecret, param: [params] };
}

// A OMIE devolve erro de negocio com HTTP 500 e um faultstring no corpo. Estes textos
// indicam credencial invalida, que nao adianta retentar.
function ehErroDeCredencial(faultstring = "") {
  return /app_key|app_secret|acesso negado|nao autorizado|invalid|credencial/i.test(String(faultstring));
}

// Chamada unica a OMIE, usada por todas as tarefas deste provider
export async function chamarOmie({
  integracao,
  segredos,
  endpoint,
  call,
  params = {},
  fetchImpl,
  timeoutMs = Number(process.env.OMIE_TIMEOUT_MS) || 15_000
}) {
  if (!segredos?.app_key || !segredos?.app_secret) {
    throw new IntegrationError("Credenciais da OMIE nao configuradas.", {
      codigo: CODIGOS_ERRO.CONFIGURACAO,
      status: 400
    });
  }

  const url = resolverUrl(integracao?.url_base, endpoint);
  const corpo = montarCorpo({
    call,
    params,
    appKey: segredos.app_key,
    appSecret: segredos.app_secret
  });
  const resposta = await postarJson(url, corpo, { fetchImpl, timeoutMs });
  const dados = resposta.dados || {};

  if (dados.faultstring || dados.faultcode) {
    const credencial = ehErroDeCredencial(dados.faultstring);
    throw new IntegrationError(String(dados.faultstring || "Falha na chamada a OMIE.").slice(0, 500), {
      codigo: credencial ? CODIGOS_ERRO.AUTENTICACAO : CODIGOS_ERRO.DADOS,
      status: resposta.status,
      // Erro de negocio da OMIE nao e retentavel; so o de infraestrutura e
      retentavel: !credencial && resposta.retentavel,
      detalhes: { call, faultcode: dados.faultcode || null }
    });
  }

  if (resposta.status >= 400) {
    throw new IntegrationError(`A OMIE respondeu HTTP ${resposta.status} na chamada ${call}.`, {
      codigo: resposta.retentavel ? CODIGOS_ERRO.TEMPORARIO : CODIGOS_ERRO.DADOS,
      status: resposta.status,
      retentavel: resposta.retentavel
    });
  }

  return { call, dados, duracaoMs: resposta.duracaoMs };
}

// Le o total de paginas de uma resposta, cobrindo os dois nomes que a OMIE usa
// (total_de_paginas nos cadastros, nTotPaginas nos servicos de estoque)
export function totalDePaginas(dados = {}) {
  const bruto = Number(dados.total_de_paginas ?? dados.nTotPaginas ?? dados.nTotPagina ?? 1);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : 1;
}

export function totalDeRegistros(dados = {}) {
  const bruto = Number(dados.total_de_registros ?? dados.total_de_registros_encontrados ?? dados.nTotRegistros ?? 0);
  return Number.isFinite(bruto) ? bruto : 0;
}

// Extrai a lista de itens da resposta procurando o primeiro campo array conhecido.
// Se nenhum bater, cai no maior array presente — assim uma mudanca de nome de campo pela
// OMIE aparece como dado importado, e nao como silencio.
export function extrairLista(dados = {}, camposConhecidos = []) {
  for (const campo of camposConhecidos) {
    if (Array.isArray(dados?.[campo])) return dados[campo];
  }
  const arrays = Object.entries(dados || {}).filter(([, valor]) => Array.isArray(valor));
  if (!arrays.length) return [];
  return arrays.sort((a, b) => b[1].length - a[1].length)[0][1];
}

// A OMIE sinaliza "resultado vazio" lancando erro de negocio, nao devolvendo lista vazia:
// "ERROR: Nao existem registros para a pagina [1]!".
//
// Isso NAO e o mesmo que a armadilha do JSON vazio. Ali o problema era resposta ilegivel
// (HTML) sendo convertida em {} e passando por "sem dados". Aqui a OMIE esta dizendo, de
// forma explicita e inequivoca, que aquela consulta nao tem registro -- e informacao, nao
// silencio. Quem varre varios locais precisa distinguir os dois: um local sem movimento no
// periodo nao pode derrubar a leitura dos outros.
export function ehSemRegistros(erro) {
  return /n[aã]o existem registros/i.test(String(erro?.message || ""));
}

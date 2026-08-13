import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { comprimirSePossivel, marcarSuporteGzip, send } from "../server/utils/http.js";

const indexSrc = fs.readFileSync("server/index.js", "utf8");
const httpSrc = fs.readFileSync("server/utils/http.js", "utf8");

// Resposta falsa só para capturar o que o send() escreveria
function respostaFalsa() {
  return {
    status: null,
    headers: null,
    corpo: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(corpo) { this.corpo = corpo; }
  };
}

test("marcarSuporteGzip detecta o cabeçalho do cliente", () => {
  const res = {};
  marcarSuporteGzip({ headers: { "accept-encoding": "gzip, deflate, br" } }, res);
  assert.equal(res.aceitaGzip, true);

  const res2 = {};
  marcarSuporteGzip({ headers: { "accept-encoding": "deflate" } }, res2);
  assert.equal(res2.aceitaGzip, false);

  const res3 = {};
  marcarSuporteGzip({ headers: {} }, res3);
  assert.equal(res3.aceitaGzip, false);
});

test("payload grande é comprimido e volta idêntico ao descomprimir", () => {
  const original = JSON.stringify({ itens: Array.from({ length: 500 }, (_, i) => ({ sku: `SKU-${i}`, nome: `PRODUTO ${i}` })) });
  const { corpo, headers } = comprimirSePossivel({ aceitaGzip: true }, original);

  assert.equal(headers["Content-Encoding"], "gzip");
  assert.equal(headers.Vary, "Accept-Encoding");
  assert.ok(corpo.length < Buffer.byteLength(original), "deveria ficar menor");
  // O que importa de verdade: descomprimir tem que devolver exatamente o original
  assert.equal(zlib.gunzipSync(corpo).toString("utf8"), original);
});

test("payload pequeno não é comprimido (não compensa o custo)", () => {
  const { corpo, headers } = comprimirSePossivel({ aceitaGzip: true }, JSON.stringify({ ok: true }));
  assert.equal(headers["Content-Encoding"], undefined);
  assert.equal(corpo.toString("utf8"), JSON.stringify({ ok: true }));
});

test("cliente que não aceita gzip recebe o conteúdo cru", () => {
  const grande = "x".repeat(50_000);
  const { corpo, headers } = comprimirSePossivel({ aceitaGzip: false }, grande);
  assert.equal(headers["Content-Encoding"], undefined);
  assert.equal(corpo.toString("utf8"), grande);
});

test("send() comprime e informa Content-Length do corpo realmente enviado", () => {
  const dados = { itens: Array.from({ length: 500 }, (_, i) => ({ i, nome: `PRODUTO ${i}` })) };

  const comGzip = respostaFalsa();
  comGzip.aceitaGzip = true;
  send(comGzip, 200, dados);
  assert.equal(comGzip.headers["Content-Encoding"], "gzip");
  // Content-Length precisa bater com o corpo comprimido, senão o cliente trava esperando bytes
  assert.equal(comGzip.headers["Content-Length"], comGzip.corpo.length);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(comGzip.corpo).toString("utf8")), dados);

  const semGzip = respostaFalsa();
  semGzip.aceitaGzip = false;
  send(semGzip, 200, dados);
  assert.equal(semGzip.headers["Content-Encoding"], undefined);
  assert.equal(semGzip.headers["Content-Length"], semGzip.corpo.length);
  assert.deepEqual(JSON.parse(semGzip.corpo.toString("utf8")), dados);
});

test("o nível de gzip é o barato (1), não o máximo", () => {
  // Medido neste projeto: nível 1 reduz 85% gastando 6ms; o nível 9 gasta 31ms para ganhar 13 KB,
  // o que numa LAN rápida deixaria a resposta mais lenta do que mandar sem comprimir.
  assert.match(httpSrc, /const NIVEL_GZIP = 1;/);
});

test("SSE nunca passa pelo send() — não pode ser comprimido nem bufferizado", () => {
  const sse = fs.readFileSync("server/services/order-alerts/order-alerts.events.js", "utf8");
  assert.match(sse, /text\/event-stream/);
  // O stream escreve direto na resposta; usar send() aqui quebraria o tempo real
  assert.match(sse, /res\.write\(/);
  assert.doesNotMatch(sse, /\bsend\(res/);
});

test("fontes e imagens não são comprimidas de novo", () => {
  // .woff2/.png/.jpg já são comprimidos no próprio formato: gzipar só gastaria CPU
  const match = indexSrc.match(/EXTENSOES_COMPRIMIVEIS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(match, "lista de extensões compressíveis deveria existir");
  const lista = match[1];
  for (const ext of [".woff2", ".png", ".jpg", ".ico"]) {
    assert.ok(!lista.includes(ext), `${ext} não deveria estar na lista de compressíveis`);
  }
  for (const ext of [".js", ".css", ".html", ".json"]) {
    assert.ok(lista.includes(ext), `${ext} deveria estar na lista de compressíveis`);
  }
});

test("index.html nunca é cacheado; arquivos versionados são cacheados para sempre", () => {
  // O index.html é quem aponta para as URLs ?v=..., então precisa vir sempre fresco para um
  // deploy novo ser notado. Os arquivos com ?v= podem ser imutáveis: trocar a versão muda a URL.
  assert.match(indexSrc, /if \(extension === "\.html"\) return "no-store"/);
  assert.match(indexSrc, /searchParams\.has\("v"\)[\s\S]{0,80}immutable/);
});

test("a reposição automática é limitada por intervalo e protegida contra execução concorrente", () => {
  // Antes rodava a cada requisição autenticada: transação + varredura de 42 mil linhas por chamada.
  assert.match(indexSrc, /AUTO_ORDER_INTERVAL_MS/);
  assert.match(indexSrc, /autoOrdersRunning \|\| agora - autoOrdersLastRun < AUTO_ORDER_INTERVAL_MS/);
  // A trava precisa ser liberada mesmo se a verificação lançar erro
  assert.match(indexSrc, /finally \{\s*autoOrdersRunning = false;/);
});

test("a listagem de produtos junta categorias em memória, sem agregação cara no SQL", () => {
  // string_agg + array_agg com ORDER BY interno forçava duas ordenações (~230ms para 4,5 mil
  // produtos) em toda carga de página. A ordem continua vindo do banco, então o resultado é igual.
  assert.match(indexSrc, /async function listarProdutosComCategorias/);
  assert.match(indexSrc, /ORDER BY sku_produto, categoria/);
  assert.doesNotMatch(indexSrc, /string_agg\(pc\.categoria/, "a agregação cara não deveria ter sobrado");
});

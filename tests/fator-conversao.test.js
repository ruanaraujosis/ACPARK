import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  converterParaUnidades,
  descreverConversao,
  descreverEmEmbalagens,
  FATOR_UNITARIO,
  interpretarFator,
  STATUS_FATOR
} from "../server/services/integrations/core/fator-conversao.js";
import { sincronizarFatores } from "../server/services/integrations/providers/omie/tarefas/fatores.js";
import { providerOmie } from "../server/services/integrations/providers/omie/index.js";

// Fator de conversao: o PDV pede em embalagem, o estoque guarda em unidade.
// Um fator errado multiplica o pedido inteiro em silencio -- por isso a regra e estrita.

const INTEGRACAO = { id: 1, provedor: "OMIE", url_base: "https://app.omie.com.br/api/v1" };
const SEGREDOS = { app_key: "chave", app_secret: "segredo" };

test("so inteiro puro e positivo vira fator", () => {
  assert.equal(interpretarFator("15").status, STATUS_FATOR.DEFINIDO);
  assert.equal(interpretarFator("15").fator, 15);
  assert.equal(interpretarFator(" 15 ").fator, 15, "espaco em volta e aparado");
  assert.equal(interpretarFator("1").fator, 1);
});

test("conteudo ambiguo vira pendencia, nunca fator adivinhado", () => {
  // Estes sao os casos reais do cadastro: adivinhar o numero a partir de texto livre
  // multiplicaria o pedido por um fator errado sem ninguem perceber.
  for (const ruim of ["15 un", "15,0", "15.0", "fd c/ 15", "1,5", "-15", "15/UN", "quinze", "0"]) {
    const leitura = interpretarFator(ruim);
    assert.equal(leitura.status, STATUS_FATOR.INVALIDO, `"${ruim}" deveria ser recusado`);
    assert.equal(leitura.fator, null);
    assert.ok(leitura.motivo, `"${ruim}" precisa explicar o que corrigir`);
  }
});

test("produto sem a caracteristica e vendido por unidade", () => {
  for (const vazio of ["", null, undefined, "   "]) {
    const leitura = interpretarFator(vazio);
    assert.equal(leitura.status, STATUS_FATOR.UNITARIO);
    assert.equal(leitura.fator, FATOR_UNITARIO);
  }
});

test("2 fardos de 15 viram 30 unidades", () => {
  // A regra do briefing, literal
  assert.equal(converterParaUnidades(2, 15), 30);
  assert.equal(converterParaUnidades(1, 15), 15);
  assert.equal(converterParaUnidades(7, 1), 7, "fator 1 nao muda nada");
});

test("nenhum caminho grava fracao", () => {
  // Quantidade fracionada de embalagem nao existe: 2,5 fardos nao e pedido valido
  assert.throws(() => converterParaUnidades(2.5, 15), /inteiro/i);
  assert.throws(() => converterParaUnidades(0, 15), /maior que zero/i);
  assert.throws(() => converterParaUnidades(-1, 15), /maior que zero/i);
  // Fator invalido nao pode virar multiplicacao silenciosa
  assert.throws(() => converterParaUnidades(2, null), /sem fator de conversao/i);
  assert.throws(() => converterParaUnidades(2, 1.5), /sem fator de conversao/i);
  assert.throws(() => converterParaUnidades(2, 0), /sem fator de conversao/i);

  // O resultado e sempre inteiro seguro
  for (const [emb, fator] of [
    [3, 12],
    [1, 1],
    [50, 24]
  ]) {
    const r = converterParaUnidades(emb, fator);
    assert.ok(Number.isSafeInteger(r), `${emb} x ${fator} tem de dar inteiro`);
  }
});

test("a tela mostra a embalagem e o total em unidades lado a lado", () => {
  assert.equal(descreverConversao({ quantidadeEmbalagem: 2, fator: 15, embalagem: "FARDO" }), "2 fardos = 30 un");
  assert.equal(descreverConversao({ quantidadeEmbalagem: 1, fator: 15, embalagem: "FARDO" }), "1 fardo = 15 un");
  // Sem o nome da embalagem, fala genericamente em vez de inventar
  assert.equal(descreverConversao({ quantidadeEmbalagem: 2, fator: 15 }), "2 embalagem(ns) com 15 un = 30 un");
});

test("liberacao parcial em unidade mostra o equivalente em embalagem", () => {
  // O almoxarifado libera 8 de um fardo de 15: o campo e em unidade, a embalagem e informacao
  assert.equal(descreverEmEmbalagens(8, 15), "8 un");
  assert.equal(descreverEmEmbalagens(30, 15), "30 un (2 x 15)");
  assert.equal(descreverEmEmbalagens(38, 15), "38 un (2 x 15 + 8)");
  // Produto unitario nao ganha decoracao
  assert.equal(descreverEmEmbalagens(8, 1), "8 un");
});

// fetch falso que devolve o ConsultarProduto de cada codigo pedido
function fetchProdutos(porCodigo) {
  const chamadas = [];
  const impl = async (url, opcoes) => {
    const corpo = JSON.parse(opcoes.body);
    const codigo = String(corpo.param[0].codigo_produto);
    chamadas.push({ call: corpo.call, codigo, url });
    return {
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify(porCodigo[codigo] || { faultstring: "ERROR: Não existem registros!" })
    };
  };
  impl.chamadas = chamadas;
  return impl;
}

function clientDeFatores(pendentes, restantes = 0) {
  const gravacoes = [];
  return {
    gravacoes,
    async query(texto, params = []) {
      if (/SELECT external_product_id, sku_produto/.test(texto)) return { rows: pendentes, rowCount: pendentes.length };
      if (/COUNT\(\*\)::int AS n/.test(texto)) return { rows: [{ n: restantes }], rowCount: 1 };
      if (/UPDATE product_integration_mappings/.test(texto)) {
        gravacoes.push({
          externalId: params[1],
          fator: params[2],
          status: params[3],
          bruto: params[4],
          embalagem: params[5]
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

test("le a caracteristica configurada e grava o fator", async () => {
  const client = clientDeFatores([{ external_product_id: "11072266157", sku_produto: "7894900531008" }]);
  const impl = fetchProdutos({
    11072266157: {
      codigo: "7894900531008",
      descricao: "AGUA COM GAS",
      caracteristicas: [{ cNomeCaract: "UNIDADES_POR_EMBALAGEM", cConteudo: "15" }]
    }
  });

  const resumo = await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: impl,
    enfileirar: async () => {}
  });

  assert.equal(impl.chamadas[0].call, "ConsultarProduto");
  assert.equal(resumo.com_fator, 1);
  assert.equal(client.gravacoes[0].fator, 15);
  assert.equal(client.gravacoes[0].status, STATUS_FATOR.DEFINIDO);
});

test("o nome da caracteristica e configuracao, nao codigo", async () => {
  // Renomear no ERP so pode exigir ajustar a configuracao
  const client = clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }]);
  const impl = fetchProdutos({
    1: { caracteristicas: [{ cNomeCaract: "QTD_NA_CAIXA", cConteudo: "24" }] }
  });

  const resumo = await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { caracteristica_fator: "QTD_NA_CAIXA" },
    payload: {},
    fetchImpl: impl,
    enfileirar: async () => {}
  });

  assert.equal(resumo.caracteristica_fator, "QTD_NA_CAIXA");
  assert.equal(client.gravacoes[0].fator, 24);

  // Nenhum nome de caracteristica esta fixo no codigo da tarefa
  const fonte = fs.readFileSync("server/services/integrations/providers/omie/tarefas/fatores.js", "utf8");
  assert.doesNotMatch(fonte.replace(/PADRAO_CARACTERISTICA_FATOR = "[^"]*"/, ""), /"UNIDADE"|"QTD_NA_CAIXA"/);
});

test("acento e caixa no nome da caracteristica nao impedem a leitura", async () => {
  const client = clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }]);
  const impl = fetchProdutos({ 1: { caracteristicas: [{ cNomeCaract: "unidades_por_embalagem", cConteudo: "6" }] } });
  await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: impl,
    enfileirar: async () => {}
  });
  assert.equal(client.gravacoes[0].fator, 6);
});

test("conteudo invalido vira pendencia com o conteudo original guardado", async () => {
  const client = clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }]);
  const impl = fetchProdutos({
    1: { caracteristicas: [{ cNomeCaract: "UNIDADES_POR_EMBALAGEM", cConteudo: "fd c/ 15" }] }
  });

  const resumo = await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: impl,
    enfileirar: async () => {}
  });

  assert.equal(resumo.invalidos, 1);
  assert.equal(client.gravacoes[0].status, STATUS_FATOR.INVALIDO);
  assert.equal(client.gravacoes[0].fator, null, "nao pode inventar numero");
  // O conteudo original fica guardado para a pendencia dizer o que corrigir no ERP
  assert.equal(client.gravacoes[0].bruto, "fd c/ 15");
  assert.deepEqual(resumo.exemplos_invalidos[0], { sku: "SKU1", conteudo: "fd c/ 15" });
  assert.match(resumo.alerta, /pendencias/i);
});

test("o nome da embalagem e opcional e nunca inventado", async () => {
  const client = clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }]);
  const impl = fetchProdutos({
    1: {
      caracteristicas: [
        { cNomeCaract: "UNIDADES_POR_EMBALAGEM", cConteudo: "15" },
        { cNomeCaract: "EMBALAGEM", cConteudo: "FARDO" }
      ]
    }
  });

  // Sem a configuracao do nome, a embalagem nao e lida
  await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: impl,
    enfileirar: async () => {}
  });
  assert.equal(client.gravacoes[0].embalagem, null);

  // Com a configuracao, e lida
  const client2 = clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }]);
  await sincronizarFatores({
    client: client2,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { caracteristica_embalagem: "EMBALAGEM" },
    payload: {},
    fetchImpl: fetchProdutos({
      1: {
        caracteristicas: [
          { cNomeCaract: "UNIDADES_POR_EMBALAGEM", cConteudo: "15" },
          { cNomeCaract: "EMBALAGEM", cConteudo: "FARDO" }
        ]
      }
    }),
    enfileirar: async () => {}
  });
  assert.equal(client2.gravacoes[0].embalagem, "FARDO");
});

test("a varredura agenda a continuacao enquanto sobrar produto", async () => {
  const agendados = [];
  const client = clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }], 4000);
  await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: fetchProdutos({ 1: { caracteristicas: [] } }),
    enfileirar: async (capacidade, payload) => agendados.push({ capacidade, payload })
  });
  assert.equal(agendados.length, 1, "5 mil produtos nao cabem num job so");
  assert.equal(agendados[0].capacidade, "FATORES");

  // Sem restantes, nao agenda
  const agendados2 = [];
  await sincronizarFatores({
    client: clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }], 0),
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: fetchProdutos({ 1: { caracteristicas: [] } }),
    enfileirar: async (c, p) => agendados2.push({ c, p })
  });
  assert.equal(agendados2.length, 0);
});

test("produto que sumiu do ERP nao trava a fila", async () => {
  const client = clientDeFatores([{ external_product_id: "999", sku_produto: "SUMIU" }]);
  const resumo = await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: fetchProdutos({}),
    enfileirar: async () => {}
  });
  assert.equal(resumo.nao_encontrados, 1);
  // Marcado como lido, senao seria tentado para sempre
  assert.equal(client.gravacoes.length, 1);
});

test("o provider declara a capacidade e os nomes configuraveis", () => {
  const cap = providerOmie.capacidades.find((c) => c.id === "FATORES");
  assert.ok(cap, "FATORES precisa estar registrada");
  assert.equal(typeof cap.executar, "function");

  const chaves = providerOmie.configuracoes.map((c) => c.chave);
  assert.ok(chaves.includes("caracteristica_fator"));
  assert.ok(chaves.includes("caracteristica_embalagem"));
});

test("o nucleo do fator continua sem conhecer nenhuma API", () => {
  const src = fs.readFileSync("server/services/integrations/core/fator-conversao.js", "utf8");
  const semComentarios = src.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(semComentarios, /\bOMIE\b|cNomeCaract|ConsultarProduto/i);
});

test("a tela do PDV mostra a embalagem e o total em unidades, sem inventar", () => {
  const app = fs.readFileSync("public/app.js", "utf8");

  // O seletor de unidade só aparece para produto com fator maior que 1
  assert.match(app, /const temEmbalagem = fator > 1 && !invalido;/);
  // Produto com cadastro torto não oferece pedido por embalagem
  assert.match(app, /Cadastro sem fator válido — peça em unidades/);
  // O total em unidades acompanha a escolha na hora
  assert.match(app, /= <strong>\$\{item\.quantidade \* fator\} un<\/strong>/);
  // Sem o nome da embalagem, fala genericamente em vez de chutar "fardo"
  assert.match(app, /embalagem\(ns\)/);
  // A escolha viaja para o backend e sobrevive ao rascunho
  assert.match(app, /unidade_medida: item\.unidade_medida === "EMBALAGEM" \? "EMBALAGEM" : "UNIDADE"/);
});

test("a aba Integracoes lista as pendencias de fator", () => {
  const app = fs.readFileSync("public/app.js", "utf8");
  assert.match(app, /\/api\/admin\/integrations\/fatores/, "a tela precisa buscar as pendências");
  assert.match(app, /Fator de conversão dos produtos/);
  // A correção é no ERP; a tela não pode sugerir edição local
  assert.match(app, /a correção é feita <strong>lá<\/strong>, não aqui/i);
});

test("o endpoint do PDV entrega o fator junto com o produto", () => {
  const rota = fs.readFileSync("server/modules/estoque/estoque.routes.js", "utf8");
  assert.match(rota, /MAX\(m\.fator_conversao\) AS fator_conversao/);
  assert.match(rota, /LEFT JOIN product_integration_mappings m/);
  // LEFT JOIN: produto sem vínculo continua aparecendo para o PDV, como unitário
  assert.doesNotMatch(rota, /\n\s+JOIN product_integration_mappings/);
});

test("cada continuacao da varredura e um job distinto, senao ela nao encadeia", async () => {
  // A fila deduplica por (integracao, capacidade, payload) e considera o job em PROCESSANDO --
  // isto e, o proprio job que pede a continuacao. Com payload identico, o enfileirar devolvia
  // o job atual em vez de criar o proximo: medido em producao, a varredura andava 60 produtos
  // a cada 30 minutos em vez de encadear.
  const agendados = [];
  const client = clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }], 4000);
  await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: fetchProdutos({ 1: { caracteristicas: [] } }),
    enfileirar: async (capacidade, payload) => agendados.push({ capacidade, payload })
  });
  assert.equal(agendados[0].payload.lote, 1, "a primeira continuacao precisa de lote proprio");

  // E o lote avanca a cada volta, para nunca colidir com o job anterior
  const agendados2 = [];
  await sincronizarFatores({
    client: clientDeFatores([{ external_product_id: "1", sku_produto: "SKU1" }], 4000),
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: { lote: 7 },
    fetchImpl: fetchProdutos({ 1: { caracteristicas: [] } }),
    enfileirar: async (c, p) => agendados2.push({ c, p })
  });
  assert.equal(agendados2[0].p.lote, 8);
});

test("a releitura forcada percorre o catalogo inteiro e termina", async () => {
  // Depois de configurar as caracteristicas no ERP, esperar 7 dias nao faz sentido.
  // Na releitura, "ainda falta ler" passa a ser "lido antes do instante em que o mutirao
  // comecou" -- sem essa referencia, cada lote deixaria o produto fresco, a conta de restantes
  // zeraria na primeira volta e a releitura pararia no lote 1.
  const consultas = [];
  const client = {
    async query(texto, params = []) {
      consultas.push({ texto, params });
      if (/SELECT external_product_id, sku_produto/.test(texto)) {
        return { rows: [{ external_product_id: "1", sku_produto: "SKU1" }] };
      }
      if (/COUNT\(\*\)::int AS n/.test(texto)) return { rows: [{ n: 500 }] };
      return { rows: [], rowCount: 0 };
    }
  };

  const agendados = [];
  const resumo = await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: { reler: true, relerDesde: "2026-08-22T10:00:00.000Z" },
    fetchImpl: fetchProdutos({ 1: { caracteristicas: [] } }),
    enfileirar: async (capacidade, payload) => agendados.push({ capacidade, payload })
  });

  assert.equal(resumo.modo, "RELEITURA");

  // A busca usa o instante do mutirao, nao a janela de dias
  const busca = consultas.find((c) => /SELECT external_product_id, sku_produto/.test(c.texto));
  assert.equal(busca.params[1], "2026-08-22T10:00:00.000Z");

  // A conta de restantes usa o MESMO predicado da busca, senao a releitura para no lote 1
  const conta = consultas.find((c) => /COUNT\(\*\)::int AS n/.test(c.texto));
  assert.equal(conta.params[1], "2026-08-22T10:00:00.000Z");

  // E a continuacao carrega o mesmo instante, para todo o mutirao usar a mesma referencia
  assert.equal(agendados[0].payload.relerDesde, "2026-08-22T10:00:00.000Z");
  assert.equal(agendados[0].payload.reler, true);
});

test("sem releitura, a varredura usa a janela de dias e nao o instante", async () => {
  const consultas = [];
  const client = {
    async query(texto, params = []) {
      consultas.push({ texto, params });
      if (/SELECT external_product_id, sku_produto/.test(texto)) return { rows: [] };
      return { rows: [{ n: 0 }], rowCount: 0 };
    }
  };
  const resumo = await sincronizarFatores({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: fetchProdutos({}),
    enfileirar: async () => {}
  });
  assert.equal(resumo.modo, "PENDENTES");
  const busca = consultas.find((c) => /SELECT external_product_id, sku_produto/.test(c.texto));
  assert.equal(busca.params[1], null, "sem releitura o instante precisa ser nulo");
});

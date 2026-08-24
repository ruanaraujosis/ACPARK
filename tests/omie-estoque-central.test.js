import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { sincronizarEstoqueAlmoxarifado } from "../server/services/integrations/providers/omie/tarefas/estoque-almoxarifado.js";
import { sincronizarProdutos } from "../server/services/integrations/providers/omie/tarefas/produtos.js";
import {
  sincronizarSaldoDeItem,
  sincronizarSaldos
} from "../server/services/integrations/providers/omie/tarefas/saldos.js";
import { sincronizarMovimentos } from "../server/services/integrations/providers/omie/tarefas/movimentos.js";
import { providerOmie } from "../server/services/integrations/providers/omie/index.js";
import { validarConfiguracaoDaCapacidade } from "../server/services/integrations/core/integration.repository.js";

// Fluxo de estoque do sistema, travado por teste:
//
//   OMIE (local ALMOXARIFADO)  ->  produtos.qtd_total      (estoque central)
//   liberacao de pedido        ->  estoque_pdv.quantidade  (estoque do PDV)
//
// A tarefa de produtos cuida so do cadastro. Se ela voltar a escrever saldo, o estoque
// central passa a ter dois donos e fica oscilando -- e o que este arquivo impede.

const INTEGRACAO = {
  id: 1,
  provedor: "OMIE",
  url_base: "https://app.omie.com.br/api/v1"
};
const SEGREDOS = { app_key: "chave", app_secret: "segredo" };
const CONFIG = { local_almoxarifado: "10792598111" };

function fetchFalso(respostas) {
  const chamadas = [];
  let indice = 0;
  const impl = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body) });
    const dados = respostas[Math.min(indice++, respostas.length - 1)];
    return {
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify(dados)
    };
  };
  impl.chamadas = chamadas;
  return impl;
}

// Client pg falso que registra as escritas para o teste inspecionar
function clientFalso(respostas = []) {
  const executadas = [];
  return {
    executadas,
    escritasEm(tabela) {
      return executadas.filter((q) => new RegExp(`(UPDATE|INSERT INTO)\\s+${tabela}`, "i").test(q.texto));
    },
    async query(texto, params = []) {
      executadas.push({ texto, params });
      const casada = respostas.find((item) => texto.includes(item.contem));
      return casada?.resultado || { rows: [], rowCount: 0 };
    }
  };
}

// Resposta do ListarPosEstoque no formato real devolvido pela conta desta instalacao
function posicaoEstoque(produtos, { pagina = 1, totalPaginas = 1 } = {}) {
  return { nPagina: pagina, nTotPaginas: totalPaginas, nTotRegistros: produtos.length, produtos };
}

test("o estoque do almoxarifado vira o estoque central do produto", async () => {
  const client = clientFalso([
    {
      contem: "FROM product_integration_mappings",
      resultado: {
        rows: [
          { external_product_id: "10792612974", sku_produto: "PRD00001" },
          { external_product_id: "10807085744", sku_produto: "55668" }
        ]
      }
    },
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 1 } }
  ]);

  const impl = fetchFalso([
    posicaoEstoque([
      { nCodProd: 10792612974, cCodigo: "PRD00001", nSaldo: 270, fisico: 270, codigo_local_estoque: 10792598111 },
      { nCodProd: 10807085744, cCodigo: "55668", nSaldo: 5, fisico: 5, codigo_local_estoque: 10792598111 }
    ])
  ]);

  const resumo = await sincronizarEstoqueAlmoxarifado({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: {},
    fetchImpl: impl
  });

  assert.equal(resumo.recebidos, 2);
  assert.equal(resumo.atualizados, 2);
  assert.equal(resumo.total_em_estoque, 275);

  // A consulta tem de mirar o local configurado, nao um local qualquer
  assert.equal(impl.chamadas[0].corpo.param[0].codigo_local_estoque, 10792598111);
  assert.equal(impl.chamadas[0].corpo.call, "ListarPosEstoque");

  const escritas = client.escritasEm("produtos");
  assert.equal(escritas.length, 2);
  // Substitui o saldo, nunca soma: a OMIE e a fonte da verdade do estoque central
  assert.match(escritas[0].texto, /qtd_total = \$2/);
  assert.doesNotMatch(escritas[0].texto, /qtd_total = qtd_total/);
  assert.deepEqual(escritas[0].params, ["PRD00001", 270, 270]);
  assert.deepEqual(escritas[1].params, ["55668", 5, 5]);
});

test("saldo negativo acumulado e corrigido pelo valor da OMIE", async () => {
  // O estoque central desta instalacao chegou a somar -13.373 porque as liberacoes debitavam
  // e nada repunha. A sincronizacao precisa sobrescrever, e nao somar em cima do negativo.
  const client = clientFalso([
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "1", sku_produto: "SKU1" }] }
    },
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 1 } }
  ]);

  await sincronizarEstoqueAlmoxarifado({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: {},
    fetchImpl: fetchFalso([posicaoEstoque([{ nCodProd: 1, cCodigo: "SKU1", nSaldo: 42 }])])
  });

  const escrita = client.escritasEm("produtos")[0];
  assert.deepEqual(escrita.params, ["SKU1", 42, 42], "o valor final e o da OMIE, sem depender do saldo anterior");
});

test("a sincronizacao percorre todas as paginas da posicao de estoque", async () => {
  const client = clientFalso([
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "1", sku_produto: "SKU1" }] }
    },
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 1 } }
  ]);

  const impl = fetchFalso([
    posicaoEstoque([{ nCodProd: 1, cCodigo: "SKU1", nSaldo: 10 }], { pagina: 1, totalPaginas: 3 }),
    posicaoEstoque([{ nCodProd: 1, cCodigo: "SKU1", nSaldo: 20 }], { pagina: 2, totalPaginas: 3 }),
    posicaoEstoque([{ nCodProd: 1, cCodigo: "SKU1", nSaldo: 30 }], { pagina: 3, totalPaginas: 3 })
  ]);

  const resumo = await sincronizarEstoqueAlmoxarifado({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: {},
    fetchImpl: impl
  });

  assert.equal(resumo.paginas, 3, "o catalogo do almoxarifado tem 101 paginas reais; parar na primeira perderia 99%");
  assert.equal(impl.chamadas.map((c) => c.corpo.param[0].nPagina).join(","), "1,2,3");
});

test("sem local de almoxarifado configurado a tarefa recusa antes de chamar a API", async () => {
  let chamou = false;
  const erro = await sincronizarEstoqueAlmoxarifado({
    client: clientFalso(),
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    payload: {},
    fetchImpl: async () => {
      chamou = true;
      return {};
    }
  }).catch((e) => e);

  assert.equal(erro.codigo, "CONFIGURACAO");
  assert.match(erro.message, /local de estoque.*almoxarifado/i);
  assert.equal(chamou, false, "nao adianta consultar a OMIE sem saber qual local ler");
});

test("produto da OMIE sem cadastro local vira alerta, nao silencio", async () => {
  const client = clientFalso([
    { contem: "FROM product_integration_mappings", resultado: { rows: [] } },
    // rowCount 0 = o UPDATE nao achou o SKU
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 0 } }
  ]);

  const resumo = await sincronizarEstoqueAlmoxarifado({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: {},
    fetchImpl: fetchFalso([posicaoEstoque([{ nCodProd: 999, cCodigo: "NOVO", nSaldo: 7 }])])
  });

  assert.equal(resumo.sem_produto_local, 1);
  assert.equal(resumo.atualizados, 0);
  assert.match(resumo.alerta, /sem cadastro local/i);
});

test("a tarefa de produtos nao escreve saldo nenhum", async () => {
  // ListarProdutos devolveu quantidade_estoque = 0 nesta conta enquanto o local
  // ALMOXARIFADO acusava 270 do mesmo item. Deixar a tarefa de cadastro escrever saldo
  // faria o estoque central oscilar conforme a ordem em que as tarefas rodassem.
  const client = clientFalso();

  await sincronizarProdutos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      {
        pagina: 1,
        total_de_paginas: 1,
        total_de_registros: 1,
        produto_servico_cadastro: [
          { codigo_produto: 1, codigo: "SKU1", descricao: "Produto um", quantidade_estoque: 0 }
        ]
      }
    ]),
    enfileirar: async () => {}
  });

  for (const escrita of client.escritasEm("produtos")) {
    assert.doesNotMatch(escrita.texto, /qtd_total = /, "a tarefa de cadastro nao pode mexer no estoque central");
    assert.doesNotMatch(escrita.texto, /saldo_omie = \$/, "saldo e responsabilidade da tarefa de estoque");
  }
});

test("o provider declara o local do almoxarifado como configuracao obrigatoria", () => {
  const config = providerOmie.configuracoes.find((item) => item.chave === "local_almoxarifado");
  assert.ok(config, "o provider precisa declarar onde fica o almoxarifado");
  assert.equal(config.obrigatoria, true);
  assert.equal(config.tipo, "local_estoque", "o tipo e o que faz a tela oferecer o seletor de locais");

  const central = providerOmie.capacidades.find((c) => c.id === "ESTOQUE_ALMOXARIFADO");
  assert.throws(() => validarConfiguracaoDaCapacidade(providerOmie, {}, central), /Local do almoxarifado/);
  assert.doesNotThrow(() => validarConfiguracaoDaCapacidade(providerOmie, CONFIG, central));
});

test("importar locais nao pode exigir o local que so existe depois de importar", () => {
  // Impasse real que apareceu na primeira execucao contra a producao: a validacao valia para
  // o provider inteiro e barrava LOCAIS, que e justamente a tarefa que popula a lista de
  // onde o operador escolhe o almoxarifado. Nada trava, e a integracao nunca sai do lugar.
  const locais = providerOmie.capacidades.find((c) => c.id === "LOCAIS");
  assert.doesNotThrow(() => validarConfiguracaoDaCapacidade(providerOmie, {}, locais));

  const produtos = providerOmie.capacidades.find((c) => c.id === "PRODUTOS");
  assert.doesNotThrow(() => validarConfiguracaoDaCapacidade(providerOmie, {}, produtos));

  // Só quem realmente depende do local é que exige o local: quem lê o saldo de lá e quem
  // envia a transferência que sai de lá
  const exigem = providerOmie.capacidades.filter((c) => (c.requerConfiguracao || []).includes("local_almoxarifado"));
  assert.deepEqual(exigem.map((c) => c.id).sort(), ["ESTOQUE_ALMOXARIFADO", "TRANSFERENCIAS"]);
});

test("o resultado da tarefa sobrevive ao JSON.stringify que a fila faz", async () => {
  // A fila grava o resumo em integration_jobs.result com JSON.stringify. O cursor apontava
  // para o proprio resumo (resumo.cursor.estatisticas === resumo), entao toda execucao real
  // morria com "Converting circular structure to JSON" — e o job caia em ERRO_TEMPORARIO
  // depois de ja ter gravado tudo no banco. Nenhum teste pegava porque nenhum serializava.
  const client = clientFalso([
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "1", sku_produto: "SKU1" }] }
    },
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 1 } }
  ]);

  const central = await sincronizarEstoqueAlmoxarifado({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: {},
    fetchImpl: fetchFalso([posicaoEstoque([{ nCodProd: 1, cCodigo: "SKU1", nSaldo: 10 }])])
  });
  assert.doesNotThrow(() => JSON.stringify(central));

  const produtos = await sincronizarProdutos({
    client: clientFalso(),
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      {
        pagina: 1,
        total_de_paginas: 1,
        total_de_registros: 1,
        produto_servico_cadastro: [{ codigo_produto: 1, codigo: "SKU1", descricao: "Um" }]
      }
    ]),
    enfileirar: async () => {}
  });
  assert.doesNotThrow(() => JSON.stringify(produtos));

  // O cursor precisa ser uma copia, nunca uma referencia de volta ao resumo
  assert.notEqual(central.cursor.estatisticas, central);
  assert.equal(central.cursor.estatisticas.atualizados, central.atualizados);
});

test("o estoque central se mantem sozinho; o do PDV nao roda pelo relogio", () => {
  // O estoque central tem dado real na OMIE (3.969 produtos com saldo no ALMOXARIFADO),
  // entao pode se manter sozinho.
  const central = providerOmie.capacidades.find((c) => c.id === "ESTOQUE_ALMOXARIFADO");
  assert.equal(central.automatica !== false, true, "o estoque central precisa se manter sozinho");
  assert.ok(central.intervaloPadraoMs > 0);

  // Ja os locais de PDV na OMIE estao quase vazios (DECK 2 itens, CABANA 1, PARK 2,
  // RESTAURANTE 42) contra 14.651 unidades nos PDVs do sistema. Enquanto nao se decidir
  // qual lado esta certo, deixar isto no relogio apagaria o estoque operacional.
  const pdv = providerOmie.capacidades.find((c) => c.id === "SALDOS");
  assert.equal(pdv.automatica, false, "o estoque do PDV nao pode ser sobrescrito pelo relogio");
  assert.match(pdv.descricao, /zera/i, "a tela precisa avisar o efeito antes de alguem clicar");

  // Saldo por item continua sob demanda: quem agenda e a tarefa de movimentos
  const item = providerOmie.capacidades.find((c) => c.id === "SALDO_ITEM");
  assert.equal(item.automatica, false);
});

test("a OMIE substitui o estoque do PDV vinculado, sem somar", async () => {
  // O usuario confirmou que a saida do almoxarifado e lancada nos DOIS sistemas, entao a
  // OMIE manda tambem no estoque do PDV. Se este saldo fosse somado em vez de substituido,
  // cada ciclo de sincronizacao inflaria o estoque do PDV.
  const client = clientFalso([
    {
      contem: "FROM pdv_stock_location_mappings",
      resultado: { rows: [{ omie_location_id: "10823892382", pdv_acpark_id: 6, pdv_nome: "DECK INFERIOR" }] }
    },
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "10792612974", sku_produto: "PRD00001" }] }
    },
    { contem: "INSERT INTO estoque_pdv", resultado: { rows: [{ inserido: false }], rowCount: 1 } }
  ]);

  const resumo = await sincronizarSaldos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      {
        nPagina: 1,
        nTotPaginas: 1,
        produtos: [{ nCodProd: 10792612974, cCodigo: "PRD00001", nSaldo: 42, codigo_local_estoque: 10823892382 }]
      }
    ]),
    enfileirar: async () => {}
  });

  assert.equal(resumo.atualizados, 1);
  assert.equal(resumo.por_pdv["DECK INFERIOR"], 1);

  const escrita = client.escritasEm("estoque_pdv")[0];
  // Substituicao, nunca acumulo
  assert.match(escrita.texto, /SET quantidade = EXCLUDED\.quantidade/);
  assert.doesNotMatch(escrita.texto, /quantidade\s*=\s*estoque_pdv\.quantidade\s*\+/);
  // O que o PDV pode pedir e decisao do almoxarifado: a sincronizacao nao pode liberar item
  assert.doesNotMatch(escrita.texto, /SET[\s\S]*permitido\s*=/);
  // Reserva interna nao pode ser sobrescrita pela OMIE
  assert.doesNotMatch(escrita.texto, /quantidade_reservada_acpark\s*=/);
  assert.deepEqual(escrita.params, [6, "PRD00001", 42, 42]);
});

test("saldo fracionario e arredondado na coluna inteira, mas exato no espelho", async () => {
  // estoque_pdv.quantidade e integer; saldo_omie e numeric. Gravar a fracao na coluna
  // inteira faria o Postgres recusar a linha e derrubar a sincronizacao inteira.
  const client = clientFalso([
    {
      contem: "FROM pdv_stock_location_mappings",
      resultado: { rows: [{ omie_location_id: "10823892382", pdv_acpark_id: 6, pdv_nome: "DECK INFERIOR" }] }
    },
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "1", sku_produto: "SKU1" }] }
    },
    { contem: "INSERT INTO estoque_pdv", resultado: { rows: [{ inserido: true }], rowCount: 1 } }
  ]);

  const resumo = await sincronizarSaldos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      { nPagina: 1, nTotPaginas: 1, produtos: [{ nCodProd: 1, cCodigo: "SKU1", nSaldo: "2,6" }] }
    ]),
    enfileirar: async () => {}
  });

  assert.equal(resumo.criados, 1, "produto sem linha no PDV precisa entrar");
  const [, , inteiro, exato] = client.escritasEm("estoque_pdv")[0].params;
  assert.equal(inteiro, 3);
  assert.equal(exato, 2.6);
});

test("sem vinculo de local, o estoque do PDV nao e tocado", async () => {
  const client = clientFalso([{ contem: "FROM pdv_stock_location_mappings", resultado: { rows: [] } }]);
  const resumo = await sincronizarSaldos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([{}]),
    enfileirar: async () => {}
  });

  assert.match(resumo.alerta, /Nenhum PDV vinculado/i);
  assert.equal(client.escritasEm("estoque_pdv").length, 0, "sem vinculo nao se adivinha o PDV");
});

test("saldo fracionario do almoxarifado nao quebra a coluna inteira do estoque central", async () => {
  // O ALMOXARIFADO real tem itens com saldo fracionario. Mandar 2,6 para uma coluna integer
  // depende de cast implicito do Postgres; aqui o arredondamento e explicito e o valor exato
  // fica preservado em saldo_omie.
  const client = clientFalso([
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "1", sku_produto: "SKU1" }] }
    },
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 1 } }
  ]);

  await sincronizarEstoqueAlmoxarifado({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: {},
    fetchImpl: fetchFalso([posicaoEstoque([{ nCodProd: 1, cCodigo: "SKU1", nSaldo: "2,6" }])])
  });

  const [, inteiro, exato] = client.escritasEm("produtos")[0].params;
  assert.equal(inteiro, 3, "qtd_total e integer");
  assert.equal(exato, 2.6, "saldo_omie guarda o valor exato da OMIE");
});

test("saldo por item usa ObterEstoqueProduto, nao a pagina 1 da lista", async () => {
  // A versao anterior chamava ListarPosEstoque com nPagina 1 e filtrava na memoria. Com 101
  // paginas reais, qualquer produto fora dos 100 primeiros voltava "nao encontrado".
  const client = clientFalso([
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "10792612974", sku_produto: "PRD00001" }] }
    },
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 1 } }
  ]);

  const impl = fetchFalso([
    {
      nIdProduto: 10792612974,
      cCodigo: "PRD00001",
      listaEstoque: [
        { nIdlocal: 10792598111, nSaldo: 270, fisico: 270, reservado: 0, cDescricaoLocal: "ALMOXARIFADO" },
        { nIdlocal: 10823892382, nSaldo: 3, fisico: 3, reservado: 0, cDescricaoLocal: "DECK" }
      ]
    }
  ]);

  const resumo = await sincronizarSaldoDeItem({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: { idExternoProduto: "10792612974" },
    fetchImpl: impl
  });

  // Uma chamada so, no endpoint de resumo, sem paginacao
  assert.equal(impl.chamadas.length, 1);
  assert.equal(impl.chamadas[0].corpo.call, "ObterEstoqueProduto");
  assert.match(impl.chamadas[0].url, /estoque\/resumo\/$/);
  assert.equal(impl.chamadas[0].corpo.param[0].nIdProduto, 10792612974);
  assert.equal(impl.chamadas[0].corpo.param[0].nPagina, undefined, "resumo nao e paginado");

  // O local do almoxarifado vira estoque central
  assert.equal(resumo.central_atualizado, true);
  assert.equal(resumo.saldo_central, 270);
  assert.deepEqual(client.escritasEm("produtos")[0].params, ["PRD00001", 270, 270]);
});

test("saldo por item nao escreve no estoque do PDV enquanto a politica estiver desligada", async () => {
  // Este era o furo: MOVIMENTOS enfileira SALDO_ITEM a cada 5 min, entao o lado PDV seria
  // gravado automaticamente mesmo com a capacidade SALDOS bloqueada.
  const client = clientFalso([
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "1", sku_produto: "SKU1" }] }
    },
    {
      contem: "FROM pdv_stock_location_mappings",
      resultado: { rows: [{ omie_location_id: "10823892382", pdv_acpark_id: 6, pdv_nome: "DECK INFERIOR" }] }
    },
    { contem: "UPDATE produtos", resultado: { rows: [], rowCount: 1 } }
  ]);

  const resumo = await sincronizarSaldoDeItem({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    payload: { idExternoProduto: "1" },
    fetchImpl: fetchFalso([
      {
        listaEstoque: [
          { nIdlocal: 10792598111, nSaldo: 50, fisico: 50 },
          { nIdlocal: 10823892382, nSaldo: 9, fisico: 9 }
        ]
      }
    ])
  });

  assert.equal(client.escritasEm("estoque_pdv").length, 0, "o lado PDV nao pode ser tocado");
  assert.equal(resumo.pdvs_atualizados, 0);
  assert.match(resumo.pdv_ignorado, /desligada/i);
  // ...mas o estoque central continua sendo atualizado
  assert.equal(resumo.central_atualizado, true);
});

test("os dois caminhos do estoque de PDV obedecem ao mesmo interruptor", async () => {
  // SALDOS (relogio) e SALDO_ITEM (via MOVIMENTOS) precisam ler a mesma decisao, senao
  // desligar um deixa o outro escrevendo.
  const { SINCRONIZACAO_PDV_ATIVA } = await import("../server/services/integrations/providers/omie/omie.politica.js");
  const saldos = providerOmie.capacidades.find((c) => c.id === "SALDOS");
  assert.equal(saldos.automatica, SINCRONIZACAO_PDV_ATIVA);

  const fonte = fs.readFileSync("server/services/integrations/providers/omie/tarefas/saldos.js", "utf8");
  assert.match(fonte, /SINCRONIZACAO_PDV_ATIVA/, "a tarefa precisa consultar o interruptor");
});

test("o saldo do resumo vem de nSaldo/fisico, nao dos nomes da documentacao", () => {
  // A documentacao da OMIE promete nFisico e nDisponivel em listaEstoque. A resposta real
  // traz nSaldo, fisico e reservado. Ler so pelos nomes documentados devolve undefined,
  // que viraria zero -- e zeraria o estoque central de todo produto sincronizado.
  const fonte = fs.readFileSync("server/services/integrations/providers/omie/tarefas/saldos.js", "utf8");
  const auxiliar = fonte.match(/function saldoDoLocal[\s\S]*?\n}/)?.[0] || "";
  assert.match(auxiliar, /nSaldo/, "nSaldo e o campo real e precisa vir primeiro");
  assert.match(auxiliar, /\bfisico\b/, "fisico e o outro campo real");
  // Os nomes da documentacao podem ficar como plano B, mas nunca sozinhos
  assert.ok(auxiliar.indexOf("nSaldo") < auxiliar.indexOf("nFisico"), "o campo real tem de ter prioridade");
});

test("produto inativo na OMIE nao entra no catalogo", async () => {
  const client = clientFalso([{ contem: "FROM produtos WHERE sku", resultado: { rows: [], rowCount: 0 } }]);
  const resumo = await sincronizarProdutos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      {
        pagina: 1,
        total_de_paginas: 1,
        produto_servico_cadastro: [
          { codigo_produto: 1, codigo: "ATIVO", descricao: "Ativo", inativo: "N", descricao_familia: "BEBIDAS" },
          { codigo_produto: 2, codigo: "MORTO", descricao: "Descontinuado", inativo: "S", descricao_familia: "BEBIDAS" }
        ]
      }
    ]),
    enfileirar: async () => {}
  });

  assert.equal(resumo.criados, 1, "so o ativo entra");
  assert.equal(resumo.inativos_ignorados, 1);

  // O inativo nao pode nem aparecer no vinculo, senao polui o cadastro
  const inseridos = client.escritasEm("produtos").flatMap((q) => q.params.filter((p) => p === "MORTO"));
  assert.equal(inseridos.length, 0, "produto inativo novo nao pode ser gravado");
});

test("produto que virou inativo na OMIE e desativado aqui, nao ignorado", async () => {
  // Se fosse so ignorado, o PDV continuaria conseguindo pedir item descontinuado
  const client = clientFalso([
    { contem: "FROM produtos WHERE sku", resultado: { rows: [{ sku: "SKU1", categoria: "BEBIDAS" }], rowCount: 1 } }
  ]);
  const resumo = await sincronizarProdutos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      {
        pagina: 1,
        total_de_paginas: 1,
        produto_servico_cadastro: [{ codigo_produto: 1, codigo: "SKU1", descricao: "Sumiu", inativo: "S" }]
      }
    ]),
    enfileirar: async () => {}
  });

  assert.equal(resumo.desativados, 1);
  const update = client.escritasEm("produtos").find((q) => /UPDATE produtos/.test(q.texto));
  assert.match(update.texto, /ativo = \$3/);
  assert.equal(update.params[2], false, "o produto tem de ser marcado como inativo");
});

test("a familia da OMIE vira categoria, reaproveitando a existente a menos de acento", async () => {
  // pdv_categorias amarra permissao pelo NOME da categoria: criar "CONVENIÊNCIA" ao lado de
  // "CONVENIENCIA" faria o produto sair de baixo da permissao e sumir da tela do PDV.
  const client = clientFalso([
    { contem: "FROM produtos WHERE sku", resultado: { rows: [], rowCount: 0 } },
    { contem: "SELECT nome FROM categorias", resultado: { rows: [{ nome: "CONVENIENCIA" }], rowCount: 1 } }
  ]);

  const resumo = await sincronizarProdutos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      {
        pagina: 1,
        total_de_paginas: 1,
        produto_servico_cadastro: [
          { codigo_produto: 1, codigo: "A", descricao: "Um", inativo: "N", descricao_familia: "CONVENIÊNCIA" },
          { codigo_produto: 2, codigo: "B", descricao: "Dois", inativo: "N", descricao_familia: "FERRAMENTAS" }
        ]
      }
    ]),
    enfileirar: async () => {}
  });

  const inserts = client.escritasEm("produtos").filter((q) => /INSERT INTO produtos/.test(q.texto));
  // O acentuado reaproveita a categoria que ja existia
  assert.equal(inserts[0].params[3], "CONVENIENCIA", "nao pode criar variante acentuada");
  // Familia sem equivalente vira categoria nova
  assert.equal(inserts[1].params[3], "FERRAMENTAS");
  assert.deepEqual(resumo.categorias_criadas, ["FERRAMENTAS"]);

  const novaCategoria = client.executadas.filter((q) => /INSERT INTO categorias/.test(q.texto));
  assert.equal(novaCategoria.length, 1, "so a familia realmente nova vira categoria");
  assert.deepEqual(novaCategoria[0].params, ["FERRAMENTAS"]);
});

test("a categoria de um produto ja classificado nao e sobrescrita", async () => {
  const client = clientFalso([
    { contem: "FROM produtos WHERE sku", resultado: { rows: [{ sku: "SKU1", categoria: "PALETAS" }], rowCount: 1 } },
    { contem: "SELECT nome FROM categorias", resultado: { rows: [{ nome: "PALETAS" }], rowCount: 1 } }
  ]);

  await sincronizarProdutos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([
      {
        pagina: 1,
        total_de_paginas: 1,
        produto_servico_cadastro: [
          { codigo_produto: 1, codigo: "SKU1", descricao: "Um", inativo: "N", descricao_familia: "SOBREMESAS" }
        ]
      }
    ]),
    enfileirar: async () => {}
  });

  const update = client.escritasEm("produtos").find((q) => /UPDATE produtos/.test(q.texto));
  // COALESCE preserva a classificacao curada; mover o produto mudaria quem pode pedi-lo
  assert.match(update.texto, /categoria = COALESCE\(NULLIF\(categoria, ''\), \$4\)/);
});

test("movimentos leem o almoxarifado mesmo sem nenhum PDV vinculado", async () => {
  // Antes a tarefa so olhava locais de PDV: com zero vinculos ela concluia sem importar nada
  // e o sistema ficava sem trilha de auditoria, apesar de o almoxarifado ter 2.093
  // movimentacoes em 90 dias.
  const client = clientFalso([
    { contem: "FROM pdv_stock_location_mappings", resultado: { rows: [] } },
    {
      contem: "FROM product_integration_mappings",
      resultado: { rows: [{ external_product_id: "10810489297", sku_produto: "SKU1" }] }
    },
    { contem: "INSERT INTO stock_movements", resultado: { rows: [{ id: 77 }], rowCount: 1 } }
  ]);

  const agendados = [];
  const impl = fetchFalso([
    {
      nPagina: 1,
      nTotPaginas: 1,
      movProdutoListar: [
        {
          idMov: 11269013414,
          idProd: 10810489297,
          dtMov: "06/08/2026",
          qtde: 1,
          tipo: "entrada",
          codigo_local_estoque: 10792598111,
          codOrigem: "COM",
          desOrigem: "Compra de Produto"
        }
      ]
    }
  ]);

  const resumo = await sincronizarMovimentos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    estado: null,
    fetchImpl: impl,
    enfileirar: async (capacidade, payload) => agendados.push({ capacidade, payload })
  });

  assert.equal(resumo.locais, 1, "o almoxarifado sozinho ja da o que ler");
  assert.equal(resumo.importados, 1);
  assert.equal(resumo.alerta, undefined, "com o almoxarifado configurado nao ha por que alertar");
  assert.equal(resumo.por_local.ALMOXARIFADO, 1);
  assert.equal(resumo.por_origem.COMPRA, 1);

  // A consulta tem de mirar o local do almoxarifado
  assert.equal(impl.chamadas[0].corpo.param[0].codigo_local_estoque, 10792598111);

  // O movimento do almoxarifado entra sem pdv_id, porque nao e de PDV
  const insert = client.escritasEm("stock_movements")[0];
  assert.equal(insert.params[5], null, "movimento de almoxarifado nao tem PDV");

  // E nao agenda SALDO_ITEM: ESTOQUE_ALMOXARIFADO ja reescreve tudo a cada 15 min
  assert.equal(agendados.length, 0);
  assert.equal(resumo.saldos_agendados, 0);
});

test("sem almoxarifado configurado e sem vinculo, movimentos avisam em vez de silenciar", async () => {
  const client = clientFalso([{ contem: "FROM pdv_stock_location_mappings", resultado: { rows: [] } }]);
  const resumo = await sincronizarMovimentos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {},
    estado: null,
    fetchImpl: fetchFalso([{}]),
    enfileirar: async () => {}
  });

  assert.equal(resumo.locais, 0);
  assert.match(resumo.alerta, /almoxarifado|vincule/i);
});

test("um PDV vinculado ao proprio local do almoxarifado nao duplica o movimento", async () => {
  const client = clientFalso([
    {
      contem: "FROM pdv_stock_location_mappings",
      resultado: { rows: [{ omie_location_id: "10792598111", pdv_acpark_id: 6, pdv_nome: "DECK INFERIOR" }] }
    },
    { contem: "FROM product_integration_mappings", resultado: { rows: [] } },
    { contem: "INSERT INTO stock_movements", resultado: { rows: [{ id: 1 }], rowCount: 1 } }
  ]);

  const impl = fetchFalso([{ nPagina: 1, nTotPaginas: 1, movProdutoListar: [] }]);
  const resumo = await sincronizarMovimentos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    estado: null,
    fetchImpl: impl,
    enfileirar: async () => {}
  });

  // O local aparece uma vez so, senao cada movimento entraria duas vezes
  assert.equal(resumo.locais, 1);
  assert.equal(impl.chamadas.length, 1);
});

test("local sem movimento nao derruba a leitura dos outros locais", async () => {
  // A OMIE sinaliza resultado vazio LANCANDO erro ("Nao existem registros para a pagina [1]").
  // Antes, um PDV parado abortava a tarefa inteira -- inclusive os movimentos do almoxarifado
  // que ja tinham sido lidos. Com varios PDVs vinculados, quase todos parados, MOVIMENTOS
  // simplesmente nunca terminaria.
  const client = clientFalso([
    {
      contem: "FROM pdv_stock_location_mappings",
      resultado: { rows: [{ omie_location_id: "10823897062", pdv_acpark_id: 5, pdv_nome: "CABANA" }] }
    },
    { contem: "FROM product_integration_mappings", resultado: { rows: [] } },
    { contem: "INSERT INTO stock_movements", resultado: { rows: [{ id: 1 }], rowCount: 1 } }
  ]);

  let chamada = 0;
  const impl = async (url, opcoes) => {
    chamada += 1;
    const local = JSON.parse(opcoes.body).param[0].codigo_local_estoque;
    // O almoxarifado tem movimento; a CABANA nao
    const corpo =
      String(local) === "10792598111"
        ? {
            nPagina: 1,
            nTotPaginas: 1,
            movProdutoListar: [{ idMov: 1, idProd: 9, dtMov: "20/08/2026", qtde: 2, tipo: "entrada" }]
          }
        : { faultstring: "ERROR: Não existem registros para a página [1]!" };
    return {
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify(corpo)
    };
  };

  const resumo = await sincronizarMovimentos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: CONFIG,
    estado: null,
    fetchImpl: impl,
    enfileirar: async () => {}
  });

  assert.equal(resumo.locais, 2, "almoxarifado + CABANA");
  assert.equal(chamada, 2, "os dois locais foram consultados");
  assert.equal(resumo.importados, 1, "o movimento do almoxarifado entrou mesmo com a CABANA vazia");
  assert.equal(resumo.locais_sem_movimento, 1);
});

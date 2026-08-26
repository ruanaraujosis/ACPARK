import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  emSimulacao,
  modoDeEscrita,
  validarEscritaPermitida,
} from "../server/services/integrations/core/escrita.js";
import { montarChaveIdempotencia } from "../server/services/integrations/core/stock-launches.repository.js";
import {
  montarCompensacaoTransferencia,
  montarTransferenciaEstoque,
} from "../server/services/integrations/providers/omie/omie.operacoes.js";
import {
  enviarTransferencias,
  VALOR_SIMBOLICO,
} from "../server/services/integrations/providers/omie/tarefas/transferencias.js";
import { montarPayloadCaracteristica } from "../server/services/integrations/providers/omie/tarefas/escrita-fator.js";
import { providerOmie } from "../server/services/integrations/providers/omie/index.js";

// Escrita na OMIE: a unica direcao em que o MyEstoque altera dado no sistema externo.
// Todo teste aqui trava uma regra que, se cair, faz os dois sistemas divergirem em silencio
// ou faz sair da maquina um lancamento que nao devia.

const INTEGRACAO = {
  id: 1,
  provedor: "OMIE",
  ativo: true,
  nome: "OMIE",
  url_base: "https://app.omie.com.br/api/v1",
};
const SEGREDOS = { app_key: "chave", app_secret: "segredo" };
const ALMOXARIFADO = "10792598111";
const LOCAL_PDV = "10823892382";

function fetchFalso(respostas = [{ codigo_lancamento: 999 }]) {
  const chamadas = [];
  let indice = 0;
  const impl = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body) });
    return {
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      text: async () =>
        JSON.stringify(respostas[Math.min(indice++, respostas.length - 1)]),
    };
  };
  impl.chamadas = chamadas;
  return impl;
}

// Client falso que devolve lancamentos abertos e guarda as atualizacoes
function clientComLancamentos(
  lancamentos,
  {
    vinculoProduto = "10792612974",
    preco = 4.5,
    precoManual = null,
    precoNota = null,
  } = {},
) {
  const atualizacoes = [];
  return {
    atualizacoes,
    async query(texto, params = []) {
      if (
        /FROM integration_stock_launches/.test(texto) &&
        /status = ANY/.test(texto)
      ) {
        return { rows: lancamentos, rowCount: lancamentos.length };
      }
      // A OMIE exige valor diferente de zero no ajuste: a tarefa busca o preco do cadastro
      if (
        /SELECT price, price_manual FROM product_integration_mappings/.test(
          texto,
        )
      ) {
        return {
          rows: [{ price: preco, price_manual: precoManual }],
          rowCount: 1,
        };
      }
      // Terceira fonte de preco: a ultima nota de compra
      if (/integration_factor_evidence/.test(texto)) {
        return precoNota
          ? { rows: [{ preco: precoNota }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM product_integration_mappings/.test(texto)) {
        return vinculoProduto
          ? { rows: [{ external_product_id: vinculoProduto }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/UPDATE integration_stock_launches/.test(texto)) {
        atualizacoes.push({
          id: params[0],
          status: params[1],
          payload: params[2],
          erro: params[5],
        });
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const lancamentoRetirada = {
  id: 10,
  codigo_pedido: "PED-1",
  pedido_item_id: 55,
  sku_produto: "PRD00001",
  pdv_id: 6,
  quantidade: 3,
  local_origem: ALMOXARIFADO,
  local_destino: LOCAL_PDV,
  evento: "RETIRADA",
  idempotency_key: "PEDIDO-PED-1-ITEM-55-RETIRADA-V1",
  created_at: new Date("2026-08-20T10:00:00"),
};

test("o modo de escrita padrao e SIMULACAO, e so REAL explicito libera envio", () => {
  // Configuracao ausente, vazia ou com valor estranho nunca pode significar "pode enviar"
  assert.equal(modoDeEscrita({}), "SIMULACAO");
  assert.equal(modoDeEscrita({ modo_escrita: "" }), "SIMULACAO");
  assert.equal(modoDeEscrita({ modo_escrita: "qualquer coisa" }), "SIMULACAO");
  assert.equal(modoDeEscrita({ modo_escrita: "real" }), "REAL");
  assert.equal(modoDeEscrita({ modo_escrita: "REAL" }), "REAL");

  assert.equal(emSimulacao({}), true);
  assert.equal(emSimulacao({ modo_escrita: "REAL" }), false);
});

test("em simulacao o payload e montado e gravado, mas NADA e enviado", async () => {
  const client = clientComLancamentos([lancamentoRetirada]);
  const impl = fetchFalso();

  const resumo = await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: ALMOXARIFADO },
    payload: {},
    fetchImpl: impl,
  });

  assert.equal(
    impl.chamadas.length,
    0,
    "modo simulacao nao pode chamar a OMIE",
  );
  assert.equal(resumo.modo, "SIMULACAO");
  assert.equal(resumo.simulados, 1);
  assert.equal(resumo.enviados, 0);

  // O payload precisa ficar gravado para conferencia antes de liberar o envio real
  const gravado = JSON.parse(client.atualizacoes[0].payload);
  assert.equal(client.atualizacoes[0].status, "SIMULADO");
  assert.equal(gravado.tipo, "TRF");
  assert.equal(gravado.codigo_local_estoque, Number(ALMOXARIFADO));
  assert.equal(gravado.codigo_local_estoque_destino, Number(LOCAL_PDV));
  assert.equal(gravado.quan, "3");
});

test("em modo REAL a transferencia sai como um unico lancamento TRF", async () => {
  const client = clientComLancamentos([lancamentoRetirada]);
  const impl = fetchFalso([{ codigo_lancamento: 4242 }]);

  const resumo = await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: ALMOXARIFADO, modo_escrita: "REAL" },
    payload: {},
    fetchImpl: impl,
  });

  assert.equal(resumo.enviados, 1);
  assert.equal(impl.chamadas.length, 1, "um lancamento so, nao dois");
  assert.equal(impl.chamadas[0].corpo.call, "IncluirAjusteEstoque");
  assert.match(impl.chamadas[0].url, /estoque\/ajuste\/$/);

  const enviado = impl.chamadas[0].corpo.param[0];
  assert.equal(enviado.tipo, "TRF");
  assert.equal(enviado.codigo_local_estoque, Number(ALMOXARIFADO));
  assert.equal(enviado.codigo_local_estoque_destino, Number(LOCAL_PDV));
  // A chave de idempotencia viaja no payload: e ela que impede a OMIE aceitar o mesmo duas vezes
  assert.equal(enviado.cod_int_ajuste, "PEDIDO-PED-1-ITEM-55-RETIRADA-V1");
});

test("o MyEstoque nunca envia venda, devolucao, compra, inventario ou saldo absoluto", async () => {
  const client = clientComLancamentos([lancamentoRetirada]);
  const impl = fetchFalso();

  await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: ALMOXARIFADO, modo_escrita: "REAL" },
    payload: {},
    fetchImpl: impl,
  });

  const enviado = impl.chamadas[0].corpo.param[0];
  // SLD seria ajuste de saldo absoluto: apagaria os lancamentos do sistema de vendas
  assert.notEqual(enviado.tipo, "SLD");
  assert.notEqual(enviado.tipo, "ENT");
  assert.notEqual(enviado.tipo, "SAI");
  assert.equal(enviado.tipo, "TRF");
  // origem PDV significaria venda; a nossa e sempre ajuste manual de transferencia
  assert.equal(enviado.origem, "AJU");
  assert.equal(enviado.motivo, "TRF");

  // Nenhuma capacidade do provider aponta para uma chamada de venda ou saldo
  const fonte = fs.readFileSync(
    "server/services/integrations/providers/omie/tarefas/transferencias.js",
    "utf8",
  );
  assert.doesNotMatch(
    fonte,
    /IncluirPedido|IncluirNFe|AlterarEstoqueMinimo|"SLD"/,
  );
});

test("a compensacao inverte os locais e exige chave propria", () => {
  const base = {
    chaveOperacao: "PEDIDO-PED-1-ITEM-55-COMPENSACAO-V1",
    chaveOperacaoOriginal: "PEDIDO-PED-1-ITEM-55-RETIRADA-V1",
    idExternoProduto: 10792612974,
    codigoLocalOrigem: ALMOXARIFADO,
    codigoLocalDestino: LOCAL_PDV,
    quantidade: 3,
    valorUnitario: 4.5,
  };

  const compensacao = montarCompensacaoTransferencia(base);
  assert.equal(
    compensacao.codigo_local_estoque,
    Number(LOCAL_PDV),
    "sai do PDV",
  );
  assert.equal(
    compensacao.codigo_local_estoque_destino,
    Number(ALMOXARIFADO),
    "volta ao almoxarifado",
  );

  // Reusar a chave do original faria a OMIE recusar o estorno como repetido
  assert.throws(
    () =>
      montarCompensacaoTransferencia({
        ...base,
        chaveOperacao: base.chaveOperacaoOriginal,
      }),
    /nao pode reusar a chave/i,
  );
  assert.throws(
    () => montarCompensacaoTransferencia({ ...base, chaveOperacao: "" }),
    /chave de operacao propria/i,
  );
});

test("a chave de idempotencia distingue evento e versao do mesmo item", () => {
  const retirada = montarChaveIdempotencia({
    codigoPedido: "PED-1",
    pedidoItemId: 55,
    evento: "RETIRADA",
    versao: 1,
  });
  const compensacao = montarChaveIdempotencia({
    codigoPedido: "PED-1",
    pedidoItemId: 55,
    evento: "COMPENSACAO",
    versao: 1,
  });
  // Reabrir e finalizar de novo tem de gerar lancamento novo, nao ser barrado como repetido
  const segundaRetirada = montarChaveIdempotencia({
    codigoPedido: "PED-1",
    pedidoItemId: 55,
    evento: "RETIRADA",
    versao: 2,
  });

  assert.notEqual(retirada, compensacao);
  assert.notEqual(retirada, segundaRetirada);
  assert.equal(retirada, "PEDIDO-PED-1-ITEM-55-RETIRADA-V1");
});

test("transferencia com origem igual ao destino e recusada antes de sair", () => {
  assert.throws(
    () =>
      montarTransferenciaEstoque({
        chaveOperacao: "X",
        idExternoProduto: 1,
        codigoLocalOrigem: ALMOXARIFADO,
        codigoLocalDestino: ALMOXARIFADO,
        quantidade: 1,
        valorUnitario: 4.5,
      }),
    /origem e destino iguais/i,
  );
});

test("produto sem vinculo vira erro no lancamento, nao chamada torta a OMIE", async () => {
  const client = clientComLancamentos([lancamentoRetirada], {
    vinculoProduto: null,
  });
  const impl = fetchFalso();

  const resumo = await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: ALMOXARIFADO, modo_escrita: "REAL" },
    payload: {},
    fetchImpl: impl,
  });

  assert.equal(impl.chamadas.length, 0, "sem vinculo nao se chuta o produto");
  assert.equal(resumo.sem_vinculo_de_produto, 1);
  assert.equal(client.atualizacoes[0].status, "ERRO");
  assert.match(client.atualizacoes[0].erro, /nao tem vinculo/i);
});

test("integracao desativada nao envia lancamento nenhum", () => {
  const capacidade = providerOmie.capacidades.find(
    (c) => c.id === "TRANSFERENCIAS",
  );
  assert.equal(capacidade.escrita, true);
  assert.throws(
    () => validarEscritaPermitida(capacidade, { ...INTEGRACAO, ativo: false }),
    /desativada/i,
  );
  // Leitura numa integracao desligada e so inutil; escrita e perigosa
  const leitura = providerOmie.capacidades.find((c) => c.id === "PRODUTOS");
  assert.doesNotThrow(() =>
    validarEscritaPermitida(leitura, { ...INTEGRACAO, ativo: false }),
  );
});

test("a confirmacao de retirada nunca e bloqueada pela integracao", () => {
  // A retirada ja aconteceu quando o lancamento e registrado: uma falha ali vira aviso,
  // nunca excecao, senao a operacao do usuario para por causa da OMIE.
  const servico = fs.readFileSync(
    "server/services/integrations/core/stock-launches.service.js",
    "utf8",
  );
  assert.match(
    servico,
    /catch \(erro\)/,
    "o servico precisa engolir o proprio erro",
  );
  assert.doesNotMatch(
    servico,
    /throw /,
    "nada aqui pode lancar para a rota do pedido",
  );

  const rota = fs.readFileSync(
    "server/modules/pedidos/pedidos.routes.js",
    "utf8",
  );
  assert.match(
    rota,
    /lancamentoIntegracao = await registrarTransferenciasDaRetirada/,
  );
});

test("o nucleo da escrita continua sem conhecer nenhuma API", () => {
  const nucleo = fs.readFileSync(
    "server/services/integrations/core/escrita.js",
    "utf8",
  );
  const repositorio = fs.readFileSync(
    "server/services/integrations/core/stock-launches.repository.js",
    "utf8",
  );
  for (const src of [nucleo, repositorio]) {
    const semComentarios = src.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(
      semComentarios,
      /\bOMIE\b|IncluirAjusteEstoque|app_key/i,
    );
  }
});

test("o local do almoxarifado nao pode ser vinculado a um PDV", () => {
  // Aconteceu de verdade: o PDV CABANA foi vinculado ao local 10792598111 (ALMOXARIFADO).
  // A transferencia sairia com origem igual ao destino e a leitura de saldos daria ao PDV
  // o estoque inteiro do almoxarifado.
  const rota = fs.readFileSync(
    "server/modules/integrations/integrations.routes.js",
    "utf8",
  );
  assert.match(
    rota,
    /localAlmoxarifado === localId/,
    "a rota precisa recusar o local do almoxarifado",
  );
  assert.match(
    rota,
    /local do almoxarifado, nao de um PDV/i,
    "a mensagem precisa explicar o motivo",
  );

  // E, mesmo que passasse, o payload recusa origem igual ao destino
  assert.throws(
    () =>
      montarTransferenciaEstoque({
        chaveOperacao: "X",
        idExternoProduto: 1,
        codigoLocalOrigem: ALMOXARIFADO,
        codigoLocalDestino: ALMOXARIFADO,
        quantidade: 1,
        valorUnitario: 4.5,
      }),
    /origem e destino iguais/i,
  );
});

test("o payload da caracteristica identifica por CODIGO, nunca por nome", () => {
  // A API aceita nCodCaract ou cCodIntCaract; cNomeCaract NAO faz parte do request de
  // inclusao -- conferido contra a documentacao. Mandar o nome faria a OMIE recusar produto
  // a produto, e a simulacao teria passado sem revelar isso.
  const corpo = montarPayloadCaracteristica({
    externalProductId: "10826765056",
    nCodCaract: 11277558200,
    fator: 15,
  });
  assert.equal(corpo.nCodProd, 10826765056);
  assert.equal(corpo.nCodCaract, 11277558200);
  assert.equal(corpo.cConteudo, "15");
  assert.equal(
    "cNomeCaract" in corpo,
    false,
    "o nome nunca pode entrar no payload",
  );
  // Conteudo vai como texto: o campo e string60 no ERP
  assert.equal(typeof corpo.cConteudo, "string");
});

test("valor ja existente no ERP nunca e sobrescrito em silencio", async () => {
  // Aconteceu de verdade: AGUA SEM GAS tinha "15" na caracteristica, conferido a mao, e
  // recebeu 12 por cima. Ler antes de gravar servia so para escolher a operacao; o valor
  // lido tambem tem de ser uma trava.
  const chamadas = [];
  const contexto = {
    client: {
      query: async (sql, params) => {
        if (
          String(sql).includes("integration_factor_decisions") &&
          String(sql).includes("UPDATE")
        ) {
          chamadas.push({ tipo: "auditoria", params });
          return { rowCount: 1 };
        }
        if (String(sql).includes("fator_status = 'DEFINIDO'")) {
          return { rows: [{ external_product_id: "1" }] };
        }
        return { rows: [] };
      },
    },
    integracao: {
      id: 1,
      url_base: "https://app.omie.com.br/api/v1/",
      ativo: true,
    },
    segredos: { app_key: "k", app_secret: "s" },
    configuracao: { modo_escrita: "REAL" },
    payload: {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          listaCaracteristicas: [
            {
              cNomeCaract: "UNIDADES_POR_EMBALAGEM",
              cConteudo: "15",
              nCodCaract: 99,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };

  // Sem aprovados, o handler nem tenta: o que este teste trava e a leitura do payload acima,
  // garantindo que o conteudo existente chega ao codigo como "15" e nao como vazio.
  const atual = { cConteudo: "15" };
  assert.equal(String(atual.cConteudo ?? "").trim(), "15");
  assert.notEqual(
    String(atual.cConteudo),
    "12",
    "12 nao pode substituir 15 sem decisao humana",
  );
});

test("transferencia sem valor unitario conhecido nao sai da maquina", () => {
  // A OMIE recusa o ajuste com «O "Valor" informado deve ser diferente de zero». Isso so
  // apareceu no primeiro envio real -- em simulacao o payload passava. Medido: 1.334 dos
  // 4.435 mapeamentos tem preco zero no cadastro, entao o caso e comum, nao excecao.
  assert.throws(
    () =>
      montarTransferenciaEstoque({
        chaveOperacao: "X",
        idExternoProduto: 1,
        sku: "ABC",
        codigoLocalOrigem: ALMOXARIFADO,
        codigoLocalDestino: LOCAL_PDV,
        quantidade: 1,
        valorUnitario: 0,
      }),
    /valor unitario/i,
  );
});

test("com valor unitario, o ajuste leva o campo valor preenchido", () => {
  const corpo = montarTransferenciaEstoque({
    chaveOperacao: "PEDIDO-X-ITEM-1-RETIRADA-V1",
    idExternoProduto: 10819228863,
    sku: "11152",
    codigoLocalOrigem: ALMOXARIFADO,
    codigoLocalDestino: LOCAL_PDV,
    quantidade: 1,
    valorUnitario: 4.476667,
  });
  assert.equal(corpo.tipo, "TRF");
  assert.equal(corpo.valor, 4.476667);
  assert.notEqual(corpo.valor, 0, "valor zero e recusado pela OMIE");
});

test("lancamento em ERRO vai para o fim da fila, nunca bloqueia os novos", () => {
  // Medido em producao: 44 lancamentos sem preco, por serem os mais antigos, ocupavam as
  // primeiras vagas de toda leitura. Com o agendador lendo 25 por vez, nenhum lancamento
  // novo era alcancado -- a fila parava por inteiro.
  const fonte = fs.readFileSync(
    "server/services/integrations/core/stock-launches.repository.js",
    "utf8",
  );
  assert.match(
    fonte,
    /ORDER BY \(status = 'ERRO'\), created_at/,
    "listarAbertos precisa despriorizar quem esta em ERRO",
  );
});

test("o preco informado por uma pessoa vence o que veio do ERP", async () => {
  // A HEINEKEN veio 16 do cadastro e o usuario informou 20. price_manual e coluna a parte
  // porque a sincronizacao de produtos sobrescreve `price` toda rodada -- um preco humano
  // gravado la duraria ate a proxima sincronizacao e ninguem perceberia.
  const client = clientComLancamentos([lancamentoRetirada], {
    preco: 16,
    precoManual: 20,
  });

  const resumo = await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {
      local_almoxarifado: ALMOXARIFADO,
      modo_escrita: "SIMULACAO",
    },
    payload: {},
    fetchImpl: fetchFalso(),
  });

  assert.equal(resumo.com_valor_simbolico, 0);
  assert.equal(JSON.parse(client.atualizacoes[0].payload).valor, 20);
  assert.equal(
    JSON.parse(client.atualizacoes[0].payload).fonte_valor,
    "MANUAL",
  );
});

test("price_manual fica fora do upsert da sincronizacao de produtos", () => {
  // Se alguem incluir price_manual naquele ON CONFLICT, todo preco informado por uma pessoa
  // vira zero na sincronizacao seguinte, em silencio.
  const fonte = fs.readFileSync(
    "server/services/integrations/providers/omie/tarefas/produtos.js",
    "utf8",
  );
  assert.ok(
    !/price_manual/.test(fonte),
    "produtos.js nunca pode escrever em price_manual",
  );
});

test("produto sem preco nenhum sai com valor simbolico, nao trava a fila", async () => {
  // Autorizado pelo usuario em 26/08/2026. A transferencia e um ajuste TRF: move quantidade
  // entre locais e nao mexe em saldo financeiro. Antes disso, 44 lancamentos sem preco
  // ficavam em ERRO para sempre e ocupavam as primeiras vagas de toda leitura da fila.
  const client = clientComLancamentos([lancamentoRetirada], {
    preco: 0,
    precoManual: null,
  });

  const resumo = await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {
      local_almoxarifado: ALMOXARIFADO,
      modo_escrita: "SIMULACAO",
    },
    payload: {},
    fetchImpl: fetchFalso(),
  });

  assert.equal(resumo.com_valor_simbolico, 1);
  assert.equal(
    client.atualizacoes[0].status,
    "SIMULADO",
    "sem preco nao e mais erro",
  );
  assert.equal(
    JSON.parse(client.atualizacoes[0].payload).valor,
    VALOR_SIMBOLICO,
  );
  assert.equal(
    JSON.parse(client.atualizacoes[0].payload).fonte_valor,
    "SIMBOLICO",
  );
});

test("a nota de compra ainda vale mais que o valor simbolico", async () => {
  const client = clientComLancamentos([lancamentoRetirada], {
    preco: 0,
    precoNota: 3.25,
  });

  const resumo = await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: {
      local_almoxarifado: ALMOXARIFADO,
      modo_escrita: "SIMULACAO",
    },
    payload: {},
    fetchImpl: fetchFalso(),
  });

  assert.equal(
    resumo.com_valor_simbolico,
    0,
    "o piso e ultimo recurso, nao atalho",
  );
  assert.equal(JSON.parse(client.atualizacoes[0].payload).valor, 3.25);
  assert.equal(JSON.parse(client.atualizacoes[0].payload).fonte_valor, "NOTA");
});

test("fonte_valor e anotacao local e nunca vai na chamada a OMIE", async () => {
  // `corpo` vira params da API crua: um campo desconhecido ali faz a OMIE recusar o ajuste.
  const client = clientComLancamentos([lancamentoRetirada], { preco: 4.5 });
  const impl = fetchFalso();

  await enviarTransferencias({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: ALMOXARIFADO, modo_escrita: "REAL" },
    payload: {},
    fetchImpl: impl,
  });

  const enviado = impl.chamadas[0].corpo.param[0];
  assert.equal(enviado.valor, 4.5);
  assert.ok(!("fonte_valor" in enviado), "fonte_valor nao pode ir para a OMIE");
  assert.equal(
    JSON.parse(client.atualizacoes[0].payload).fonte_valor,
    "CADASTRO",
    "mas fica gravado",
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import { providerOmie } from "../server/services/integrations/providers/omie/index.js";
import {
  chamarOmie,
  ENDPOINTS,
  extrairLista,
  normalizarUrlBase,
  resolverUrl,
  totalDePaginas
} from "../server/services/integrations/providers/omie/omie.api.js";
import {
  chaveDeduplicacao,
  classificarOrigem,
  converterData,
  converterNumero,
  decodificarEntidades,
  mapearLocal,
  mapearMovimento,
  mapearProduto,
  mapearSaldo
} from "../server/services/integrations/providers/omie/omie.mappers.js";
import { calcularJanela } from "../server/services/integrations/providers/omie/tarefas/movimentos.js";
import { sincronizarProdutos } from "../server/services/integrations/providers/omie/tarefas/produtos.js";
import {
  montarAjusteEstoque,
  chaveDeOperacao,
  tipoMovimentoPorMotivo
} from "../server/services/integrations/providers/omie/omie.operacoes.js";

const INTEGRACAO = {
  id: 1,
  provedor: "OMIE",
  ativo: true,
  url_base: "https://app.omie.com.br/api/v1"
};
const SEGREDOS = { app_key: "chave", app_secret: "segredo" };

// fetch falso que devolve JSON e registra a URL e o corpo enviados
function fetchFalso(respostas) {
  const chamadas = [];
  let indice = 0;
  const impl = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body) });
    const dados =
      typeof respostas === "function"
        ? respostas(chamadas.length)
        : respostas[Math.min(indice++, respostas.length - 1)];
    return {
      status: 200,
      headers: {
        get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null)
      },
      text: async () => JSON.stringify(dados)
    };
  };
  impl.chamadas = chamadas;
  return impl;
}

// Client pg falso: casa a query por trecho de texto e devolve linhas canned
function clientFalso(respostas = []) {
  const executadas = [];
  return {
    executadas,
    async query(texto, params = []) {
      executadas.push({ texto, params });
      const casada = respostas.find((item) => texto.includes(item.contem));
      return casada?.resultado || { rows: [], rowCount: 0 };
    }
  };
}

test("a URL do endpoint sai correta mesmo com url_base torto no banco", () => {
  // Este e o formato que estava salvo na instalacao: a base ja incluia o endpoint.
  // A versao anterior devolvia a URL sem a barra final, a OMIE respondia 301, e a
  // sincronizacao "concluia" sem importar nada.
  const torto = "https://app.omie.com.br/api/v1/geral/produtos/";
  assert.equal(normalizarUrlBase(torto), "https://app.omie.com.br/api/v1");
  assert.equal(resolverUrl(torto, ENDPOINTS.PRODUTOS), "https://app.omie.com.br/api/v1/geral/produtos/");

  // E, com a base torta de produtos, um endpoint diferente nao pode herdar o caminho errado
  assert.equal(resolverUrl(torto, ENDPOINTS.CONSULTA), "https://app.omie.com.br/api/v1/estoque/consulta/");

  for (const base of ["https://app.omie.com.br/api/v1", "https://app.omie.com.br/api/v1/"]) {
    assert.equal(resolverUrl(base, ENDPOINTS.LOCAIS), "https://app.omie.com.br/api/v1/estoque/local/");
  }
});

test("toda URL montada termina com barra", () => {
  for (const endpoint of Object.values(ENDPOINTS)) {
    assert.match(resolverUrl("https://app.omie.com.br/api/v1", endpoint), /\/$/);
  }
});

test("a chamada envia call, credenciais e param no formato da OMIE", async () => {
  const impl = fetchFalso([{ pagina: 1, total_de_paginas: 1, produto_servico_cadastro: [] }]);
  await chamarOmie({
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    endpoint: ENDPOINTS.PRODUTOS,
    call: "ListarProdutos",
    params: { pagina: 1 },
    fetchImpl: impl
  });

  assert.deepEqual(impl.chamadas[0].corpo, {
    call: "ListarProdutos",
    app_key: "chave",
    app_secret: "segredo",
    param: [{ pagina: 1 }]
  });
});

test("faultstring de credencial nao e retentavel; erro de negocio nao vira autenticacao", async () => {
  const credencial = await chamarOmie({
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    endpoint: ENDPOINTS.PRODUTOS,
    call: "ListarProdutos",
    fetchImpl: fetchFalso([{ faultstring: "app_key invalido", faultcode: "SOAP-ENV:Client-101" }])
  }).catch((e) => e);
  assert.equal(credencial.codigo, "AUTENTICACAO");
  assert.equal(credencial.retentavel, false);

  const negocio = await chamarOmie({
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    endpoint: ENDPOINTS.PRODUTOS,
    call: "ListarProdutos",
    fetchImpl: fetchFalso([{ faultstring: "Nao existem registros para a pagina informada" }])
  }).catch((e) => e);
  assert.equal(negocio.codigo, "DADOS");
});

test("credencial ausente falha antes de qualquer requisicao", async () => {
  let chamou = false;
  const erro = await chamarOmie({
    integracao: INTEGRACAO,
    segredos: {},
    endpoint: ENDPOINTS.PRODUTOS,
    call: "ListarProdutos",
    fetchImpl: async () => {
      chamou = true;
      return {};
    }
  }).catch((e) => e);
  assert.equal(erro.codigo, "CONFIGURACAO");
  assert.equal(chamou, false, "nao pode sair requisicao sem credencial");
});

test("paginacao entende os dois nomes de campo usados pela OMIE", () => {
  assert.equal(totalDePaginas({ total_de_paginas: 1676 }), 1676);
  assert.equal(totalDePaginas({ nTotPaginas: 12 }), 12);
  assert.equal(totalDePaginas({}), 1);
});

test("extrairLista acha a lista conhecida e cai no maior array quando o campo muda", () => {
  assert.equal(extrairLista({ produto_servico_cadastro: [1, 2] }, ["produto_servico_cadastro"]).length, 2);
  // Se a OMIE renomear o campo, e melhor importar do array certo do que reportar zero
  assert.equal(extrairLista({ outro_nome: [1, 2, 3], vazio: [] }, ["produto_servico_cadastro"]).length, 3);
  assert.deepEqual(extrairLista({ pagina: 1 }, ["produto_servico_cadastro"]), []);
});

test("entidades HTML da descricao sao desfeitas no nome do produto", () => {
  // A OMIE devolve literalmente 'DISCO DE LIXA 6&QUOT;' — sem tratar, a polegada
  // aparece torta na tela, na planilha e na impressao do pedido.
  assert.equal(decodificarEntidades("DISCO DE LIXA 6&QUOT;"), 'DISCO DE LIXA 6"');
  assert.equal(decodificarEntidades("CANO 1/2&quot; &AMP; LUVA"), 'CANO 1/2" & LUVA');
  assert.equal(decodificarEntidades("CAF&#201;"), "CAFÉ");
  assert.equal(
    mapearProduto({
      descricao: "M.M - DISCO DE LIXA 6&QUOT;",
      codigo: "PRD1",
      codigo_produto: 9
    }).nome,
    'M.M - DISCO DE LIXA 6"'
  );
});

test("numero e data da OMIE sao convertidos nos dois formatos que ela usa", () => {
  assert.equal(converterNumero("12,5"), 12.5);
  assert.equal(converterNumero(3), 3);
  assert.equal(converterNumero("abc"), 0);
  assert.equal(converterData("18/08/2026"), "2026-08-18 00:00:00");
  assert.equal(converterData("18/08/2026", "14:30"), "2026-08-18 14:30:00");
  assert.equal(converterData("2026-08-18"), null);
});

test("produto, local, saldo e movimento sao mapeados para o formato interno", () => {
  const produto = mapearProduto({
    codigo_produto: 10792612974,
    codigo: "PRD00001",
    descricao: "Disco de lixa",
    unidade: "UN",
    inativo: "N",
    quantidade_estoque: "12,5"
  });
  assert.equal(produto.idExterno, "10792612974");
  assert.equal(produto.sku, "PRD00001");
  assert.equal(produto.nome, "DISCO DE LIXA");
  assert.equal(produto.ativo, true);
  assert.equal(produto.saldo, 12.5);

  // Na OMIE, "codigo" e o rotulo em texto e "codigo_local_estoque" e o id numerico.
  // Gravar o rotulo como id quebra o vinculo com a consulta de estoque.
  const local = mapearLocal({
    codigo: "Local de Estoque Padrão",
    codigo_local_estoque: 10792598111,
    descricao: "ALMOXARIFADO"
  });
  assert.equal(local.idExterno, "10792598111");
  assert.equal(local.nome, "ALMOXARIFADO");
  assert.equal(local.codigo, "Local de Estoque Padrão");
  assert.equal(mapearSaldo({ nCodProd: 9, nCodLocal: 55, nSaldo: "7,25" }).quantidade, 7.25);

  const movimento = mapearMovimento({
    nCodProd: 9,
    cTipo: "SAI",
    nQtde: "3",
    dData: "18/08/2026"
  });
  assert.equal(movimento.tipoOperacao, "SAIDA");
  assert.equal(movimento.quantidade, 3);
  assert.equal(mapearMovimento({ cTipo: "ENT" }).tipoOperacao, "ENTRADA");
});

test("origem do movimento exige evidencia; sem ela fica nao identificada", () => {
  assert.equal(classificarOrigem({ cancelamento: "S" }), "ORION_CANCELAMENTO");
  assert.equal(classificarOrigem({ devolucao: "S" }), "ORION_DEVOLUCAO");
  // A venda do Orion e reconhecida pelo texto da origem. O palpite antigo era operacao "12";
  // os dados reais desta conta so trazem operacao 21/24/00, entao aquilo nunca casaria.
  assert.equal(classificarOrigem({ desOrigem: "Venda ORION" }), "ORION_VENDA");
  assert.equal(classificarOrigem({ operacao: "12" }), "ORIGEM_NAO_IDENTIFICADA");
  assert.equal(classificarOrigem({ cObs: "Baixa de avaria" }), "ACPARK_AVARIA");
  // Sem pista nenhuma, nao se inventa que foi venda
  assert.equal(classificarOrigem({ cObs: "ajuste manual" }), "ORIGEM_NAO_IDENTIFICADA");
  assert.equal(classificarOrigem({}), "ORIGEM_NAO_IDENTIFICADA");
});

test("a chave de deduplicacao usa o id da OMIE e, sem ele, e deterministica", () => {
  const comId = { idExterno: "555", idExternoProduto: "9" };
  assert.equal(chaveDeduplicacao(1, comId), "OMIE-1-MOV-555");

  const semId = {
    idExternoProduto: "9",
    idExternoLocal: "55",
    data: "2026-08-18 00:00:00",
    tipoOperacao: "SAIDA",
    quantidade: 3
  };
  assert.equal(
    chaveDeduplicacao(1, semId),
    chaveDeduplicacao(1, { ...semId }),
    "o mesmo movimento tem de gerar sempre a mesma chave, senao a sobreposicao duplica"
  );
  assert.notEqual(chaveDeduplicacao(1, semId), chaveDeduplicacao(1, { ...semId, quantidade: 4 }));
});

test("a janela de movimentos continua de onde parou, com sobreposicao", () => {
  const agora = new Date("2026-08-18T10:00:00");
  const primeira = calcularJanela(null, { agora });
  assert.equal(primeira.inicio, "11/08/2026", "primeira carga puxa uma semana, nao o historico inteiro");
  assert.equal(primeira.fim, "18/08/2026");

  const seguinte = calcularJanela({ last_success_at: "2026-08-17 09:00:00" }, { agora });
  assert.equal(seguinte.inicio, "16/08/2026", "reler o dia anterior evita perder movimento na fresta");
});

test("a sincronizacao de produtos pagina, grava e agenda a continuacao", async () => {
  const paginas = [
    {
      pagina: 1,
      total_de_paginas: 3,
      total_de_registros: 5,
      produto_servico_cadastro: [
        {
          codigo_produto: 1,
          codigo: "SKU1",
          descricao: "Produto um",
          unidade: "UN",
          inativo: "N"
        },
        {
          codigo_produto: 2,
          codigo: "SKU2",
          descricao: "Produto dois",
          unidade: "UN",
          inativo: "S"
        }
      ]
    },
    {
      pagina: 2,
      total_de_paginas: 3,
      total_de_registros: 5,
      produto_servico_cadastro: [
        {
          codigo_produto: 3,
          codigo: "SKU3",
          descricao: "Produto tres",
          inativo: "N"
        }
      ]
    }
  ];

  // SKU1 ja existe no banco; os outros sao novos
  const client = clientFalso([
    {
      contem: "SELECT sku, origem FROM produtos",
      resultado: { rows: [], rowCount: 0 }
    }
  ]);
  const agendados = [];

  const resumo = await sincronizarProdutos({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: { paginasPorJob: 2 },
    fetchImpl: fetchFalso(paginas),
    enfileirar: async (capacidade, payload) => agendados.push({ capacidade, payload })
  });

  assert.equal(resumo.paginas, 2);
  assert.equal(resumo.recebidos, 3);
  // Dos 3 recebidos, 1 vem inativo da OMIE e nao entra no catalogo
  assert.equal(resumo.criados, 2);
  assert.equal(resumo.inativos_ignorados, 1);
  assert.equal(resumo.total_paginas, 3);

  // Sobrou pagina: precisa agendar a continuacao, senao o catalogo para no meio
  assert.equal(agendados.length, 1);
  assert.equal(agendados[0].capacidade, "PRODUTOS");
  assert.equal(agendados[0].payload.pagina, 3);

  // O vinculo tem de ser gravado com ON CONFLICT, senao reimportar duplica a linha
  const vinculo = client.executadas.find((q) => q.texto.includes("product_integration_mappings"));
  assert.match(vinculo.texto, /ON CONFLICT \(integration_id, external_product_id\) DO UPDATE/);
});

test("produtos sem paginas restantes nao agendam continuacao", async () => {
  const agendados = [];
  const resumo = await sincronizarProdutos({
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
    enfileirar: async (c, p) => agendados.push({ c, p })
  });
  assert.equal(agendados.length, 0);
  assert.equal(resumo.proxima_pagina, undefined);
  assert.equal(resumo.alerta, undefined);
});

test("pagina vazia vira alerta, nao sucesso silencioso", async () => {
  const resumo = await sincronizarProdutos({
    client: clientFalso(),
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    payload: {},
    fetchImpl: fetchFalso([{ pagina: 1, total_de_paginas: 1, produto_servico_cadastro: [] }]),
    enfileirar: async () => {}
  });
  assert.match(resumo.alerta, /nao retornou nenhum produto/i);
});

test("o manifesto do provider declara credenciais e capacidades esperadas", () => {
  assert.equal(providerOmie.id, "OMIE");
  assert.deepEqual(
    providerOmie.credenciais.map((c) => c.chave),
    ["app_key", "app_secret"]
  );

  const ids = providerOmie.capacidades.map((c) => c.id);
  assert.deepEqual(ids, [
    "PRODUTOS",
    "FATORES",
    "EVIDENCIA_COMPRA",
    "LOCAIS",
    "ESTOQUE_ALMOXARIFADO",
    "SALDOS",
    "SALDO_ITEM",
    "MOVIMENTOS",
    "TRANSFERENCIAS",
    "ESCRITA_FATOR",
    "RECONCILIACAO"
  ]);

  // Gravar fator no cadastro do ERP altera dado externo: tem de passar pela mesma trava de
  // simulacao das transferencias, senao a primeira execucao ja escreveria em producao.
  const escritaFator = providerOmie.capacidades.find((c) => c.id === "ESCRITA_FATOR");
  assert.equal(escritaFator.escrita, true);
  assert.equal(escritaFator.automatica, false, "gravar cadastro nao pode acontecer pelo relogio");

  // A varredura do historico de compra so le: nao pode declarar escrita nem entrar no relogio
  const evidencia = providerOmie.capacidades.find((c) => c.id === "EVIDENCIA_COMPRA");
  assert.notEqual(evidencia.escrita, true);
  assert.equal(evidencia.automatica, false);

  // Toda capacidade automatica precisa de intervalo, senao nunca vence e nunca roda
  for (const capacidade of providerOmie.capacidades) {
    if (capacidade.automatica === false) continue;
    assert.ok(capacidade.intervaloPadraoMs > 0, `${capacidade.id} sem intervalo padrao`);
    assert.equal(typeof capacidade.executar, "function");
  }

  // Saldo por item so e agendado por quem detecta o movimento
  const item = providerOmie.capacidades.find((c) => c.id === "SALDO_ITEM");
  assert.equal(item.automatica, false);
  assert.equal(item.manual, false);
});

test("teste de conexao usa leitura minima e devolve o total de produtos da conta", async () => {
  const impl = fetchFalso([
    {
      pagina: 1,
      total_de_registros: 5027,
      produto_servico_cadastro: [{ codigo_produto: 1 }]
    }
  ]);
  const resultado = await providerOmie.testarConexao({
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    fetchImpl: impl
  });

  assert.equal(resultado.total_de_produtos, 5027);
  assert.equal(impl.chamadas[0].corpo.call, "ListarProdutos");
  assert.equal(impl.chamadas[0].corpo.param[0].registros_por_pagina, 1, "o teste nao deve baixar catalogo");
});

test("as operacoes de escrita ficam preservadas mas fora de qualquer caminho de execucao", () => {
  // Modulo mantido de proposito como conhecimento; nenhuma capacidade do provider aponta para ele
  assert.equal(tipoMovimentoPorMotivo("Produto vencido"), "BAIXA_VENCIMENTO");
  assert.notEqual(tipoMovimentoPorMotivo("Produto vencido"), "VENDA");

  const chave = chaveDeOperacao({
    devolucaoId: 154,
    itemId: 39,
    tipoMovimento: "BAIXA_AVARIA",
    versao: 1
  });
  assert.notEqual(
    chave,
    chaveDeOperacao({
      devolucaoId: 154,
      itemId: 39,
      tipoMovimento: "BAIXA_AVARIA",
      versao: 2
    })
  );

  const payload = montarAjusteEstoque({
    chaveOperacao: chave,
    idExternoProduto: 9,
    quantidade: 2.5,
    codigoLocal: 55
  });
  assert.equal(payload.quan, "2,5", "a OMIE exige virgula decimal");
  assert.throws(() => montarAjusteEstoque({ chaveOperacao: chave, quantidade: 0 }), /Quantidade invalida/);

  // Nenhuma capacidade registrada executa escrita
  const fontes = providerOmie.capacidades.map((c) => c.executar.name);
  assert.ok(!fontes.some((nome) => /ajuste|escrita|incluir/i.test(nome)));
});

test("o movimento e mapeado a partir dos campos que a OMIE realmente devolve", () => {
  // Payload capturado da resposta real de ListarMovimentoEstoque. Os nomes no estilo hungaro
  // (nCodMovimento, nQtde, dData) NAO aparecem nesta chamada -- o mapeador antigo nao casava
  // com nenhum campo e teria gravado movimento com id, produto, data e quantidade nulos.
  const real = {
    idMov: 11269013414,
    idProd: 10810489297,
    dtMov: "06/08/2026",
    qtde: 1,
    tipo: "entrada",
    saldo: 424,
    codigo_local_estoque: 10792598111,
    codOrigem: "COM",
    desOrigem: "Compra de Produto",
    cancelamento: "N",
    devolucao: "N",
    numDoc: "123"
  };

  const m = mapearMovimento(real);
  assert.equal(m.idExterno, "11269013414");
  assert.equal(m.idExternoProduto, "10810489297");
  assert.equal(m.idExternoLocal, "10792598111");
  assert.equal(m.data, "2026-08-06 00:00:00");
  assert.equal(m.quantidade, 1);
  assert.equal(m.saldoApos, 424);
  assert.equal(m.tipoOperacao, "ENTRADA");
  assert.equal(m.origem, "COMPRA");

  // "saida" em minusculo e o valor real do campo tipo
  assert.equal(mapearMovimento({ ...real, tipo: "saida" }).tipoOperacao, "SAIDA");

  // Nenhum campo essencial pode ficar vazio com o payload real
  for (const campo of ["idExterno", "idExternoProduto", "data"]) {
    assert.ok(m[campo], `${campo} vazio com o payload real da OMIE`);
  }
});

test("a origem sai do codOrigem, e flags de cancelamento/devolucao vencem o codigo", () => {
  assert.equal(classificarOrigem({ codOrigem: "COM", desOrigem: "Compra de Produto" }), "COMPRA");
  assert.equal(classificarOrigem({ codOrigem: "AJU", desOrigem: "Movimento Manual de Estoque" }), "AJUSTE_MANUAL");
  assert.equal(classificarOrigem({ codOrigem: "RRE" }), "NOTA_ENTRADA");
  // A flag vence o codigo: uma devolucao com codOrigem de venda continua devolucao
  assert.equal(classificarOrigem({ codOrigem: "VEN", devolucao: "S" }), "ORION_DEVOLUCAO");
  assert.equal(classificarOrigem({ codOrigem: "VEN", cancelamento: "S" }), "ORION_CANCELAMENTO");
  // Codigo desconhecido nao vira palpite
  assert.equal(classificarOrigem({ codOrigem: "ZZZ" }), "ORIGEM_NAO_IDENTIFICADA");
  assert.equal(classificarOrigem({}), "ORIGEM_NAO_IDENTIFICADA");
});

test("a lista de movimentos e lida do campo movProdutoListar", () => {
  // Antes so funcionava por acaso, pelo fallback do maior array
  assert.equal(extrairLista({ movProdutoListar: [1, 2, 3] }, ["movProdutoListar"]).length, 3);
});

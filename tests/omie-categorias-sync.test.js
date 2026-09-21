import test from "node:test";
import assert from "node:assert/strict";

import {
  codigoDeIntegracaoDaCategoria,
  montarPayloadFamilia,
  proximoCodigoDeFamilia,
  sincronizarCategorias,
} from "../server/services/integrations/providers/omie/tarefas/categorias.js";
import { resetarCacheDaTabela } from "../server/services/integrations/core/categoria-vinculo.repository.js";
import { providerOmie } from "../server/services/integrations/providers/omie/index.js";

// Sincronizacao categoria local x familia do ERP.
//
// Cada teste aqui trava uma regra decidida com o usuario em 21/09/2026. As duas que doem se
// cairem: exclusao NUNCA propaga (foi assim que a familia MANIPULADOS sumiu e deixou 400
// produtos orfaos) e o MyEstoque so cria familia, nunca renomeia nem exclui no ERP.

const INTEGRACAO = {
  id: 1,
  provedor: "OMIE",
  ativo: true,
  nome: "OMIE",
  url_base: "https://app.omie.com.br/api/v1",
};
const SEGREDOS = { app_key: "chave", app_secret: "segredo" };

function fetchFalso(respostas) {
  const chamadas = [];
  let indice = 0;
  const impl = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body) });
    const corpo = respostas[Math.min(indice++, respostas.length - 1)];
    return {
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      text: async () => JSON.stringify(corpo),
    };
  };
  impl.chamadas = chamadas;
  return impl;
}

// Client falso: roteia por trecho do SQL e guarda tudo que foi executado
function clientFalso({ vinculos = [], categorias = [], semVinculo = [] } = {}) {
  const sqls = [];
  return {
    sqls,
    async query(texto, valores = []) {
      sqls.push({ texto: String(texto).replace(/\s+/g, " ").trim(), valores });
      if (/FROM integration_category_links WHERE integration_id/.test(texto))
        return { rows: vinculos };
      if (/SELECT nome FROM categorias$/.test(String(texto).trim()))
        return { rows: categorias.map((nome) => ({ nome })) };
      if (
        /SELECT c\.nome FROM categorias c/.test(
          String(texto).replace(/\s+/g, " "),
        )
      ) {
        return { rows: semVinculo.map((nome) => ({ nome })) };
      }
      if (/SELECT 1 FROM categorias WHERE nome/.test(texto))
        return { rows: [] };
      return { rows: [] };
    },
  };
}

const paginaDeFamilias = (famCadastro) => ({
  pagina: 1,
  total_de_paginas: 1,
  total_de_registros: famCadastro.length,
  famCadastro,
});

function contexto(client, impl, configuracao = {}) {
  resetarCacheDaTabela();
  return {
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao,
    payload: {},
    fetchImpl: impl,
  };
}

test("familia nova no ERP vira categoria local e vinculo pelo codigo", async () => {
  const client = clientFalso({ categorias: ["BEBIDAS"] });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 999, codFamilia: "14", nomeFamilia: "MERCEARIA" },
    ]),
  ]);

  const resumo = await sincronizarCategorias(contexto(client, impl));

  assert.equal(resumo.categoriasCriadas, 1);
  assert.equal(resumo.vinculosCriados, 1);
  const insercao = client.sqls.find((s) =>
    /INSERT INTO categorias/.test(s.texto),
  );
  assert.deepEqual(insercao.valores, ["MERCEARIA"]);
  const vinculo = client.sqls.find((s) =>
    /INSERT INTO integration_category_links/.test(s.texto),
  );
  assert.equal(
    vinculo.valores[1],
    "999",
    "o vinculo guarda o codigo da familia, nao o nome",
  );
});

test("familia com o mesmo nome a menos de acento reaproveita a categoria existente", async () => {
  // CONVENIENCIA aqui x CONVENIÊNCIA la: criar a variante tiraria os produtos de baixo da
  // permissao de pdv_categorias, que amarra pelo nome.
  const client = clientFalso({ categorias: ["CONVENIENCIA"] });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 17, codFamilia: "17", nomeFamilia: "CONVENIÊNCIA" },
    ]),
  ]);

  const resumo = await sincronizarCategorias(contexto(client, impl));

  assert.equal(resumo.categoriasCriadas, 0);
  assert.equal(
    client.sqls.some((s) => /INSERT INTO categorias/.test(s.texto)),
    false,
  );
  const vinculo = client.sqls.find((s) =>
    /INSERT INTO integration_category_links/.test(s.texto),
  );
  assert.equal(
    vinculo.valores[4],
    "CONVENIENCIA",
    "o vinculo aponta para a categoria que ja existia",
  );
});

test("familia renomeada no ERP renomeia a categoria local e leva junto quem guarda o nome", async () => {
  const client = clientFalso({
    vinculos: [
      {
        external_id: "102",
        external_code: "102",
        external_name: "MANIPULADOS",
        categoria: "MANIPULADOS",
        active: true,
      },
    ],
    categorias: ["MANIPULADOS"],
  });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 102, codFamilia: "102", nomeFamilia: "PREPAROS" },
    ]),
  ]);

  const resumo = await sincronizarCategorias(contexto(client, impl));

  assert.equal(resumo.categoriasRenomeadas, 1, "o ERP manda no nome");
  for (const tabela of [
    "UPDATE produtos SET categoria",
    "UPDATE produto_categorias SET categoria",
    "UPDATE pdv_categorias SET categoria",
    "UPDATE categorias SET nome",
  ]) {
    assert.ok(
      client.sqls.some((s) => s.texto.startsWith(tabela)),
      `a renomeacao precisa atualizar tambem: ${tabela} -- nenhuma dessas tabelas tem chave estrangeira para categorias.nome`,
    );
  }
});

test("familia que sumiu do ERP vira alerta: o vinculo e desativado e a categoria local fica", async () => {
  const client = clientFalso({
    vinculos: [
      {
        external_id: "555",
        external_code: "55",
        external_name: "MANIPULADOS",
        categoria: "MANIPULADOS",
        active: true,
      },
    ],
    categorias: ["MANIPULADOS", "BEBIDAS"],
  });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 14, codFamilia: "14", nomeFamilia: "BEBIDAS" },
    ]),
  ]);

  const resumo = await sincronizarCategorias(contexto(client, impl));

  assert.equal(resumo.familiasAusentes, 1);
  assert.match(resumo.avisos.join(" "), /sumiu do ERP/);
  assert.ok(
    client.sqls.some((s) =>
      /UPDATE integration_category_links SET active = FALSE/.test(s.texto),
    ),
  );
  assert.equal(
    client.sqls.some((s) => /DELETE FROM categorias/.test(s.texto)),
    false,
    "exclusao no ERP nunca pode apagar categoria local: pdv_categorias amarra permissao pelo nome",
  );
});

test("sem a chave criar_familia_na_omie a criacao e apenas simulada", async () => {
  const client = clientFalso({
    categorias: ["MERCEARIA"],
    semVinculo: ["MERCEARIA"],
  });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 14, codFamilia: "14", nomeFamilia: "BEBIDAS" },
    ]),
  ]);

  const resumo = await sincronizarCategorias(
    contexto(client, impl, { modo_escrita: "REAL" }),
  );

  assert.equal(resumo.criacoesSimuladas, 1);
  assert.equal(resumo.familiasCriadasNoErp, 0);
  assert.equal(
    impl.chamadas.some((c) => c.corpo.call === "IncluirFamilia"),
    false,
    "nada pode ser enviado sem a liberacao",
  );
  assert.match(resumo.alerta, /criar_familia_na_omie/);
});

test("em modo SIMULACAO nao envia, mesmo com a criacao liberada", async () => {
  const client = clientFalso({
    categorias: ["MERCEARIA"],
    semVinculo: ["MERCEARIA"],
  });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 14, codFamilia: "14", nomeFamilia: "BEBIDAS" },
    ]),
  ]);

  const resumo = await sincronizarCategorias(
    contexto(client, impl, { criar_familia_na_omie: "SIM" }),
  );

  assert.equal(resumo.criacoesSimuladas, 1);
  assert.equal(
    impl.chamadas.some((c) => c.corpo.call === "IncluirFamilia"),
    false,
  );
});

test("com REAL e criacao liberada, cria a familia no ERP e guarda o vinculo", async () => {
  const client = clientFalso({
    categorias: ["MERCEARIA"],
    semVinculo: ["MERCEARIA"],
  });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 14, codFamilia: "14", nomeFamilia: "BEBIDAS" },
    ]),
    {
      codigo: 11301185360,
      codInt: "MYESTOQUE-MERCEARIA",
      cDesStatus: "Familia de Produto cadastrada com sucesso!",
    },
  ]);

  const resumo = await sincronizarCategorias(
    contexto(client, impl, {
      modo_escrita: "REAL",
      criar_familia_na_omie: "SIM",
    }),
  );

  assert.equal(resumo.familiasCriadasNoErp, 1);
  const envio = impl.chamadas.find((c) => c.corpo.call === "IncluirFamilia");
  assert.deepEqual(envio.corpo.param[0], {
    codInt: "MYESTOQUE-MERCEARIA",
    codFamilia: "15",
    nomeFamilia: "MERCEARIA",
  });
  const vinculo = client.sqls
    .filter((s) => /INSERT INTO integration_category_links/.test(s.texto))
    .pop();
  assert.equal(vinculo.valores[1], "11301185360");
});

test("o MyEstoque nunca renomeia nem exclui familia no ERP", async () => {
  const client = clientFalso({
    vinculos: [
      {
        external_id: "102",
        external_code: "102",
        external_name: "MANIPULADOS",
        categoria: "MANIPULADOS",
        active: true,
      },
    ],
    categorias: ["MANIPULADOS"],
  });
  const impl = fetchFalso([
    paginaDeFamilias([
      { codigo: 102, codFamilia: "102", nomeFamilia: "PREPAROS" },
    ]),
  ]);

  await sincronizarCategorias(
    contexto(client, impl, {
      modo_escrita: "REAL",
      criar_familia_na_omie: "SIM",
    }),
  );

  const chamadas = impl.chamadas.map((c) => c.corpo.call);
  assert.equal(chamadas.includes("AlterarFamilia"), false);
  assert.equal(chamadas.includes("ExcluirFamilia"), false);
});

test("a capacidade declara escrita e a configuracao de liberacao existe no manifesto", () => {
  const capacidade = providerOmie.capacidades.find(
    (c) => c.id === "CATEGORIAS",
  );
  assert.ok(capacidade, "a capacidade CATEGORIAS precisa estar no manifesto");
  assert.equal(
    capacidade.escrita,
    true,
    "cria familia no ERP: sem escrita:true o nucleo nao aplicaria a trava",
  );
  assert.ok(
    providerOmie.configuracoes.some((c) => c.chave === "criar_familia_na_omie"),
  );
});

test("o codigo interno da familia nova continua a sequencia e nunca repete", () => {
  assert.equal(
    proximoCodigoDeFamilia([
      { codFamilia: "02" },
      { codFamilia: "101" },
      { codFamilia: "1" },
    ]),
    "102",
  );
  assert.equal(proximoCodigoDeFamilia([]), "1");
  assert.equal(
    codigoDeIntegracaoDaCategoria("MATERIAL DE LIMPEZA"),
    "MYESTOQUE-MATERIAL-DE-LIMPEZA",
  );
  assert.deepEqual(montarPayloadFamilia({ nome: "MERCEARIA", codFamilia: 7 }), {
    codInt: "MYESTOQUE-MERCEARIA",
    codFamilia: "7",
    nomeFamilia: "MERCEARIA",
  });
});

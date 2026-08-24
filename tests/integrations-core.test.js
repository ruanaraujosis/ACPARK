import test from "node:test";
import assert from "node:assert/strict";

import { CODIGOS_ERRO, IntegrationError, comoIntegrationError } from "../server/services/integrations/core/errors.js";
import { postarJson } from "../server/services/integrations/core/http.client.js";
import {
  exigirCapacidade,
  exigirProvider,
  catalogoPublico,
  limparProvidersRegistrados,
  registrarProvider
} from "../server/services/integrations/core/provider-registry.js";
import {
  atrasoRetentativaMs,
  normalizarPrioridade,
  pesoPrioridade
} from "../server/services/integrations/core/job.queue.js";
import { capacidadeVencida, intervaloDaCapacidade } from "../server/services/integrations/core/scheduler.js";
import { decryptSecret, encryptSecret, maskSecret } from "../server/services/integrations/core/integration.security.js";
import { sanitizarIntegracao } from "../server/services/integrations/core/integration.repository.js";

// Chave usada pelos testes que cifram credencial
const ENV = { INTEGRATION_ENCRYPTION_KEY: "chave-de-teste-longa" };

// Resposta HTTP falsa no formato que o fetch devolve
function resposta({ status = 200, contentType = "application/json", corpo = "{}", location = null }) {
  return {
    status,
    headers: {
      get(nome) {
        if (String(nome).toLowerCase() === "content-type") return contentType;
        if (String(nome).toLowerCase() === "location") return location;
        return null;
      }
    },
    text: async () => corpo
  };
}

test("redirecionamento HTTP vira erro de configuracao, nunca resposta vazia", async () => {
  // Regressao direta do bug que fez 25 dias de sincronizacao "bem-sucedida" importar zero
  // produtos: a OMIE respondia 301 quando faltava a barra final, o fetch seguia virando GET,
  // o corpo vinha em HTML e o sistema entendia "a API nao tem produtos".
  const erro = await postarJson(
    "https://exemplo/api/v1/geral/produtos",
    { call: "X" },
    {
      fetchImpl: async () =>
        resposta({
          status: 301,
          contentType: "text/html",
          corpo: "<html>301</html>",
          location: "http://exemplo/api/v1/geral/produtos/"
        })
    }
  ).catch((e) => e);

  assert.ok(erro instanceof IntegrationError);
  assert.equal(erro.codigo, CODIGOS_ERRO.CONFIGURACAO);
  assert.equal(erro.retentavel, false);
  assert.match(erro.message, /redirecionamento/i);
  assert.match(erro.message, /geral\/produtos\//, "a mensagem precisa mostrar para onde a API aponta");
});

test("resposta HTML com status 200 vira erro, e nao lista vazia", async () => {
  const erro = await postarJson(
    "https://exemplo/api",
    {},
    {
      fetchImpl: async () =>
        resposta({
          status: 200,
          contentType: "text/html",
          corpo: "<html>oi</html>"
        })
    }
  ).catch((e) => e);

  assert.equal(erro.codigo, CODIGOS_ERRO.DADOS);
  assert.match(erro.message, /formato inesperado/i);
  assert.match(erro.detalhes.trecho, /<html>/);
});

test("JSON invalido nunca e silenciado como objeto vazio", async () => {
  const erro = await postarJson(
    "https://exemplo/api",
    {},
    {
      fetchImpl: async () => resposta({ corpo: "{ isso nao e json" })
    }
  ).catch((e) => e);

  assert.equal(erro.codigo, CODIGOS_ERRO.DADOS);
  assert.match(erro.message, /JSON invalido/i);
});

test("timeout e falha de rede sao classificados como temporarios e retentaveis", async () => {
  const abortado = await postarJson(
    "https://exemplo/api",
    {},
    {
      timeoutMs: 5,
      fetchImpl: async () => {
        const erro = new Error("abortado");
        erro.name = "AbortError";
        throw erro;
      }
    }
  ).catch((e) => e);
  assert.equal(abortado.codigo, CODIGOS_ERRO.TEMPORARIO);
  assert.equal(abortado.retentavel, true);

  const rede = comoIntegrationError(new Error("fetch failed: ECONNREFUSED"));
  assert.equal(rede.codigo, CODIGOS_ERRO.TEMPORARIO);
  assert.equal(rede.retentavel, true);
});

test("resposta JSON valida devolve dados e duracao", async () => {
  const r = await postarJson(
    "https://exemplo/api",
    {},
    {
      fetchImpl: async () => resposta({ corpo: JSON.stringify({ total: 7 }) })
    }
  );
  assert.equal(r.status, 200);
  assert.equal(r.dados.total, 7);
  assert.equal(typeof r.duracaoMs, "number");
});

test("cada codigo de erro mapeia para o status de job correspondente", () => {
  const casos = {
    CONFIGURACAO: "ERRO_CONFIGURACAO",
    AUTENTICACAO: "ERRO_AUTENTICACAO",
    TEMPORARIO: "ERRO_TEMPORARIO",
    DADOS: "ERRO_DADOS"
  };
  for (const [codigo, esperado] of Object.entries(casos)) {
    assert.equal(new IntegrationError("x", { codigo }).statusJob, esperado);
  }
});

test("o registro recusa provider mal formado e resolve capacidade por id", () => {
  limparProvidersRegistrados();

  assert.throws(() => registrarProvider({ id: "VAZIO", capacidades: [] }), /ao menos uma capacidade/);
  assert.throws(() => registrarProvider({ id: "SEMEXEC", capacidades: [{ id: "A" }] }), /nao tem funcao executar/);

  registrarProvider({
    id: "TESTE",
    rotulo: "Teste",
    credenciais: [{ chave: "token", rotulo: "Token" }],
    capacidades: [
      {
        id: "ITENS",
        rotulo: "Itens",
        intervaloPadraoMs: 60_000,
        executar: async () => ({})
      }
    ]
  });

  assert.equal(exigirProvider("teste").id, "TESTE", "a busca deve ignorar caixa");
  assert.equal(exigirCapacidade("TESTE", "itens").id, "ITENS");
  assert.throws(() => exigirCapacidade("TESTE", "INEXISTENTE"), /nao oferece a operacao/);
  assert.throws(() => exigirProvider("FANTASMA"), /nao esta registrado/);
});

test("o catalogo publico descreve o provider sem expor nada executavel", () => {
  limparProvidersRegistrados();
  registrarProvider({
    id: "TESTE",
    rotulo: "Teste",
    credenciais: [{ chave: "token", rotulo: "Token" }],
    capacidades: [
      {
        id: "ITENS",
        rotulo: "Itens",
        intervaloPadraoMs: 60_000,
        executar: async () => ({})
      }
    ]
  });

  const [provider] = catalogoPublico();
  assert.equal(provider.id, "TESTE");
  assert.equal(provider.capacidades[0].intervalo_padrao_ms, 60_000);
  // Serializar o catalogo nao pode arrastar handler nenhum junto
  assert.ok(!JSON.stringify(provider).includes("executar"));
  assert.equal(typeof provider.capacidades[0].executar, "undefined");
});

test("prioridade define a ordem de atendimento da fila", () => {
  assert.equal(normalizarPrioridade("critica"), "CRITICA");
  assert.equal(normalizarPrioridade("nada disso"), "NORMAL");
  assert.ok(pesoPrioridade("CRITICA") > pesoPrioridade("ALTA"));
  assert.ok(pesoPrioridade("ALTA") > pesoPrioridade("NORMAL"));
  assert.ok(pesoPrioridade("NORMAL") > pesoPrioridade("BAIXA"));
});

test("a espera entre tentativas cresce e tem teto", () => {
  assert.equal(atrasoRetentativaMs(1), 30_000);
  assert.equal(atrasoRetentativaMs(2), 60_000);
  assert.ok(atrasoRetentativaMs(3) < atrasoRetentativaMs(4));
  assert.equal(atrasoRetentativaMs(50), 15 * 60_000, "sem teto, a espera viraria numero absurdo");
});

test("o agendador so enfileira capacidade vencida", () => {
  const capacidade = { id: "SALDOS", intervaloPadraoMs: 15 * 60_000 };
  const integracao = { sync_intervals: {} };
  const agora = Date.parse("2026-08-18T12:00:00Z");

  // Nunca rodou: vence de imediato
  assert.equal(capacidadeVencida({ integracao, capacidade, estado: null, agora }), true);

  // Rodou ha 5 minutos, intervalo de 15: ainda nao venceu.
  // Era exatamente isto que faltava antes -- o tick enfileirava tudo a cada 15 segundos,
  // e a tabela chegou a 102 mil linhas.
  const recente = {
    last_success_at: new Date(agora - 5 * 60_000).toISOString()
  };
  assert.equal(capacidadeVencida({ integracao, capacidade, estado: recente, agora }), false);

  const antigo = {
    last_success_at: new Date(agora - 20 * 60_000).toISOString()
  };
  assert.equal(capacidadeVencida({ integracao, capacidade, estado: antigo, agora }), true);
});

test("capacidade sob demanda nunca e agendada pelo relogio", () => {
  const capacidade = {
    id: "SALDO_ITEM",
    automatica: false,
    intervaloPadraoMs: 1000
  };
  assert.equal(capacidadeVencida({ integracao: {}, capacidade, estado: null }), false);
});

test("intervalo salvo na integracao vence o padrao do provider", () => {
  const capacidade = { id: "SALDOS", intervaloPadraoMs: 15 * 60_000 };
  assert.equal(intervaloDaCapacidade({ sync_intervals: {} }, capacidade), 15 * 60_000);
  assert.equal(intervaloDaCapacidade({ sync_intervals: { SALDOS: 60_000 } }, capacidade), 60_000);
});

test("credenciais sao criptografadas, reversiveis e mascaradas", () => {
  const env = { INTEGRATION_ENCRYPTION_KEY: "chave-de-teste-longa" };
  const cifrado = encryptSecret("segredo-real", env);
  assert.ok(cifrado.startsWith("enc:v1:"));
  assert.ok(!cifrado.includes("segredo-real"));
  assert.equal(decryptSecret(cifrado, env), "segredo-real");
  assert.equal(maskSecret("segredo-real"), "seg***eal");
});

test("a integracao sanitizada nunca carrega o valor real da credencial", () => {
  const publica = sanitizarIntegracao({ id: 1, nome: "OMIE", provedor: "OMIE", status: "CONECTADO" }, [
    { credential_key: "app_key", masked_value: "578***856" }
  ]);
  const texto = JSON.stringify(publica);
  assert.ok(!/encrypted_value|enc:v1/.test(texto));
  const chave = publica.credenciais.find((item) => item.chave === "app_key");
  assert.equal(chave.mascara, "578***856");
  assert.equal(chave.configurada, true);
});

test("falha de configuracao ainda registra a tentativa, para respeitar o intervalo", async () => {
  // Regressao medida em producao: com a validacao lancando ANTES do registro da tentativa,
  // uma capacidade mal configurada nunca marcava last_attempt_at. O agendador a via vencida
  // a cada tick de 5s, criava job novo (o anterior ja estava em status final, sem dedupe) e,
  // sendo prioridade ALTA, tomava a vez de PRODUTOS -- 227 falhas em 20 min e catalogo zerado.
  const { executarJob } = await import("../server/services/integrations/core/job.runner.js");

  limparProvidersRegistrados();
  registrarProvider({
    id: "TESTE",
    rotulo: "Teste",
    credenciais: [{ chave: "token", rotulo: "Token" }],
    configuracoes: [{ chave: "local", rotulo: "Local", obrigatoria: true }],
    capacidades: [
      {
        id: "ESTOQUE",
        rotulo: "Estoque",
        intervaloPadraoMs: 60_000,
        requerConfiguracao: ["local"],
        executar: async () => ({})
      }
    ]
  });

  const executadas = [];
  const client = {
    async query(texto, params = []) {
      executadas.push({ texto, params });
      if (texto.includes("FROM integrations")) {
        // Integracao sem a configuracao obrigatoria preenchida
        return {
          rows: [{ id: 1, provedor: "TESTE", configuracao: {}, url_base: "https://x/api/v1" }],
          rowCount: 1
        };
      }
      if (texto.includes("credential_key")) {
        return { rows: [{ credential_key: "token", encrypted_value: encryptSecret("t", ENV) }], rowCount: 1 };
      }
      if (texto.includes("integration_jobs")) return { rows: [{ id: 9, status: "ERRO_CONFIGURACAO" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };

  const job = { id: 9, integration_id: 1, job_type: "ESTOQUE", attempts: 1, payload: {} };
  const resultado = await executarJob(client, job, { fetchImpl: async () => ({}) });

  // O job falha, como esperado
  assert.equal(resultado.status, "ERRO_CONFIGURACAO");

  // ...mas a tentativa precisa ter sido registrada, senao o agendador repete a cada tick
  const tentativa = executadas.find(
    (q) => /UPDATE integration_sync_state/.test(q.texto) && /last_attempt_at/.test(q.texto)
  );
  assert.ok(tentativa, "falha de configuracao tem de registrar last_attempt_at");
  assert.deepEqual(tentativa.params, [1, "ESTOQUE"]);

  // E o registro tem de vir ANTES da leitura da integracao, que e onde a validacao ocorre
  const posTentativa = executadas.indexOf(tentativa);
  const posIntegracao = executadas.findIndex((q) => q.texto.includes("FROM integrations"));
  assert.ok(posTentativa < posIntegracao, "a tentativa precisa ser gravada antes de qualquer validacao");
});

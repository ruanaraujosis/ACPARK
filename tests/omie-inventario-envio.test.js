import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { enviarAjustesDeInventario } from "../server/services/integrations/providers/omie/tarefas/inventarios.js";
import { EVENTOS } from "../server/services/integrations/core/stock-launches.repository.js";

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");

const INTEGRACAO = { id: 1, nome: "OMIE", provedor: "OMIE", ativo: true };
const SEGREDOS = { app_key: "k", app_secret: "s" };
const LOCAL_PDV = "2001";

// Cliente de banco falso: devolve o que o teste programou, e guarda o que foi escrito
function clienteFalso({ lancamentos = [], vinculo = "999", preco = null }) {
  const escritas = [];
  return {
    escritas,
    async query(sql, params = []) {
      if (sql.includes("FROM integration_stock_launches") && sql.includes("status = ANY")) {
        // Aplica o filtro de evento como o banco aplicaria
        const eventos = params[4];
        const filtrados = eventos ? lancamentos.filter((l) => eventos.includes(l.evento)) : lancamentos;
        return { rows: filtrados };
      }
      if (sql.includes("external_product_id")) {
        return { rows: vinculo ? [{ external_product_id: vinculo }] : [] };
      }
      if (sql.includes("price, price_manual")) {
        return { rows: [{ price: preco, price_manual: null }] };
      }
      if (sql.includes("UPDATE integration_stock_launches")) {
        escritas.push({ id: params[0], status: params[1], payload: params[2] ? JSON.parse(params[2]) : null, erro: params[5] });
        return { rows: [{ id: params[0] }] };
      }
      return { rows: [] };
    }
  };
}

const lancamentoInventario = (extra = {}) => ({
  id: 10,
  codigo_pedido: "INV-2026-1",
  sku_produto: "S1",
  quantidade: "12",
  local_origem: LOCAL_PDV,
  local_destino: null,
  evento: EVENTOS.AJUSTE_INVENTARIO,
  idempotency_key: "INVENTARIO-INV-2026-1-SKU-S1-AJUSTE",
  created_at: new Date("2026-08-29T12:00:00Z"),
  ...extra
});

test("em simulação o payload é gravado e nada é enviado", async () => {
  const client = clienteFalso({ lancamentos: [lancamentoInventario()] });
  let chamou = false;
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "SIMULACAO" },
    fetchImpl: () => {
      chamou = true;
      throw new Error("não deveria chamar a OMIE em simulação");
    }
  });
  assert.equal(chamou, false, "nada pode sair em simulação");
  assert.equal(resumo.simulados, 1);
  assert.equal(resumo.enviados, 0);
  assert.match(resumo.alerta, /Nada foi enviado/);
  const gravado = client.escritas[0];
  assert.equal(gravado.status, "SIMULADO");
  assert.equal(gravado.payload.tipo, "SLD");
  assert.equal(gravado.payload.motivo, "INV");
  assert.equal(gravado.payload.codigo_local_estoque, 2001);
});

test("configuração ausente nunca significa REAL", async () => {
  const client = clienteFalso({ lancamentos: [lancamentoInventario()] });
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000" },
    fetchImpl: () => {
      throw new Error("não deveria chamar a OMIE");
    }
  });
  assert.equal(resumo.modo, "SIMULACAO");
  assert.equal(resumo.simulados, 1);
});

test("quantidade zero é enviada, e é o que zera o produto na OMIE", async () => {
  // O produto que ninguém contou vai como 0. Se a tarefa pulasse o zero, o inventário
  // ajustaria o estoque local e deixaria a OMIE com o saldo antigo.
  const client = clienteFalso({ lancamentos: [lancamentoInventario({ quantidade: "0" })] });
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "SIMULACAO" }
  });
  assert.equal(resumo.simulados, 1, "o zero não pode ser descartado");
  assert.equal(resumo.zerados, 1);
  assert.equal(client.escritas[0].payload.quan, "0");
});

test("a tarefa lê SÓ os ajustes de inventário, nunca as transferências", async () => {
  // A fila é compartilhada. Sem o filtro, esta tarefa montaria um ajuste de saldo com um
  // lançamento de transferência — escrevendo saldo absoluto onde deveria haver movimento.
  const client = clienteFalso({
    lancamentos: [
      lancamentoInventario(),
      { ...lancamentoInventario({ id: 11 }), evento: EVENTOS.RETIRADA },
      { ...lancamentoInventario({ id: 12 }), evento: EVENTOS.COMPENSACAO }
    ]
  });
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "SIMULACAO" }
  });
  assert.equal(resumo.pendentes, 1, "só o ajuste de inventário pode ser lido");
  assert.equal(client.escritas.length, 1);
  assert.equal(client.escritas[0].id, 10);
});

test("a transferência também passou a filtrar, para não roubar o ajuste de inventário", () => {
  const src = ler("server/services/integrations/providers/omie/tarefas/transferencias.js");
  assert.match(src, /eventos: \[lancamentos\.EVENTOS\.RETIRADA, lancamentos\.EVENTOS\.COMPENSACAO\]/);
});

test("produto sem vínculo vira erro explicativo, não lançamento torto", async () => {
  const client = clienteFalso({ lancamentos: [lancamentoInventario()], vinculo: null });
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "SIMULACAO" }
  });
  assert.equal(resumo.sem_vinculo_de_produto, 1);
  assert.equal(client.escritas[0].status, "ERRO");
  assert.match(client.escritas[0].erro, /nao tem vinculo com a OMIE/);
});

test("no modo REAL a chamada sai com tipo SLD e motivo INV", async () => {
  const client = clienteFalso({ lancamentos: [lancamentoInventario()], preco: 7.5 });
  const chamadas = [];
  // chamarOmie lê o corpo com text() e faz o parse por conta própria — resposta não-JSON é
  // erro, nunca objeto vazio (foi o `.json().catch(() => ({}))` que escondeu o bug do 301).
  const fetchFalso = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body) });
    return {
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ id_ajuste: 555 })
    };
  };
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: { ...INTEGRACAO, url_base: "https://app.omie.com.br/api/v1/" },
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "REAL" },
    fetchImpl: fetchFalso
  });
  assert.equal(resumo.enviados, 1);
  assert.equal(chamadas.length, 1);
  const enviado = chamadas[0].corpo.param[0];
  assert.equal(enviado.tipo, "SLD");
  assert.equal(enviado.motivo, "INV");
  assert.equal(enviado.origem, "AJU");
  assert.equal(enviado.valor, 7.5, "o preço do cadastro entra quando existe");
  assert.ok(!("codigo_local_estoque_destino" in enviado), "ajuste de saldo não tem destino");
  assert.equal(chamadas[0].corpo.call, "IncluirAjusteEstoque");
  // A URL precisa terminar com barra: sem ela a OMIE responde 301 e o POST vira GET
  assert.match(chamadas[0].url, /\/$/);
});

test("sem preço no cadastro o campo valor simplesmente não vai", async () => {
  // Diferente da transferência, não existe valor simbólico aqui: inventar 0,01 num ajuste de
  // inventário mexeria no custo do estoque sem ninguém ter pedido.
  const client = clienteFalso({ lancamentos: [lancamentoInventario()], preco: null });
  await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "SIMULACAO" }
  });
  assert.ok(!("valor" in client.escritas[0].payload));
  const src = ler("server/services/integrations/providers/omie/tarefas/inventarios.js");
  assert.doesNotMatch(src, /VALOR_SIMBOLICO/, "o inventário não usa valor simbólico");
});

test("a chave de idempotência do lançamento vira a chave da OMIE", async () => {
  // cod_int_ajuste é o que a OMIE usa para deduplicar: reprocessar a fila não pode
  // gerar um segundo ajuste do mesmo produto.
  const client = clienteFalso({ lancamentos: [lancamentoInventario()] });
  await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "SIMULACAO" }
  });
  assert.equal(client.escritas[0].payload.cod_int_ajuste, "INVENTARIO-INV-2026-1-SKU-S1-AJUSTE");
});

test("falha de um lançamento não derruba os outros", async () => {
  const client = clienteFalso({
    lancamentos: [lancamentoInventario({ local_origem: null }), lancamentoInventario({ id: 11 })]
  });
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { local_almoxarifado: "1000", modo_escrita: "SIMULACAO" }
  });
  assert.equal(resumo.falhas, 1);
  assert.equal(resumo.simulados, 1);
  assert.match(client.escritas[0].erro, /local de estoque/);
});

test("a capacidade está registrada e nasce travada pela simulação", async () => {
  const { listarProviders } = await import("../server/services/integrations/core/provider-registry.js");
  await import("../server/services/integrations/providers/index.js");
  const omie = listarProviders().find((p) => p.id === "OMIE");
  const capacidade = omie.capacidades.find((c) => c.id === "INVENTARIO");
  assert.ok(capacidade, "a capacidade INVENTARIO precisa estar no manifesto");
  assert.equal(capacidade.escrita, true, "sem escrita:true o núcleo não exige modo REAL");
  assert.equal(capacidade.executar, enviarAjustesDeInventario);
  // NAO exige local_almoxarifado: o inventario de um PDV usa o local daquele PDV. Exigir
  // aqui barraria a contagem de PDV por uma configuracao que ela nao usa -- o mesmo impasse
  // que ja travou a importacao de locais uma vez.
  assert.ok(!(capacidade.requerConfiguracao || []).includes("local_almoxarifado"));
});

test("lançamento sem local vira erro próprio, em vez de bloquear a capacidade inteira", async () => {
  const client = clienteFalso({ lancamentos: [lancamentoInventario({ local_origem: null })] });
  const resumo = await enviarAjustesDeInventario({
    client,
    integracao: INTEGRACAO,
    segredos: SEGREDOS,
    configuracao: { modo_escrita: "SIMULACAO" }
  });
  assert.equal(resumo.falhas, 1);
  assert.match(client.escritas[0].erro, /local de estoque/);
});

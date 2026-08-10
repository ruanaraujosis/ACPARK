// Teste ponta a ponta das etapas de status de um pedido, contra o banco real configurado em DATABASE_URL.
// Cria um cenário isolado (categoria, produto e PDV exclusivos do teste), roda o ciclo completo
// pelos dois caminhos da tela (quadro Kanban e painel do pedido) e apaga tudo ao final.
// Uso: node tools/e2e-status-pedidos.mjs
import "../server/env.js";
import { Readable } from "node:stream";
import { query, tx } from "../server/db.js";
import { handlePedidosRoutes } from "../server/modules/pedidos/pedidos.routes.js";

const TAG = "E2E-STATUS";
const SKU = `${TAG}-SKU`;
const CATEGORIA = `${TAG}-CAT`;
const PDV_NOME = `${TAG}-PDV`;
const ASSINATURA = `data:image/png;base64,${"A".repeat(1400)}`;

const resultados = [];
const falhas = [];

// Registra uma verificação sem interromper o restante do fluxo
function check(nome, condicao, detalhe = "") {
  resultados.push({ nome, ok: Boolean(condicao), detalhe });
  if (!condicao) falhas.push(`${nome}${detalhe ? ` — ${detalhe}` : ""}`);
}

// Resposta HTTP falsa: captura status e corpo devolvidos pelas rotas
function createResponse() {
  return {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    }
  };
}

// Executa uma rota do módulo de pedidos como se fosse uma requisição autenticada
async function call(pathname, method, { user, body = null, headers = {} } = {}) {
  const req = body ? Readable.from([JSON.stringify(body)]) : Readable.from([]);
  req.headers = headers;
  const res = createResponse();
  const context = {
    method,
    url: new URL(`http://localhost${pathname}`),
    user,
    requireUser: (_req, _res, role) => (!role || user.role === role ? user : null)
  };
  try {
    const handled = await handlePedidosRoutes(req, res, context);
    if (!handled) return { status: 404, json: { error: "rota não tratada" } };
  } catch (error) {
    return { status: error.statusCode || 500, json: { error: error.message } };
  }
  let json = {};
  try {
    json = JSON.parse(res.body || "{}");
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

// Linhas do pedido direto do banco, para conferir o efeito real de cada etapa
function linhasDoPedido(codigo) {
  return query(
    `SELECT id, sku_produto, status, quantidade_solicitada, quantidade_liberada, version,
            em_andamento_em, liberado_em, pronto_retirada_em, retirada_em,
            retirada_assinatura IS NOT NULL AS assinado
     FROM pedidos WHERE codigo_pedido = $1 ORDER BY id`,
    [codigo]
  );
}

// Saldos do produto de teste no estoque central e no PDV de teste
async function saldos(pdvId) {
  const central = await query("SELECT qtd_total FROM produtos WHERE sku = $1", [SKU]);
  const pdv = await query("SELECT quantidade FROM estoque_pdv WHERE pdv_id = $1 AND sku_produto = $2", [pdvId, SKU]);
  return { central: Number(central[0]?.qtd_total || 0), pdv: Number(pdv[0]?.quantidade || 0) };
}

// Cria o cenário isolado usado pelo teste
function montarCenario() {
  return tx(async (client) => {
    await client.query("INSERT INTO categorias (nome) VALUES ($1) ON CONFLICT DO NOTHING", [CATEGORIA]);
    await client.query(
      `INSERT INTO produtos (sku, nome, qtd_total, estoque_minimo, ativo, categoria, origem)
       VALUES ($1, $2, 100, 0, TRUE, $3, 'manual')
       ON CONFLICT (sku) DO UPDATE SET qtd_total = 100, ativo = TRUE`,
      [SKU, `${TAG} Produto`, CATEGORIA]
    );
    await client.query(
      "INSERT INTO produto_categorias (sku_produto, categoria) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [SKU, CATEGORIA]
    );
    const pdv = await client.query(
      "INSERT INTO pdvs (nome, senha, is_cozinha) VALUES ($1, $2, FALSE) RETURNING id",
      [PDV_NOME, "e2e-teste"]
    );
    const pdvId = pdv.rows[0].id;
    await client.query("INSERT INTO pdv_categorias (pdv_id, categoria) VALUES ($1, $2)", [pdvId, CATEGORIA]);
    await client.query(
      `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade, estoque_minimo, estoque_maximo, permitido)
       VALUES ($1, $2, 0, 0, 50, TRUE)`,
      [pdvId, SKU]
    );
    return pdvId;
  });
}

// Remove o cenário e todos os pedidos gerados pelo teste
function limparCenario(pdvId) {
  return tx(async (client) => {
    const codigos = await client.query("SELECT DISTINCT codigo_pedido FROM pedidos WHERE pdv_id = $1", [pdvId]);
    for (const row of codigos.rows) {
      await client.query("DELETE FROM pedido_auditoria WHERE codigo_pedido = $1", [row.codigo_pedido]);
      await client.query("DELETE FROM pedido_historico WHERE codigo_pedido = $1", [row.codigo_pedido]);
    }
    await client.query("DELETE FROM pedido_idempotencia WHERE pdv_id = $1", [pdvId]);
    await client.query("DELETE FROM pedido_rascunhos WHERE pdv_id = $1", [pdvId]);
    await client.query("DELETE FROM pedidos WHERE pdv_id = $1", [pdvId]);
    await client.query("DELETE FROM estoque_pdv WHERE pdv_id = $1", [pdvId]);
    await client.query("DELETE FROM pdv_categorias WHERE pdv_id = $1", [pdvId]);
    await client.query("DELETE FROM pdvs WHERE id = $1", [pdvId]);
    await client.query("DELETE FROM produto_categorias WHERE sku_produto = $1", [SKU]);
    await client.query("DELETE FROM produtos WHERE sku = $1", [SKU]);
    await client.query("DELETE FROM categorias WHERE nome = $1", [CATEGORIA]);
  });
}

let pdvId = null;
try {
  pdvId = await montarCenario();
  const pdvUser = { role: "pdv", pdvId, name: PDV_NOME };
  const admin = { role: "admin", name: `${TAG} Almoxarifado` };

  // Cria um pedido novo do PDV de teste
  async function novoPedido(quantidade) {
    const criacao = await call("/api/pdv/order", "POST", {
      user: pdvUser,
      headers: { "idempotency-key": `${TAG}-${Date.now()}-${Math.random()}` },
      body: { solicitante: "TESTE E2E", observacao: "pedido de teste automatizado", items: [{ sku: SKU, quantidade }] }
    });
    check("PDV cria pedido (HTTP 201)", criacao.status === 201, JSON.stringify(criacao.json));
    return criacao.json.codigo;
  }

  // Move o card no quadro Kanban
  async function moverNoKanban(codigo, de, para) {
    const linhas = await linhasDoPedido(codigo);
    const codigos = { Pendente: "PENDENTE", "Em Andamento": "EM_ANDAMENTO", "Aguardando Retirada": "AGUARDANDO_RETIRADA", Finalizado: "FINALIZADO" };
    return call("/api/admin/orders/status", "PATCH", {
      user: admin,
      body: { codigo_pedido: codigo, expected_status: codigos[de], status: codigos[para], version: linhas[0]?.version }
    });
  }

  // ---------------------------------------------------------------
  // Caminho 1 — ciclo completo arrastando o card no quadro Kanban
  // ---------------------------------------------------------------
  const kanban = await novoPedido(10);
  const saldoInicial = await saldos(pdvId);
  let linhas = await linhasDoPedido(kanban);
  check("pedido nasce em Pendente", linhas.every((l) => l.status === "Pendente"), JSON.stringify(linhas.map((l) => l.status)));

  const paraAndamento = await moverNoKanban(kanban, "Pendente", "Em Andamento");
  check("Kanban Pendente -> Em Andamento (HTTP 200)", paraAndamento.status === 200, JSON.stringify(paraAndamento.json));
  linhas = await linhasDoPedido(kanban);
  check("status virou Em Andamento", linhas.every((l) => l.status === "Em Andamento"));
  check("em_andamento_em preenchido", linhas.every((l) => l.em_andamento_em));

  const versaoVelha = await call("/api/admin/orders/status", "PATCH", {
    user: admin,
    body: { codigo_pedido: kanban, expected_status: "EM_ANDAMENTO", status: "AGUARDANDO_RETIRADA", version: 1 }
  });
  check("versão desatualizada gera conflito 409", versaoVelha.status === 409, `HTTP ${versaoVelha.status}`);

  const paraRetirada = await moverNoKanban(kanban, "Em Andamento", "Aguardando Retirada");
  check("Kanban Em Andamento -> Aguardando Retirada (HTTP 200)", paraRetirada.status === 200, JSON.stringify(paraRetirada.json));
  linhas = await linhasDoPedido(kanban);
  check("status virou Aguardando Retirada", linhas.every((l) => l.status === "Aguardando Retirada"));
  check(
    "Kanban libera a quantidade total solicitada",
    linhas.every((l) => Number(l.quantidade_liberada) === Number(l.quantidade_solicitada)),
    JSON.stringify(linhas.map((l) => [l.quantidade_solicitada, l.quantidade_liberada]))
  );
  check("resposta informa a quantidade liberada", Number(paraRetirada.json.quantidade_liberada) === 10, JSON.stringify(paraRetirada.json));
  check("liberado_em e pronto_retirada_em preenchidos", linhas.every((l) => l.liberado_em && l.pronto_retirada_em));

  // Voltar o card para Em Andamento preserva a quantidade liberada (o almoxarifado não pode
  // perder uma edição já feita só por voltar de etapa), mas ainda limpa as datas da etapa abandonada
  const voltaAndamento = await moverNoKanban(kanban, "Aguardando Retirada", "Em Andamento");
  check("Kanban Aguardando Retirada -> Em Andamento (HTTP 200)", voltaAndamento.status === 200, JSON.stringify(voltaAndamento.json));
  linhas = await linhasDoPedido(kanban);
  check("voltar preserva a quantidade liberada", linhas.every((l) => Number(l.quantidade_liberada) === 10), JSON.stringify(linhas.map((l) => l.quantidade_liberada)));
  check("voltar limpa liberado_em/pronto_retirada_em", linhas.every((l) => !l.liberado_em && !l.pronto_retirada_em));

  const voltaPendente = await moverNoKanban(kanban, "Em Andamento", "Pendente");
  check("Kanban Em Andamento -> Pendente (HTTP 200)", voltaPendente.status === 200, JSON.stringify(voltaPendente.json));
  linhas = await linhasDoPedido(kanban);
  check("voltar para Pendente limpa em_andamento_em", linhas.every((l) => !l.em_andamento_em));
  // Diferente de Em Andamento, voltar até Pendente ainda zera a liberação — nada foi decidido
  check("voltar para Pendente zera a quantidade liberada", linhas.every((l) => Number(l.quantidade_liberada) === 0), JSON.stringify(linhas.map((l) => l.quantidade_liberada)));

  // Segue o ciclo até o fim pelo quadro
  await moverNoKanban(kanban, "Pendente", "Em Andamento");
  await moverNoKanban(kanban, "Em Andamento", "Aguardando Retirada");
  const retiradaKanban = await call("/api/admin/order-withdrawal", "POST", {
    user: admin,
    body: { codigo_pedido: kanban, responsavel_retirada: "TESTE E2E", assinatura: ASSINATURA, status: "Aguardando Retirada" }
  });
  check("retirada confirmada após ciclo pelo Kanban (HTTP 200)", retiradaKanban.status === 200, JSON.stringify(retiradaKanban.json));
  linhas = await linhasDoPedido(kanban);
  check("pedido do Kanban ficou Finalizado", linhas.every((l) => l.status === "Finalizado"), JSON.stringify(linhas.map((l) => l.status)));
  check("assinatura registrada", linhas.every((l) => l.assinado));
  let saldoAtual = await saldos(pdvId);
  check("estoque central baixou 10", saldoAtual.central === saldoInicial.central - 10, `${saldoInicial.central} -> ${saldoAtual.central}`);
  check("estoque do PDV subiu 10", saldoAtual.pdv === saldoInicial.pdv + 10, `${saldoInicial.pdv} -> ${saldoAtual.pdv}`);

  const retiradaRepetida = await call("/api/admin/order-withdrawal", "POST", {
    user: admin,
    body: { codigo_pedido: kanban, responsavel_retirada: "TESTE E2E", assinatura: ASSINATURA, status: "Aguardando Retirada" }
  });
  check("retirada repetida é bloqueada", retiradaRepetida.status >= 400, `HTTP ${retiradaRepetida.status}`);

  // Reabertura do pedido finalizado precisa estornar a baixa
  const reabertura = await call("/api/admin/order-flow", "POST", { user: admin, body: { codigo_pedido: kanban, status: "Em Andamento" } });
  check("reabrir pedido finalizado (HTTP 200)", reabertura.status === 200, JSON.stringify(reabertura.json));
  linhas = await linhasDoPedido(kanban);
  check("pedido reaberto volta para Em Andamento", linhas.every((l) => l.status === "Em Andamento"));
  check("reabertura limpa a assinatura", linhas.every((l) => !l.assinado));
  check("reabertura limpa liberado_em", linhas.every((l) => !l.liberado_em && !l.pronto_retirada_em));
  check("reabertura preserva a quantidade solicitada", linhas.every((l) => Number(l.quantidade_solicitada) === 10));
  // Este pedido tinha liberado os 10 via Kanban antes de finalizar; reabrir não pode zerar isso
  check("reabertura preserva a quantidade liberada", linhas.every((l) => Number(l.quantidade_liberada) === 10), JSON.stringify(linhas.map((l) => l.quantidade_liberada)));
  saldoAtual = await saldos(pdvId);
  check("estoque central estornado", saldoAtual.central === saldoInicial.central, `esperado ${saldoInicial.central}, atual ${saldoAtual.central}`);
  check("estoque do PDV estornado", saldoAtual.pdv === saldoInicial.pdv, `esperado ${saldoInicial.pdv}, atual ${saldoAtual.pdv}`);

  // ---------------------------------------------------------------
  // Caminho 2 — ciclo pelo painel do pedido, com liberação parcial
  // ---------------------------------------------------------------
  const painel = await novoPedido(10);
  const antesParcial = await saldos(pdvId);
  await moverNoKanban(painel, "Pendente", "Em Andamento");
  linhas = await linhasDoPedido(painel);

  // Regra de negócio: o almoxarifado pode liberar acima do solicitado; o sistema registra e avisa
  const excesso = await call("/api/admin/order-flow", "POST", {
    user: admin,
    body: {
      codigo_pedido: painel,
      status: "Aguardando Retirada",
      release_mode: "entered-only",
      items: linhas.map((l) => ({ id: l.id, version: l.version, quantidade_liberada: 12 }))
    }
  });
  check("liberar mais que o solicitado é aceito (HTTP 200)", excesso.status === 200, `HTTP ${excesso.status} ${JSON.stringify(excesso.json)}`);
  check("excedente devolvido para aviso na tela", Array.isArray(excesso.json?.excedentes) && excesso.json.excedentes.length > 0, JSON.stringify(excesso.json?.excedentes));
  linhas = await linhasDoPedido(painel);
  check("quantidade acima do solicitado foi gravada (12)", linhas.every((l) => Number(l.quantidade_liberada) === 12), JSON.stringify(linhas.map((l) => l.quantidade_liberada)));

  // Reenviar "Aguardando Retirada" para um item que já está lá (pedido com itens em status
  // misto, reenviando o painel inteiro) não pode travar com "Movimentação não permitida" —
  // e a edição feita no reenvio deve ser aplicada, não ignorada
  const reenvioMesmoStatus = await call("/api/admin/order-flow", "POST", {
    user: admin,
    body: {
      codigo_pedido: painel,
      status: "Aguardando Retirada",
      release_mode: "entered-only",
      items: linhas.map((l) => ({ id: l.id, version: l.version, quantidade_liberada: 9 }))
    }
  });
  check("reenviar o mesmo status (self-transition) é aceito (HTTP 200)", reenvioMesmoStatus.status === 200, `HTTP ${reenvioMesmoStatus.status} ${JSON.stringify(reenvioMesmoStatus.json)}`);
  linhas = await linhasDoPedido(painel);
  check("edição no reenvio foi aplicada (9), não ignorada", linhas.every((l) => Number(l.quantidade_liberada) === 9), JSON.stringify(linhas.map((l) => l.quantidade_liberada)));

  // Volta para Em Andamento para seguir com o cenário de liberação parcial. A liberação de 9
  // (do reenvio acima) precisa ser preservada — voltar de etapa não pode descartar a edição
  // que o almoxarifado já tinha feito.
  await call("/api/admin/order-flow", "POST", {
    user: admin,
    body: { codigo_pedido: painel, status: "Em Andamento", current_status: "Aguardando Retirada", items: linhas.map((l) => ({ id: l.id, version: l.version })) }
  });
  linhas = await linhasDoPedido(painel);
  check("volta de etapa preserva a liberação acima do solicitado", linhas.every((l) => Number(l.quantidade_liberada) === 9), JSON.stringify(linhas.map((l) => l.quantidade_liberada)));

  const parcial = await call("/api/admin/order-flow", "POST", {
    user: admin,
    body: {
      codigo_pedido: painel,
      status: "Aguardando Retirada",
      release_mode: "entered-only",
      items: linhas.map((l) => ({ id: l.id, version: l.version, quantidade_liberada: 4 }))
    }
  });
  check("liberação parcial de 4 de 10 (HTTP 200)", parcial.status === 200, JSON.stringify(parcial.json));
  linhas = await linhasDoPedido(painel);
  check("quantidade liberada gravada como 4", linhas.every((l) => Number(l.quantidade_liberada) === 4), JSON.stringify(linhas.map((l) => l.quantidade_liberada)));

  const retiradaParcial = await call("/api/admin/order-withdrawal", "POST", {
    user: admin,
    body: { codigo_pedido: painel, responsavel_retirada: "TESTE E2E", assinatura: ASSINATURA, observacao: "retirada parcial de teste", status: "Aguardando Retirada" }
  });
  check("retirada da liberação parcial (HTTP 200)", retiradaParcial.status === 200, JSON.stringify(retiradaParcial.json));
  const depoisParcial = await saldos(pdvId);
  check("estoque central baixou só o liberado (4)", depoisParcial.central === antesParcial.central - 4, `${antesParcial.central} -> ${depoisParcial.central}`);
  check("estoque do PDV subiu só o liberado (4)", depoisParcial.pdv === antesParcial.pdv + 4, `${antesParcial.pdv} -> ${depoisParcial.pdv}`);

  // A sobra (10 solicitados - 4 liberados) não vira pendência: fica só como informação
  const sobras = retiradaParcial.json?.sobras || [];
  check("sobra devolvida como aviso, não como pendência", sobras.length === 1 && Number(sobras[0].nao_atendida) === 6, JSON.stringify(sobras));
  linhas = await linhasDoPedido(painel);
  check("pedido finalizou sem deixar item aberto", linhas.every((l) => l.status === "Finalizado"), JSON.stringify(linhas.map((l) => l.status)));
  check("solicitado e liberado ficam registrados (10 e 4)", linhas.every((l) => Number(l.quantidade_solicitada) === 10 && Number(l.quantidade_liberada) === 4), JSON.stringify(linhas.map((l) => `${l.quantidade_solicitada}/${l.quantidade_liberada}`)));
  const complementares = await call(`/api/admin/orders?q=${encodeURIComponent(painel)}&active=1`, "GET", { user: admin });
  check("nenhum pedido complementar foi criado para a sobra", (complementares.json?.orders || []).length === 0, JSON.stringify((complementares.json?.orders || []).map((o) => o.codigo_pedido)));

  // A linha do tempo precisa ter registrado as três origens de movimentação
  const timeline = await call(`/api/admin/order-timeline?codigo_pedido=${encodeURIComponent(painel)}`, "GET", { user: admin });
  const acoes = (timeline.json?.timeline || []).map((linha) => linha.acao);
  check("auditoria registrou movimentação pelo quadro", acoes.includes("status_alterado_kanban"), JSON.stringify(acoes));
  check("auditoria registrou movimentação pelo painel", acoes.includes("status_alterado_painel"), JSON.stringify(acoes));
  check("auditoria registrou a confirmação de retirada", acoes.includes("retirada_confirmada"), JSON.stringify(acoes));
  const comDeEPara = (timeline.json?.timeline || []).filter((linha) => linha.dados?.novo_status);
  check("auditoria guarda de onde para onde o pedido foi", comDeEPara.length >= 3, JSON.stringify(comDeEPara.map((l) => `${l.dados?.status_anterior}->${l.dados?.novo_status}`)));
  check("auditoria guarda quem moveu", (timeline.json?.timeline || []).every((linha) => Boolean(linha.usuario)), JSON.stringify((timeline.json?.timeline || []).map((l) => l.usuario)));

  // ---------------------------------------------------------------
  // Regras de transição e visões de leitura
  // ---------------------------------------------------------------
  const finalizadoDireto = await call("/api/admin/orders/status", "PATCH", {
    user: admin,
    body: { codigo_pedido: painel, expected_status: "EM_ANDAMENTO", status: "FINALIZADO" }
  });
  check("Kanban recusa pular direto para Finalizado", finalizadoDireto.status === 400, `HTTP ${finalizadoDireto.status}`);

  const semAssinatura = await call("/api/admin/order-flow", "POST", { user: admin, body: { codigo_pedido: painel, status: "Finalizado" } });
  check("order-flow recusa Finalizado sem assinatura", semAssinatura.status === 400, `HTTP ${semAssinatura.status}`);

  const inexistente = await call("/api/admin/orders/status", "PATCH", {
    user: admin,
    body: { codigo_pedido: "PED-NAO-EXISTE", expected_status: "PENDENTE", status: "EM_ANDAMENTO" }
  });
  check("pedido inexistente responde 404", inexistente.status === 404, `HTTP ${inexistente.status}`);

  const visaoPdv = await call("/api/pdv/orders", "GET", { user: pdvUser });
  const noPdv = (visaoPdv.json.orders || []).filter((o) => o.codigo_pedido === painel);
  check("PDV enxerga o pedido finalizado", noPdv.length > 0 && noPdv.every((o) => o.status === "Finalizado"), JSON.stringify(noPdv.map((o) => o.status)));

  const visaoAdmin = await call(`/api/admin/orders?q=${painel}`, "GET", { user: admin });
  const noAdmin = (visaoAdmin.json.orders || []).filter((o) => o.codigo_pedido === painel);
  check("Almoxarifado enxerga o mesmo status do PDV", noAdmin.length > 0 && noAdmin.every((o) => o.status === "Finalizado"), JSON.stringify(noAdmin.map((o) => o.status)));

  const historico = await call(`/api/admin/history?pdvId=${pdvId}`, "GET", { user: admin });
  check("histórico traz os pedidos do teste", (historico.json.history || []).some((h) => h.codigo_pedido === painel));

  const auditoria = await query("SELECT acao FROM pedido_auditoria WHERE codigo_pedido = $1", [kanban]);
  check("auditoria registrou as movimentações do Kanban", auditoria.length >= 4, `${auditoria.length} registros`);
} catch (error) {
  falhas.push(`ERRO FATAL: ${error.message}`);
  console.error(error);
} finally {
  if (pdvId) await limparCenario(pdvId);
}

console.log("=== Ciclo de status do pedido — teste ponta a ponta ===");
for (const item of resultados) {
  console.log(`${item.ok ? "OK   " : "FALHA"} ${item.nome}${item.ok || !item.detalhe ? "" : ` — ${item.detalhe}`}`);
}
console.log(`\n${resultados.length} verificações, ${falhas.length} falha(s).`);
process.exit(falhas.length ? 1 : 0);

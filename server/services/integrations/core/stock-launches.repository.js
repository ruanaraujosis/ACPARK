// Lancamentos de estoque que o MyEstoque deve enviar ao sistema externo.
//
// Generico: um lancamento e "mova N unidades do local X para o local Y, por causa deste item
// de pedido". Nenhum provider especifico aparece aqui -- quem traduz isso para o formato de
// uma API e o provider.

// A coluna que guarda as causas distintas nasce em runtime, no padrao ensureXxx do projeto.
// Memoizada: a fila chama registrarResultado em laco, e um ALTER por lancamento seria caro.
let historicoPronto = null;
export function ensureHistoricoDeErros(client) {
  historicoPronto ||= client
    .query("ALTER TABLE integration_stock_launches ADD COLUMN IF NOT EXISTS historico_erros JSONB")
    .then(() => true)
    .catch((erro) => {
      historicoPronto = null; // deixa tentar de novo
      throw erro;
    });
  return historicoPronto;
}

export const EVENTOS = Object.freeze({
  RETIRADA: "RETIRADA",
  COMPENSACAO: "COMPENSACAO",
  // Ajuste gerado pela assinatura de um inventario. Mora aqui, e nao no dominio de
  // inventario, para o provider que drena a fila nao precisar importar aquele modulo.
  AJUSTE_INVENTARIO: "INVENTARIO_AJUSTE",
  // Saida por consumo interno de um PDV Administrativo (setor que consome sem vender).
  // E evento proprio, e nao uma RETIRADA, porque o movimento na OMIE e outro: RETIRADA vira
  // transferencia entre locais (a mercadoria continua na empresa), esta vira SAIDA (a
  // mercadoria deixa o estoque). Misturar os dois faria a tarefa de transferencias montar
  // TRF para consumo, que e exatamente o erro que este perfil precisa evitar.
  CONSUMO_ADMINISTRATIVO: "CONSUMO_ADMIN"
});

export const STATUS = Object.freeze({
  PENDENTE: "PENDENTE",
  SIMULADO: "SIMULADO",
  ENVIADO: "ENVIADO",
  ERRO: "ERRO",
  CANCELADO: "CANCELADO"
});

// Status que ainda serao processados pela fila.
//
// SIMULADO entra aqui de proposito: simulacao NAO e um estado final, e sim "ainda nao saiu".
// Sem isso, tudo que passou pela simulacao ficava num beco sem saida -- ligar o modo REAL nao
// reprocessava nada, porque a fila nem enxergava esses lancamentos. Medido em producao: 381
// transferencias de retirada paradas em SIMULADO, nenhuma com enviado_em.
//
// Reprocessar e seguro: a chave de idempotencia continua sendo a mesma, e `foiEnviado`
// impede que um lancamento ja aceito pela OMIE seja mandado de novo.
export const STATUS_ABERTOS = [STATUS.PENDENTE, STATUS.ERRO, STATUS.SIMULADO];

// Monta a chave de idempotencia de um lancamento.
//
// A versao entra na chave de proposito: reabrir um pedido e finalizar de novo precisa gerar
// um lancamento NOVO, nao ser barrado como repetido. Sem ela, a segunda retirada do mesmo
// item seria silenciosamente descartada e os dois sistemas divergiriam.
export function montarChaveIdempotencia({ codigoPedido, pedidoItemId, sku, evento, versao }) {
  const alvo = pedidoItemId || sku || "SEMITEM";
  return `PEDIDO-${codigoPedido}-ITEM-${alvo}-${evento}-V${versao}`;
}

// Quantas vezes este item ja gerou um lancamento deste evento. Serve de versao da chave.
async function proximaVersao(client, { codigoPedido, pedidoItemId, evento }) {
  const resultado = await client.query(
    `SELECT COUNT(*)::int AS total
     FROM integration_stock_launches
     WHERE codigo_pedido = $1 AND pedido_item_id IS NOT DISTINCT FROM $2 AND evento = $3`,
    [codigoPedido, pedidoItemId, evento]
  );
  return (resultado.rows[0]?.total || 0) + 1;
}

// Registra um lancamento pendente. Devolve a linha criada, ou a existente quando a chave de
// idempotencia ja tinha sido usada -- e isso que faz reprocessar a fila nunca duplicar.
export async function registrarLancamento(client, dados) {
  const versao = dados.versao || (await proximaVersao(client, dados));
  const chave =
    dados.idempotencyKey ||
    montarChaveIdempotencia({
      codigoPedido: dados.codigoPedido,
      pedidoItemId: dados.pedidoItemId,
      sku: dados.sku,
      evento: dados.evento,
      versao
    });

  const resultado = await client.query(
    `INSERT INTO integration_stock_launches
       (integration_id, codigo_pedido, pedido_item_id, sku_produto, pdv_id, quantidade,
        local_origem, local_destino, evento, idempotency_key, modo, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDENTE')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      dados.integrationId || null,
      dados.codigoPedido,
      dados.pedidoItemId || null,
      dados.sku,
      dados.pdvId || null,
      dados.quantidade,
      dados.localOrigem || null,
      dados.localDestino || null,
      dados.evento,
      chave,
      dados.modo || "SIMULACAO"
    ]
  );

  if (resultado.rows[0]) return { lancamento: resultado.rows[0], criado: true };

  const existente = await client.query("SELECT * FROM integration_stock_launches WHERE idempotency_key = $1 LIMIT 1", [
    chave
  ]);
  return { lancamento: existente.rows[0] || null, criado: false };
}

// Lancamentos ainda por enviar, mais antigos primeiro
// `apenas` restringe a UM lancamento, pelo id.
//
// Existe para a virada de simulacao para real: o primeiro envio verdadeiro e de um so,
// conferido na tela do ERP, antes de soltar o resto.
//
// A ordenacao poe quem esta em ERRO no FIM da fila, nunca no comeco.
//
// Medido em producao: 44 lancamentos sem preco, mais antigos que o resto, ocupavam as
// primeiras vagas de toda leitura. Como o agendador le 25 por vez, ele nunca alcancava um
// lancamento novo -- a fila inteira ficava refem de pendencias que nao tinham como sair.
// Elas continuam sendo retentadas, so que depois de quem ainda nao teve a primeira chance.
//
// `eventos` restringe aos tipos que a tarefa chamadora sabe montar. Existe desde que a fila
// passou a carregar mais de um tipo de escrita: sem o filtro, a tarefa de transferencia lia
// um ajuste de inventario, tentava montar payload de transferencia com ele (que exige local
// de destino, nulo no inventario), falhava e marcava o lancamento como ERRO -- deixando-o
// preso numa fila que a tarefa certa nunca leria de volta a tempo.
export async function listarAbertos(client, { integrationId = null, limite = 50, apenas = null, eventos = null } = {}) {
  const listaDeEventos = Array.isArray(eventos) && eventos.length ? eventos : null;
  const resultado = await client.query(
    `SELECT * FROM integration_stock_launches
     WHERE status = ANY($1::text[])
       AND ($2::bigint IS NULL OR integration_id = $2 OR integration_id IS NULL)
       AND ($4::bigint IS NULL OR id = $4)
       AND ($5::text[] IS NULL OR evento = ANY($5::text[]))
     ORDER BY (status = 'ERRO'), created_at
     LIMIT $3`,
    [STATUS_ABERTOS, integrationId, Math.min(Number(limite) || 50, 200), apenas, listaDeEventos]
  );
  return resultado.rows;
}

// Marca o resultado do lancamento. Em simulacao o payload e gravado e nada e enviado.
//
// `erro` NAO sobrescreve cegamente a causa anterior. Ate 29/08/2026 cada retentativa apagava
// a mensagem da tentativa passada: 10 dos 12 lancamentos recusados por saldo negativo tiveram
// a causa real substituida por "API bloqueada por consumo", e o diagnostico so foi recuperado
// olhando o que sobrou. Agora cada causa distinta fica em historico_erros, que sobrevive as
// retentativas seguintes; `erro` continua sendo a mais recente, para a tela nao mudar.
export async function registrarResultado(client, id, { status, payload, resposta, externalId, erro }) {
  await ensureHistoricoDeErros(client);
  const resultado = await client.query(
    `UPDATE integration_stock_launches
     SET status = $2,
         payload = COALESCE($3::jsonb, payload),
         resposta = COALESCE($4::jsonb, resposta),
         external_id = COALESCE($5, external_id),
         erro = $6,
         -- Guarda cada causa DISTINTA, sem apagar as anteriores
         historico_erros = CASE
           WHEN $6::text IS NULL THEN historico_erros
           WHEN historico_erros IS NULL THEN jsonb_build_array(
             jsonb_build_object('erro', $6::text, 'em', to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'))
           )
           WHEN historico_erros @> jsonb_build_array(jsonb_build_object('erro', $6::text)) THEN historico_erros
           -- Teto de 5 causas distintas: o suficiente para diagnosticar sem a coluna crescer
           WHEN jsonb_array_length(historico_erros) >= 5 THEN historico_erros
           ELSE historico_erros || jsonb_build_array(
             jsonb_build_object('erro', $6::text, 'em', to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'))
           )
         END,
         tentativas = tentativas + 1,
         enviado_em = CASE WHEN $2 = 'ENVIADO' THEN CURRENT_TIMESTAMP ELSE enviado_em END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      payload ? JSON.stringify(payload) : null,
      resposta ? JSON.stringify(resposta) : null,
      externalId || null,
      erro ? String(erro).slice(0, 1000) : null
    ]
  );
  return resultado.rows[0] || null;
}

// Lancamentos de um pedido, para a linha do tempo
export async function listarPorPedido(client, codigoPedido) {
  const resultado = await client.query(
    `SELECT id, sku_produto, pdv_id, quantidade, local_origem, local_destino, evento,
            idempotency_key, modo, status, external_id, erro, tentativas, enviado_em, created_at
     FROM integration_stock_launches
     WHERE codigo_pedido = $1
     ORDER BY created_at`,
    [codigoPedido]
  );
  return resultado.rows;
}

// Recoloca um lancamento em ERRO de volta na fila (botao da tela, sem terminal)
export async function reabrirLancamento(client, id) {
  const resultado = await client.query(
    `UPDATE integration_stock_launches
     SET status = 'PENDENTE', erro = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status <> 'ENVIADO'
     RETURNING *`,
    [id]
  );
  return resultado.rows[0] || null;
}

// Um lancamento ja enviado de verdade e o que obriga a compensacao na reabertura
export async function foiEnviado(client, { codigoPedido, pedidoItemId }) {
  const resultado = await client.query(
    `SELECT 1 FROM integration_stock_launches
     WHERE codigo_pedido = $1
       AND pedido_item_id IS NOT DISTINCT FROM $2
       AND evento = 'RETIRADA'
       AND status = 'ENVIADO'
     LIMIT 1`,
    [codigoPedido, pedidoItemId]
  );
  return resultado.rows.length > 0;
}

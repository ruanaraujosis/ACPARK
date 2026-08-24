import { query, tx, asInt, code } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import {
  registrarCompensacaoDaReabertura,
  registrarTransferenciasDaRetirada
} from "../../services/integrations/core/stock-launches.service.js";
import { converterQuantidadeDoPedido } from "../../services/integrations/core/fator-conversao.repository.js";
import { publishOrderAlert, publishOrderStatusChange } from "../../services/order-alerts/order-alerts.events.js";
import { normalizeOrderStatus, orderStatuses } from "./pedidos.service.js";

let pedidoEditColumnsReady = null;
let pedidoIdempotencyReady = null;
let pedidoDraftReady = null;
let pedidoAuditReady = null;

// Cria a tabela de controle de idempotência para criação de pedidos (cacheado em memória)
export function ensurePedidoIdempotencyTable() {
  pedidoIdempotencyReady ||= tx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedido_idempotencia (
        id SERIAL PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        pdv_id INTEGER REFERENCES pdvs(id) ON DELETE CASCADE,
        codigo_pedido TEXT,
        status TEXT DEFAULT 'processing',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
  return pedidoIdempotencyReady;
}

// Cria a tabela de rascunhos de pedido do PDV (cacheado em memória)
export function ensurePedidoDraftTable() {
  pedidoDraftReady ||= tx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedido_rascunhos (
        pdv_id INTEGER PRIMARY KEY REFERENCES pdvs(id) ON DELETE CASCADE,
        solicitante TEXT,
        observacao TEXT,
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
  return pedidoDraftReady;
}

// Garante colunas adicionais usadas na edição/reabertura de pedidos (cacheado em memória)
export function ensurePedidoEditColumns() {
  pedidoEditColumnsReady ||= tx(async (client) => {
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado BOOLEAN DEFAULT FALSE");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado_em TIMESTAMP");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_editado_por TEXT");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pedido_reaberto_finalizado BOOLEAN DEFAULT FALSE");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS release_mode TEXT");
    await client.query("ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS item_origem TEXT DEFAULT 'PDV'");
  });
  return pedidoEditColumnsReady;
}

// Cria a tabela de auditoria de ações administrativas sobre pedidos (cacheado em memória)
export function ensurePedidoAuditTable() {
  pedidoAuditReady ||= tx(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pedido_auditoria (
        id SERIAL PRIMARY KEY,
        codigo_pedido TEXT NOT NULL,
        acao TEXT NOT NULL,
        usuario TEXT,
        observacao TEXT,
        dados JSONB NOT NULL DEFAULT '{}'::jsonb,
        criado_em TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')
      )
    `);
  });
  return pedidoAuditReady;
}

// Registra uma mudança de etapa na auditoria: quem moveu, de onde para onde e quando.
// Usado pelas três rotas que mexem em status (Kanban, painel e confirmação de retirada).
async function registrarAuditoriaStatus(client, { codigoPedido, acao, usuario, de = "", para = "", observacao = "", dados = {} } = {}) {
  const codigo = normalizeText(codigoPedido, 80);
  if (!codigo) return;
  // A tabela é garantida antes da transação pela rota que chama, como no restante do arquivo
  const texto = observacao || (de ? `Status alterado de ${de} para ${para}` : `Status alterado para ${para}`);
  await client.query(
    `INSERT INTO pedido_auditoria (codigo_pedido, acao, usuario, observacao, dados)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [codigo, acao, usuario || "Almoxarifado", texto, JSON.stringify({ status_anterior: de || null, novo_status: para || null, ...dados })]
  );
}

// Corrige pedidos presos em status legados de liberação parcial, migrando-os para Aguardando Retirada
async function ensurePartialReleaseRemainders() {
  await ensurePedidoEditColumns();
  await tx(async (client) => {
    await client.query(
      `UPDATE pedidos
       SET status = 'Aguardando Retirada',
           updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('Liberação Parcial', 'Liberado Parcial')`
    );
  });
}

// Lê a chave de idempotência do header ou do corpo da requisição
function normalizeIdempotencyKey(req, body) {
  const header = req.headers?.["idempotency-key"] || req.headers?.["Idempotency-Key"];
  return normalizeText(header || body.idempotencyKey || body.idempotency_key, 120);
}

// Converte os códigos de status enviados pelo Kanban (ex: EM_ANDAMENTO) para o texto usado no banco
function statusFromRequest(value) {
  const status = normalizeText(value, 80);
  const map = {
    PENDENTE: "Pendente",
    EM_ANDAMENTO: "Em Andamento",
    AGUARDANDO_RETIRADA: "Aguardando Retirada",
    FINALIZADO: "Finalizado"
  };
  return map[status] || status;
}

// Roteador do módulo de pedidos (solicitação, liberação e histórico)
export async function handlePedidosRoutes(req, res, context) {
  const { method, requireUser, url, user } = context;

  // Rascunho de pedido do PDV, salvo automaticamente antes do envio definitivo
  if (url.pathname === "/api/pdv/order-draft") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para gerenciar rascunhos." }), true;
    await ensurePedidoDraftTable();

    if (method === "GET") {
      const rows = await query(
        `SELECT solicitante, observacao, items, atualizado_em
         FROM pedido_rascunhos
         WHERE pdv_id = $1`,
        [user.pdvId]
      );
      const draft = rows[0]
        ? {
            solicitante: rows[0].solicitante || "",
            observacao: rows[0].observacao || "",
            items: Array.isArray(rows[0].items) ? rows[0].items : [],
            atualizado_em: rows[0].atualizado_em
          }
        : null;
      return send(res, 200, { draft }), true;
    }

    if (method === "POST") {
      const body = await readBody(req);
      const solicitante = normalizeText(body.solicitante, 80).toUpperCase();
      const observacao = normalizeText(body.observacao, 500);
      const rawItems = Array.isArray(body.items) ? body.items : [];
      const items = rawItems.map((item) => ({
        sku: normalizeText(item.sku, 60),
        nome: normalizeText(item.nome, 180),
        quantidade: asInt(item.quantidade)
      })).filter((item) => item.sku && item.quantidade > 0);
      if (!items.length) return send(res, 400, { error: "Adicione ao menos um produto para salvar o rascunho." }), true;

      await tx(async (client) => {
        await client.query(
          `INSERT INTO pedido_rascunhos (pdv_id, solicitante, observacao, items, atualizado_em)
           VALUES ($1, $2, $3, $4::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (pdv_id) DO UPDATE
           SET solicitante = EXCLUDED.solicitante,
               observacao = EXCLUDED.observacao,
               items = EXCLUDED.items,
               atualizado_em = CURRENT_TIMESTAMP`,
          [user.pdvId, solicitante, observacao, JSON.stringify(items)]
        );
      });
      return send(res, 200, { ok: true, total: items.length }), true;
    }

    if (method === "DELETE") {
      await query("DELETE FROM pedido_rascunhos WHERE pdv_id = $1", [user.pdvId]);
      return send(res, 200, { ok: true }), true;
    }
  }

  // Cria um novo pedido do PDV; protegido por chave de idempotência contra duplo envio
  if (url.pathname === "/api/pdv/order" && method === "POST") {
    if (user.role !== "pdv") return send(res, 403, { error: "Entre como PDV para solicitar produtos." }), true;
    const body = await readBody(req);
    const idempotencyKey = normalizeIdempotencyKey(req, body);
    const solicitante = normalizeText(body.solicitante, 80).toUpperCase();
    const observacao = normalizeText(body.observacao, 500);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!idempotencyKey) return send(res, 400, { error: "Identificador da operação ausente. Atualize a página e tente novamente." }), true;
    if (!solicitante || !items.length) return send(res, 400, { error: "Informe solicitante e ao menos um item." }), true;
    await ensurePedidoIdempotencyTable();

    const result = await tx(async (client) => {
      // Reserva a chave de idempotência; se já existir, reaproveita o pedido já criado (sem duplicar)
      const insertedKey = await client.query(
        `INSERT INTO pedido_idempotencia (idempotency_key, pdv_id, status)
         VALUES ($1, $2, 'processing')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [idempotencyKey, user.pdvId]
      );
      if (!insertedKey.rowCount) {
        const existing = await client.query(
          `SELECT codigo_pedido, status
           FROM pedido_idempotencia
           WHERE idempotency_key = $1 AND pdv_id = $2
           FOR UPDATE`,
          [idempotencyKey, user.pdvId]
        );
        if (existing.rows[0]?.codigo_pedido) {
          return { codigo: existing.rows[0].codigo_pedido, repeated: true };
        }
        const error = new Error("Esta solicitação já está em processamento. Aguarde a confirmação.");
        error.statusCode = 409;
        throw error;
      }

      const orderCode = code("PED");
      for (const item of items) {
        const sku = normalizeText(item.sku, 60);
        const qty = asInt(item.quantidade);
        if (!sku || qty <= 0) {
          const error = new Error("Item inválido.");
          error.statusCode = 400;
          throw error;
        }

        const allowed = await client.query(
          `SELECT e.quantidade, e.estoque_maximo
           FROM estoque_pdv e
           JOIN produtos p ON p.sku = e.sku_produto
           JOIN produto_categorias prc ON prc.sku_produto = p.sku
           JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
           WHERE e.pdv_id = $1 AND e.sku_produto = $2 AND e.permitido = TRUE`,
          [user.pdvId, sku]
        );
        if (!allowed.rows[0]) {
          const error = new Error("Produto não liberado para este PDV.");
          error.statusCode = 400;
          throw error;
        }

        // O PDV pode pedir por embalagem (fardo, caixa); o banco guarda SEMPRE em unidade.
        // A multiplicação acontece aqui, na criação do item, e nunca depois — se o número
        // gravado fosse às vezes embalagem e às vezes unidade, nenhuma tela, relatório ou
        // transferência saberia qual dos dois está lendo.
        const conversao = await converterQuantidadeDoPedido(client, {
          sku,
          quantidade: qty,
          unidadeMedida: item.unidade_medida
        });

        await client.query(
          `INSERT INTO pedidos
            (codigo_pedido, solicitante, sku_produto, pdv_id, quantidade_solicitada, observacao)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [orderCode, solicitante, sku, user.pdvId, conversao.unidades, observacao]
        );
      }
      await client.query(
        `UPDATE pedido_idempotencia
         SET codigo_pedido = $2, status = 'completed', atualizado_em = CURRENT_TIMESTAMP
         WHERE idempotency_key = $1 AND pdv_id = $3`,
        [idempotencyKey, orderCode, user.pdvId]
      );
      await client.query("DELETE FROM pedido_rascunhos WHERE pdv_id = $1", [user.pdvId]);
      const pdvRows = await client.query("SELECT nome FROM pdvs WHERE id = $1", [user.pdvId]);
      return {
        codigo: orderCode,
        repeated: false,
        alert: {
          orderId: orderCode,
          orderNumber: orderCode,
          pointId: user.pdvId,
          pointName: pdvRows.rows[0]?.nome || user.name || "PDV",
          itemCount: items.length,
          createdAt: new Date().toISOString(),
          origin: "PDV"
        }
      };
    });
    if (!result.repeated && result.alert) {
      publishOrderAlert("NEW_PENDING_ORDER", result.alert);
    }
    send(res, result.repeated ? 200 : 201, { ok: true, codigo: result.codigo, repeated: result.repeated });
    return true;
  }

  // Histórico de pedidos do PDV logado (ou de um PDV específico, quando consultado pelo admin)
  if (url.pathname === "/api/pdv/orders") {
    await ensurePedidoEditColumns();
    const pdvId = user.role === "pdv" ? user.pdvId : asInt(url.searchParams.get("pdvId"));
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = await query(
      `SELECT p.codigo_pedido, p.data_hora, pr.nome AS produto, pr.qtd_total AS estoque_central, p.quantidade_solicitada,
              p.quantidade_liberada,
              COALESCE(p.item_origem, 'PDV') AS item_origem,
              CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') THEN 'Aguardando Retirada'
                ELSE p.status
              END AS status,
              p.observacao, p.em_andamento_em, p.liberado_em, p.pronto_retirada_em,
              p.retirada_assinatura, p.retirada_responsavel, p.retirada_observacao,
              p.retirada_em, p.retirada_usuario_almoxarifado,
              COALESCE(p.pedido_editado, FALSE) AS pedido_editado, p.pedido_editado_em, p.pedido_editado_por,
              COALESCE(p.pedido_reaberto_finalizado, FALSE) AS pedido_reaberto_finalizado
       FROM pedidos p
       JOIN produtos pr ON pr.sku = p.sku_produto
       WHERE p.pdv_id = $1 AND ($2::date IS NULL OR p.data_hora::date >= $2::date)
         AND ($3::date IS NULL OR p.data_hora::date <= $3::date)
       ORDER BY p.data_hora ASC, p.id ASC`,
      [pdvId, from || null, to || null]
    );
    send(res, 200, { orders: rows });
    return true;
  }

  // Movimentação do quadro Kanban de liberação: troca livre entre os status ativos, com
  // checagem de concorrência otimista (version) e registro em auditoria
  if (url.pathname === "/api/admin/orders/status" && method === "PATCH") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const expectedStatusValue = statusFromRequest(body.expected_status);
    const nextStatusValue = statusFromRequest(body.status);
    const expectedStatus = orderStatuses.includes(expectedStatusValue) ? expectedStatusValue : "";
    const nextStatus = orderStatuses.includes(nextStatusValue) ? nextStatusValue : "";
    const expectedVersion = asInt(body.version);
    const kanbanStatuses = new Set(["Pendente", "Em Andamento", "Aguardando Retirada"]);
    // Qualquer status ativo pode ir para qualquer outro status ativo (sem sequência fixa)
    const allowedTransitions = Object.fromEntries(
      [...kanbanStatuses].map((status) => [
        status,
        [...kanbanStatuses].filter((nextStatus) => nextStatus !== status)
      ])
    );
    if (!orderCode || !expectedStatus || !nextStatus || !kanbanStatuses.has(expectedStatus) || !kanbanStatuses.has(nextStatus)) {
      return send(res, 400, { error: "Status ou pedido inválido." }), true;
    }
    if (!allowedTransitions[expectedStatus]?.includes(nextStatus)) {
      return send(res, 422, { error: "Movimentação de status não permitida." }), true;
    }
    await ensurePedidoAuditTable();

    const result = await tx(async (client) => {
      const rows = await client.query(
        `SELECT id, status, version
         FROM pedidos
         WHERE codigo_pedido = $1
         ORDER BY id
         FOR UPDATE`,
        [orderCode]
      );
      if (!rows.rows.length) {
        const error = new Error("Pedido não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const normalized = rows.rows.map((row) => ({ ...row, normalizedStatus: normalizeOrderStatus(row.status) }));
      const targetRows = normalized.filter((row) => row.normalizedStatus === expectedStatus);
      if (!targetRows.length) {
        // Outro usuário já moveu o pedido para um status diferente do esperado pela tela
        const error = new Error("Este pedido foi modificado por outro usuário.");
        error.statusCode = 409;
        error.details = { statuses: [...new Set(normalized.map((row) => row.normalizedStatus))] };
        throw error;
      }
      const currentVersion = Math.max(1, ...targetRows.map((row) => asInt(row.version) || 1));
      if (expectedVersion && currentVersion !== expectedVersion) {
        // Concorrência otimista: versão divergente indica edição concorrente não sincronizada
        const error = new Error("Este pedido foi alterado por outro usuário.");
        error.statusCode = 409;
        error.details = { currentVersion, expectedVersion };
        throw error;
      }
      const ids = targetRows.map((row) => row.id);
      const brasiliaNow = "CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo'";
      // Ajusta datas e quantidade liberada conforme o status de destino. Arrastar o card para
      // Aguardando Retirada equivale a liberar tudo o que foi solicitado (sem isso o pedido
      // chegava na coluna com quantidade zerada e a retirada ficava impossível de confirmar).
      // Voltar o card para Em Andamento preserva a quantidade liberada (o almoxarifado pode ter
      // editado esse valor manualmente; voltar de etapa não deve descartar essa edição), só limpa
      // as datas da etapa abandonada.
      const timeField = nextStatus === "Em Andamento"
        ? `, em_andamento_em = ${brasiliaNow}, liberado_em = NULL, pronto_retirada_em = NULL, release_mode = NULL`
        : nextStatus === "Aguardando Retirada"
          ? `, liberado_em = ${brasiliaNow}, pronto_retirada_em = ${brasiliaNow},
             quantidade_liberada = CASE
               WHEN COALESCE(quantidade_liberada, 0) > 0 THEN LEAST(quantidade_liberada, quantidade_solicitada)
               ELSE quantidade_solicitada
             END`
          : `, em_andamento_em = NULL, quantidade_liberada = 0, liberado_em = NULL, pronto_retirada_em = NULL, release_mode = NULL`;
      const updated = await client.query(
        `UPDATE pedidos
         SET status = $1,
             updated_at = ${brasiliaNow},
             version = COALESCE(version, 1) + 1
             ${timeField}
         WHERE id = ANY($2::int[])
         RETURNING id, codigo_pedido, status, quantidade_liberada, updated_at`,
        [nextStatus, ids]
      );
      // Registra a movimentação de status no log de auditoria administrativa
      await registrarAuditoriaStatus(client, {
        codigoPedido: orderCode,
        acao: "status_alterado_kanban",
        usuario: user.name || user.role || "Almoxarifado",
        de: expectedStatus,
        para: nextStatus,
        dados: { origem: "kanban", total_itens: updated.rows.length, ids }
      });
      // Informa quanto foi liberado para a tela poder avisar o usuário no Kanban
      const totalLiberado = updated.rows.reduce((soma, row) => soma + asInt(row.quantidade_liberada), 0);
      return {
        total: updated.rows.length,
        status: nextStatus,
        previous_status: expectedStatus,
        quantidade_liberada: totalLiberado
      };
    });

    // Avisa PDV e Almoxarifado na hora; o polling de 12s segue como fallback
    publishOrderStatusChange({
      codigoPedido: orderCode,
      de: expectedStatus,
      para: nextStatus,
      usuario: user.name || "Almoxarifado",
      origem: "kanban"
    });
    send(res, 200, { ok: true, ...result });
    return true;
  }

  // Listagem administrativa de pedidos, e exclusão definitiva (com confirmação e justificativa)
  if (url.pathname === "/api/admin/orders") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    if (method === "DELETE") {
      await ensurePedidoAuditTable();
      const body = await readBody(req);
      const orderCode = normalizeText(body.codigo_pedido, 80);
      const confirmationCode = normalizeText(body.confirmation_code || body.confirmacao || "", 80);
      const justification = normalizeText(body.justificativa || body.motivo || "", 500);
      if (!orderCode) return send(res, 400, { error: "Pedido inválido." }), true;
      // Exige digitar o próprio código do pedido como confirmação, evitando exclusão acidental
      if (confirmationCode !== orderCode) return send(res, 400, { error: "Confirme o código do pedido para excluir." }), true;
      if (justification.length < 3) return send(res, 400, { error: "Informe uma justificativa para excluir o pedido." }), true;

      const deleted = await tx(async (client) => {
        const rows = await client.query(
          `SELECT id, status, quantidade_liberada, pdv_id, sku_produto,
                  retirada_assinatura, retirada_em, pronto_retirada_em, liberado_em,
                  COALESCE(item_origem, 'PDV') AS item_origem,
                  COALESCE(release_mode, '') AS release_mode
           FROM pedidos
           WHERE codigo_pedido = $1
           ORDER BY id
           FOR UPDATE`,
          [orderCode]
        );
        if (!rows.rows.length) {
          const error = new Error("Pedido não encontrado.");
          error.statusCode = 404;
          throw error;
        }
        const rowsToDelete = rows.rows;
        const normalizedStatuses = rowsToDelete.map((item) => normalizeOrderStatus(item.status));
        const allowedCleanStatuses = new Set(["Pendente", "Em Andamento"]);
        // Só permite exclusão definitiva de pedidos que ainda não avançaram no fluxo de liberação
        const blockedReasons = [];
        if (normalizedStatuses.some((status) => !allowedCleanStatuses.has(status))) {
          blockedReasons.push("status já avançado");
        }
        if (rowsToDelete.some((item) => asInt(item.quantidade_liberada) > 0)) {
          blockedReasons.push("quantidade liberada");
        }
        if (rowsToDelete.some((item) => item.retirada_assinatura || item.retirada_em || item.pronto_retirada_em || item.liberado_em)) {
          blockedReasons.push("retirada, assinatura ou liberação registrada");
        }
        if (rowsToDelete.some((item) => item.item_origem !== "PDV")) {
          blockedReasons.push("item incluído fora do pedido original do PDV");
        }
        if (rowsToDelete.some((item) => item.release_mode)) {
          blockedReasons.push("operação de liberação parcial em andamento");
        }

        // Bloqueia a exclusão se houver impressão em andamento para este pedido (tabelas opcionais)
        const printTables = await client.query(`
          SELECT table_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('print_jobs', 'impressao_jobs')
            AND column_name IN ('codigo_pedido', 'status')
          GROUP BY table_name
          HAVING COUNT(DISTINCT column_name) = 2
        `);
        const printTableNames = new Set(printTables.rows.map((row) => row.table_name));
        if (printTableNames.has("print_jobs")) {
          const printRows = await client.query(
            `SELECT COUNT(*)::int AS total
             FROM print_jobs
             WHERE codigo_pedido = $1
               AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'pendente', 'processando')`,
            [orderCode]
          );
          if (asInt(printRows.rows[0]?.total) > 0) blockedReasons.push("impressão em processamento");
        }
        if (printTableNames.has("impressao_jobs")) {
          const printRows = await client.query(
            `SELECT COUNT(*)::int AS total
             FROM impressao_jobs
             WHERE codigo_pedido = $1
               AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'pendente', 'processando')`,
            [orderCode]
          );
          if (asInt(printRows.rows[0]?.total) > 0) blockedReasons.push("impressão em processamento");
        }

        // Qualquer motivo acumulado impede a exclusão definitiva
        if (blockedReasons.length) {
          const error = new Error(`Exclusão bloqueada: ${[...new Set(blockedReasons)].join(", ")}.`);
          error.statusCode = 409;
          throw error;
        }

        const result = await client.query("DELETE FROM pedidos WHERE codigo_pedido = $1 RETURNING id", [orderCode]);
        await client.query(
          `INSERT INTO pedido_auditoria (codigo_pedido, acao, usuario, observacao, dados)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            orderCode,
            "pedido_excluido_definitivamente",
            user.name || user.role || "Almoxarifado",
            justification,
            JSON.stringify({
              total_itens: result.rows.length,
              status: [...new Set(normalizedStatuses)],
              ids: result.rows.map((item) => item.id)
            })
          ]
        );
        return result.rows;
      });

      send(res, 200, { ok: true, total: deleted.length });
      return true;
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const pdvId = asInt(url.searchParams.get("pdvId"));
    const q = normalizeText(url.searchParams.get("q"), 80);
    const activeOnly = url.searchParams.get("active") === "1";
    const statusParam = normalizeText(url.searchParams.get("status"), 40);
    const allowedStatus = orderStatuses.includes(statusParam) ? statusParam : "";
    const limit = Math.min(Math.max(asInt(url.searchParams.get("limit")) || 300, 1), 500);
    const offset = Math.min(Math.max(asInt(url.searchParams.get("offset")) || 0, 0), 10000);
    const rows = await query(
      `SELECT p.id, p.codigo_pedido, p.pdv_id, pd.nome AS pdv, p.solicitante, p.sku_produto, pr.nome AS produto,
              p.quantidade_solicitada, p.quantidade_liberada,
              COALESCE(p.item_origem, 'PDV') AS item_origem,
              CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') THEN 'Aguardando Retirada'
                ELSE p.status
              END AS status,
              p.observacao,
              pr.qtd_total AS estoque_central, pr.qtd_total AS saldo, COALESCE(e.quantidade, 0) AS estoque_pdv, e.estoque_minimo, e.estoque_maximo, p.criado_em, p.em_andamento_em, p.liberado_em,
              p.pronto_retirada_em, p.retirada_assinatura, p.retirada_responsavel,
              p.retirada_observacao, p.retirada_em, p.retirada_usuario_almoxarifado,
              p.version, p.updated_at,
              COALESCE(p.pedido_editado, FALSE) AS pedido_editado, p.pedido_editado_em, p.pedido_editado_por,
              COALESCE(p.pedido_reaberto_finalizado, FALSE) AS pedido_reaberto_finalizado
       FROM pedidos p
       JOIN pdvs pd ON pd.id = p.pdv_id
       JOIN produtos pr ON pr.sku = p.sku_produto
       LEFT JOIN estoque_pdv e ON e.pdv_id = p.pdv_id AND e.sku_produto = p.sku_produto
       WHERE ($1::date IS NULL OR p.criado_em::date >= $1::date)
         AND ($2::date IS NULL OR p.criado_em::date <= $2::date)
         AND ($3::int = 0 OR p.pdv_id = $3)
         AND ($4::text IS NULL OR p.codigo_pedido ILIKE '%' || $4::text || '%')
         AND ($5::boolean = FALSE OR CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') THEN 'Aguardando Retirada'
                ELSE p.status
              END IN ('Pendente', 'Em Andamento', 'Aguardando Retirada'))
         AND ($6::text IS NULL OR CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') THEN 'Aguardando Retirada'
                ELSE p.status
              END = $6)
       ORDER BY p.criado_em DESC, p.id DESC
       LIMIT $7 OFFSET $8`,
      [from || null, to || null, pdvId, q || null, activeOnly, allowedStatus || null, limit, offset]
    );
    send(res, 200, { orders: rows, limit, offset, hasMore: rows.length === limit });
    return true;
  }

  // Admin inclui produto(s) extra em um pedido já Em Andamento (fora do pedido original do PDV)
  if ((url.pathname === "/api/admin/orders/add-item" || url.pathname === "/api/admin/orders/add-items") && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const orderCode = normalizeText(body.codigo_pedido || body.pedidoId || body.pedido_id, 80);
    const rawItems = Array.isArray(body.items)
      ? body.items
      : [{
          sku_produto: body.sku_produto || body.sku,
          quantidade_solicitada: body.quantidade_solicitada || body.quantidade
        }];
    const items = rawItems.map((item) => ({
      sku: normalizeText(item.sku_produto || item.sku, 60),
      quantidade: asInt(item.quantidade_solicitada || item.quantidade)
    })).filter((item) => item.sku && item.quantidade > 0);
    const uniqueSkus = new Set(items.map((item) => item.sku));
    if (!orderCode || !items.length) return send(res, 400, { error: "Informe o pedido e os produtos que serão adicionados." }), true;
    if (uniqueSkus.size !== items.length) return send(res, 400, { error: "Remova produtos duplicados antes de adicionar ao pedido." }), true;

    const added = await tx(async (client) => {
      const orderRows = await client.query(
        `SELECT codigo_pedido, solicitante, pdv_id, observacao, status
         FROM pedidos
         WHERE codigo_pedido = $1
         ORDER BY id
         FOR UPDATE`,
        [orderCode]
      );
      if (!orderRows.rows.length) {
        const error = new Error("Pedido não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const order = orderRows.rows[0];
      const statuses = new Set(orderRows.rows.map((row) => normalizeOrderStatus(row.status)));
      // Todos os itens do pedido precisam estar Em Andamento antes de adicionar novos produtos
      if (!statuses.has("Em Andamento") || statuses.size !== 1) {
        const error = new Error("Produtos só podem ser adicionados quando o pedido está Em andamento.");
        error.statusCode = 400;
        throw error;
      }

      const existing = await client.query(
        `SELECT sku_produto
         FROM pedidos
         WHERE codigo_pedido = $1
           AND sku_produto = ANY($2::text[])`,
        [orderCode, [...uniqueSkus]]
      );
      if (existing.rows.length) {
        const error = new Error("Este produto já existe no pedido.");
        error.statusCode = 400;
        throw error;
      }

      const products = await client.query(
        `SELECT sku
         FROM produtos
         WHERE sku = ANY($1::text[])
           AND ativo IS NOT FALSE`,
        [[...uniqueSkus]]
      );
      const foundSkus = new Set(products.rows.map((row) => row.sku));
      const missing = [...uniqueSkus].filter((sku) => !foundSkus.has(sku));
      if (missing.length) {
        const error = new Error(`Produto ${missing[0]} não encontrado ou inativo.`);
        error.statusCode = 404;
        throw error;
      }

      const inserted = [];
      // item_origem = 'ALMOX' marca que o produto foi incluído pelo almoxarifado, não pelo PDV
      for (const item of items) {
        const result = await client.query(
          `INSERT INTO pedidos
             (codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada,
              status, observacao, data_hora, criado_em, em_andamento_em,
              pedido_editado, pedido_editado_em, pedido_editado_por, version, updated_at, item_origem)
           VALUES ($1, $2, $3, $4, $5, 0,
                   'Em Andamento', $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                   TRUE, CURRENT_TIMESTAMP, $7, 1, CURRENT_TIMESTAMP, 'ALMOX')
           RETURNING id, codigo_pedido, sku_produto, quantidade_solicitada, item_origem`,
          [
            order.codigo_pedido,
            order.solicitante,
            order.pdv_id,
            item.sku,
            (
              await converterQuantidadeDoPedido(client, {
                sku: item.sku,
                quantidade: item.quantidade,
                unidadeMedida: item.unidade_medida
              })
            ).unidades,
            order.observacao,
            user.name || "Almoxarifado"
          ]
        );
        inserted.push(result.rows[0]);
      }

      await client.query(
        `UPDATE pedidos
         SET pedido_editado = TRUE,
             pedido_editado_em = CURRENT_TIMESTAMP,
             pedido_editado_por = $2,
             updated_at = CURRENT_TIMESTAMP,
             version = COALESCE(version, 1) + 1
         WHERE codigo_pedido = $1`,
        [orderCode, user.name || "Almoxarifado"]
      );
      return inserted;
    });

    return send(res, 200, { ok: true, items: added, total: added.length }), true;
  }

  // Remove um único item de um pedido (apenas enquanto Em Andamento)
  if (url.pathname === "/api/admin/order-item" && method === "DELETE") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const id = asInt(body.id);
    if (!id) return send(res, 400, { error: "Produto inválido." }), true;

    const deleted = await tx(async (client) => {
      const row = await client.query(
        `SELECT id, codigo_pedido, status, quantidade_liberada, sku_produto
         FROM pedidos
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      const item = row.rows[0];
      if (!item) return null;

      const currentStatus = normalizeOrderStatus(item.status);
      if (currentStatus !== "Em Andamento") {
        const error = new Error("Este produto só pode ser excluído em Em andamento.");
        error.statusCode = 400;
        throw error;
      }

      const result = await client.query("DELETE FROM pedidos WHERE id = $1 RETURNING id, codigo_pedido", [id]);
      await client.query(
        `UPDATE pedidos
         SET pedido_editado = TRUE,
             pedido_editado_em = NOW(),
             pedido_editado_por = 'Almoxarifado',
             updated_at = NOW(),
             version = COALESCE(version, 1) + 1
         WHERE codigo_pedido = $1`,
        [item.codigo_pedido]
      );
      return result.rows[0] || null;
    });

    if (!deleted) return send(res, 404, { error: "Produto não encontrado no pedido." }), true;
    send(res, 200, { ok: true, item: deleted });
    return true;
  }

  // Remove vários itens de um pedido de uma vez, validando versão de cada item (edição concorrente)
  if (url.pathname === "/api/admin/order-items" && method === "DELETE") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const requestStatus = orderStatuses.includes(body.status) ? body.status : "";
    const requestedItems = Array.isArray(body.items) ? body.items : [];
    const ids = [...new Set(requestedItems.map((item) => asInt(item.id)).filter(Boolean))];
    const versionsById = new Map(requestedItems.map((item) => [asInt(item.id), asInt(item.version)]));
    if (!orderCode || !ids.length) return send(res, 400, { error: "Informe os produtos que devem ser excluídos." }), true;

    const result = await tx(async (client) => {
      const rows = await client.query(
        `SELECT id, codigo_pedido, status, quantidade_liberada, sku_produto, version
         FROM pedidos
         WHERE id = ANY($1::int[])
         FOR UPDATE`,
        [ids]
      );
      if (rows.rows.length !== ids.length) {
        const error = new Error("Pedido alterado por outro usuário. Atualize a tela antes de excluir.");
        error.statusCode = 409;
        throw error;
      }

      for (const item of rows.rows) {
        const currentStatus = normalizeOrderStatus(item.status);
        if (item.codigo_pedido !== orderCode) {
          const error = new Error("Os produtos selecionados não pertencem ao mesmo pedido.");
          error.statusCode = 400;
          throw error;
        }
        if (requestStatus && currentStatus !== requestStatus) {
          const error = new Error("Pedido alterado por outro usuário. Atualize a tela antes de excluir.");
          error.statusCode = 409;
          throw error;
        }
        if (currentStatus !== "Em Andamento") {
          const error = new Error("Produtos só podem ser excluídos em Em andamento.");
          error.statusCode = 400;
          throw error;
        }
        // Concorrência otimista: rejeita se a versão do item mudou desde que a tela foi carregada
        const expectedVersion = versionsById.get(asInt(item.id));
        if (expectedVersion > 0 && asInt(item.version) !== expectedVersion) {
          const error = new Error("Conflito de edição detectado. Atualize o pedido antes de excluir.");
          error.statusCode = 409;
          throw error;
        }
      }

      const deleted = await client.query(
        `DELETE FROM pedidos
         WHERE id = ANY($1::int[])
         RETURNING id, codigo_pedido, sku_produto, quantidade_solicitada`,
        [ids]
      );

      const remaining = await client.query("SELECT COUNT(*)::int AS total FROM pedidos WHERE codigo_pedido = $1", [orderCode]);
      if (asInt(remaining.rows[0]?.total) > 0) {
        await client.query(
          `UPDATE pedidos
           SET pedido_editado = TRUE,
               pedido_editado_em = NOW(),
               pedido_editado_por = $2,
               updated_at = NOW(),
               version = COALESCE(version, 1) + 1
           WHERE codigo_pedido = $1`,
          [orderCode, user.name || "Almoxarifado"]
        );
      }

      return {
        deleted: deleted.rows,
        orderDeleted: asInt(remaining.rows[0]?.total) === 0
      };
    });

    send(res, 200, { ok: true, deleted: result.deleted, orderDeleted: result.orderDeleted });
    return true;
  }

  // Movimenta itens de um pedido entre status (usado pela tela de controle do pedido, não pelo Kanban)
  if (url.pathname === "/api/admin/order-flow" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const body = await readBody(req);
    const nextStatus = orderStatuses.includes(body.status) ? body.status : null;
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const currentStatusFilter = orderStatuses.includes(body.current_status) ? body.current_status : "";
    const releaseMode = body.release_mode === "entered-only" ? "entered-only" : "";
    let items = Array.isArray(body.items) ? body.items : [];
    if (!nextStatus || (!items.length && !orderCode)) return send(res, 400, { error: "Status ou itens inválidos." }), true;
    if (nextStatus === "Finalizado") return send(res, 400, { error: "Finalize o pedido pela confirmação de retirada com assinatura." }), true;
    // Itens liberados acima do solicitado: permitido, mas devolvido à tela para aviso
    const excedentes = [];
    await ensurePedidoAuditTable();

    await tx(async (client) => {
      // Reabrir todo o pedido para Em Andamento: reverte itens finalizados e reagrupa itens
      // duplicados do mesmo produto/PDV em uma única linha antes de reabrir
      if (orderCode && nextStatus === "Em Andamento") {
        const orderItems = await client.query(
          `SELECT id, status, quantidade_solicitada, quantidade_liberada, pdv_id, sku_produto, version
           FROM pedidos
           WHERE codigo_pedido = $1
           ORDER BY id
           FOR UPDATE`,
          [orderCode]
        );
        if (!orderItems.rows.length) {
          const error = new Error("Status ou itens inválidos.");
          error.statusCode = 400;
          throw error;
        }
        for (const current of orderItems.rows) {
          const currentStatus = normalizeOrderStatus(current.status);
          const allowedTransitions = {
            Pendente: ["Em Andamento"],
            "Em Andamento": ["Pendente", "Aguardando Retirada"],
            "Aguardando Retirada": ["Pendente", "Em Andamento"],
            "Liberação Parcial": ["Pendente", "Em Andamento", "Aguardando Retirada"],
            Finalizado: ["Em Andamento"]
          };
          if (currentStatus !== nextStatus && !allowedTransitions[currentStatus]?.includes(nextStatus)) {
            const error = new Error("Movimentação de status não permitida. Envie o pedido para Em andamento antes de editar.");
            error.statusCode = 400;
            throw error;
          }
          if (currentStatus === "Finalizado") {
            // Reabrir um item já finalizado estorna a baixa: devolve ao estoque central e retira do PDV
            const oldQty = asInt(current.quantidade_liberada);
            await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [oldQty, current.sku_produto]);
            await client.query(
              "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
              [oldQty, current.pdv_id, current.sku_produto]
            );
            // A OMIE precisa receber o movimento inverso: sem isso ela segue achando que a
            // mercadoria está no PDV e os dois sistemas divergem em silêncio.
            await registrarCompensacaoDaReabertura(client, {
              codigoPedido: orderCode,
              itens: [{ pedidoItemId: current.id, sku: current.sku_produto, pdvId: current.pdv_id, quantidade: oldQty }]
            });
          }
        }

        // Agrupa itens duplicados (mesmo pdv+sku) para consolidar em uma única linha ao reabrir
        const groups = new Map();
        for (const row of orderItems.rows) {
          const key = `${row.pdv_id}::${row.sku_produto}`;
          const group = groups.get(key) || {
            keepId: row.id,
            ids: [],
            pdvId: row.pdv_id,
            sku: row.sku_produto,
            releasedTotal: 0,
            pendingTotal: 0,
            maxPending: 0,
            maxRequested: 0
          };
          group.ids.push(row.id);
          group.keepId = Math.min(group.keepId, row.id);
          const requestedQty = asInt(row.quantidade_solicitada);
          const releasedQty = asInt(row.quantidade_liberada);
          group.maxRequested = Math.max(group.maxRequested, requestedQty);
          if (releasedQty > 0) group.releasedTotal += releasedQty;
          else {
            group.pendingTotal += requestedQty;
            group.maxPending = Math.max(group.maxPending, requestedQty);
          }
          groups.set(key, group);
        }

        for (const group of groups.values()) {
          const pendingQty = group.maxPending || group.pendingTotal;
          const requestedQty = group.pendingTotal > 0
            ? Math.max(group.maxRequested, group.releasedTotal + pendingQty)
            : group.maxRequested;
          await client.query(
            `UPDATE pedidos
             SET status = 'Em Andamento',
                 quantidade_solicitada = $2,
                 quantidade_liberada = $4,
                 em_andamento_em = CURRENT_TIMESTAMP,
                 liberado_em = NULL,
                 pronto_retirada_em = NULL,
                 pedido_editado = TRUE,
                 pedido_editado_em = CURRENT_TIMESTAMP,
                 pedido_editado_por = $3,
                 pedido_reaberto_finalizado = TRUE,
                 retirada_assinatura = NULL,
                 retirada_responsavel = NULL,
             retirada_observacao = NULL,
             retirada_em = NULL,
             retirada_usuario_almoxarifado = NULL,
             release_mode = NULL,
             version = COALESCE(version, 1) + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
            // Preserva a quantidade já liberada (ex: ao voltar de Aguardando Retirada) em vez de
            // zerar — o almoxarifado não deve perder a edição que já tinha feito
            [group.keepId, requestedQty, user.name || "Almoxarifado", group.releasedTotal]
          );
          const duplicateIds = group.ids.filter((id) => id !== group.keepId);
          if (duplicateIds.length) {
            await client.query("DELETE FROM pedidos WHERE id = ANY($1::int[])", [duplicateIds]);
          }
        }
        return;
      }
      // Mover o pedido inteiro (todos os itens de um status) para Em Andamento ou Pendente
      if (orderCode && ["Em Andamento", "Pendente"].includes(nextStatus)) {
        const orderItems = await client.query(
          `SELECT id, version
           FROM pedidos
           WHERE codigo_pedido = $1
             AND ($2::text = '' OR CASE
               WHEN status = 'Liberado' THEN 'Finalizado'
               WHEN status IN ('Liberado Parcial', 'Liberação Parcial') THEN 'Aguardando Retirada'
               ELSE status
             END = $2)
           ORDER BY id
           FOR UPDATE`,
          [orderCode, currentStatusFilter]
        );
        items = orderItems.rows.map((row) => ({
          id: row.id,
          version: row.version,
          quantidade_liberada: 0,
          remover: false
        }));
      }
      if (!items.length) {
        const error = new Error("Status ou itens inválidos.");
        error.statusCode = 400;
        throw error;
      }
      // Aplica a transição item a item, respeitando as transições permitidas e a versão esperada
      let changedItems = 0;
      for (const item of items) {
        const old = await client.query("SELECT codigo_pedido, status, quantidade_solicitada, quantidade_liberada, pdv_id, sku_produto, version FROM pedidos WHERE id = $1", [asInt(item.id)]);
        if (!old.rows[0]) continue;
        const current = old.rows[0];
        const currentStatus = normalizeOrderStatus(current.status);
        const allowedTransitions = {
          Pendente: ["Em Andamento"],
          "Em Andamento": ["Pendente", "Aguardando Retirada"],
          "Aguardando Retirada": ["Pendente", "Em Andamento"],
          "Liberação Parcial": ["Pendente", "Em Andamento", "Aguardando Retirada"],
          Finalizado: ["Em Andamento"]
        };
        // Item já no status de destino é um no-op (ex: pedido com itens em status misto, onde
        // parte já está em Aguardando Retirada e o restante ainda em Em Andamento — reenviar o
        // pedido inteiro não pode travar por causa dos itens que já chegaram lá)
        if (currentStatus !== nextStatus && !allowedTransitions[currentStatus]?.includes(nextStatus)) {
          const error = new Error("Movimentação de status não permitida. Envie o pedido para Em andamento antes de editar.");
          error.statusCode = 400;
          throw error;
        }
        const leavesFinalized = currentStatus === "Finalizado" && nextStatus !== "Finalizado";
        // Concorrência otimista: rejeita se a versão enviada pela tela estiver desatualizada
        const expectedVersion = asInt(item.version);
        if (expectedVersion > 0 && asInt(current.version) !== expectedVersion) {
          const error = new Error("Conflito de edição detectado. Atualize o pedido antes de salvar.");
          error.statusCode = 409;
          throw error;
        }
        // Remoção do item embutida na mesma chamada de fluxo
        if (item.remover) {
          if (currentStatus !== "Em Andamento") {
            const error = new Error("Só é possível remover produtos quando o pedido está Em andamento.");
            error.statusCode = 400;
            throw error;
          }
          if (currentStatus === "Finalizado") {
            const oldQty = asInt(current.quantidade_liberada);
            await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [oldQty, current.sku_produto]);
            await client.query(
              "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
              [oldQty, current.pdv_id, current.sku_produto]
            );
          }
          await client.query("DELETE FROM pedidos WHERE id = $1", [asInt(item.id)]);
          continue;
        }
        const requestedQty = asInt(current.quantidade_solicitada);
        let qty = asInt(current.quantidade_liberada);
        // "entered-only" libera exatamente o valor digitado; caso contrário, libera o total solicitado
        // quando nada foi digitado explicitamente. Cobre também o item que já estava em Aguardando
        // Retirada (self-transition): sem isso, reenviar o pedido ignorava a edição feita na tela
        // para os itens que já tinham chegado lá antes (pedido com itens em status misto).
        if (nextStatus === "Aguardando Retirada") {
          const requestedReleaseQty = asInt(item.quantidade_liberada);
          qty = releaseMode === "entered-only"
            ? requestedReleaseQty
            : requestedReleaseQty > 0 ? requestedReleaseQty : requestedQty;
        } else if (nextStatus === "Pendente") {
          // Só até Pendente zera: nesse ponto nada foi decidido ainda. Voltar para Em Andamento
          // preserva o valor atual de "qty" (já lido de current.quantidade_liberada acima).
          qty = 0;
        }
        if (qty < 0) {
          const error = new Error("A quantidade liberada não pode ser negativa.");
          error.statusCode = 400;
          throw error;
        }
        // O almoxarifado pode liberar acima do solicitado; a diferença é registrada para auditoria
        if (qty > requestedQty) {
          excedentes.push({ id: asInt(item.id), sku: current.sku_produto, solicitada: requestedQty, liberada: qty });
        }
        if (releaseMode === "entered-only" && nextStatus === "Aguardando Retirada" && qty <= 0) {
          continue;
        }
        const itemStatus = nextStatus;

        // Voltar de etapa limpa as datas da etapa abandonada, para o pedido não exibir
        // "liberado em" depois de retornar para separação ou para pendente
        const timeField = itemStatus === "Em Andamento"
          ? ", em_andamento_em = CURRENT_TIMESTAMP, liberado_em = NULL, pronto_retirada_em = NULL"
          : itemStatus === "Aguardando Retirada"
            ? ", liberado_em = CURRENT_TIMESTAMP, pronto_retirada_em = CURRENT_TIMESTAMP"
            : ", em_andamento_em = NULL, liberado_em = NULL, pronto_retirada_em = NULL";
        await client.query(
          `UPDATE pedidos
           SET status = $1,
               quantidade_liberada = $2,
               pedido_editado = COALESCE(pedido_editado, FALSE) OR $4::boolean,
               pedido_editado_em = CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE pedido_editado_em END,
               pedido_editado_por = CASE WHEN $4::boolean THEN $5 ELSE pedido_editado_por END,
               pedido_reaberto_finalizado = COALESCE(pedido_reaberto_finalizado, FALSE) OR $4::boolean,
               retirada_assinatura = CASE WHEN $4::boolean THEN NULL ELSE retirada_assinatura END,
               retirada_responsavel = CASE WHEN $4::boolean THEN NULL ELSE retirada_responsavel END,
               retirada_observacao = CASE WHEN $4::boolean THEN NULL ELSE retirada_observacao END,
               retirada_em = CASE WHEN $4::boolean THEN NULL ELSE retirada_em END,
               retirada_usuario_almoxarifado = CASE WHEN $4::boolean THEN NULL ELSE retirada_usuario_almoxarifado END,
               release_mode = $6,
               version = COALESCE(version, 1) + 1,
               updated_at = CURRENT_TIMESTAMP
               ${timeField}
           WHERE id = $3`,
          [
            itemStatus,
            qty,
            asInt(item.id),
            leavesFinalized,
            user.name || "Almoxarifado",
            itemStatus === "Aguardando Retirada" && releaseMode === "entered-only" ? "entered-only" : null
          ]
        );
        // Se já existe outro item do mesmo produto aguardando retirada, mescla as quantidades
        // em uma única linha em vez de manter duas liberações separadas
        if (itemStatus === "Aguardando Retirada") {
          const existing = await client.query(
            `SELECT id
             FROM pedidos
             WHERE codigo_pedido = $1
               AND sku_produto = $2
               AND status = 'Aguardando Retirada'
               AND id <> $3
             ORDER BY id
             LIMIT 1
             FOR UPDATE`,
            [current.codigo_pedido || orderCode, current.sku_produto, asInt(item.id)]
          );
          const keep = existing.rows[0];
          if (keep) {
            await client.query(
              `UPDATE pedidos
               SET quantidade_liberada = COALESCE(quantidade_liberada, 0) + $2,
                   quantidade_solicitada = GREATEST(quantidade_solicitada, COALESCE(quantidade_liberada, 0) + $2),
                   pedido_editado = TRUE,
                   pedido_editado_em = CURRENT_TIMESTAMP,
                   pedido_editado_por = $3,
                   retirada_assinatura = NULL,
                   retirada_responsavel = NULL,
                   retirada_observacao = NULL,
                   retirada_em = NULL,
                   retirada_usuario_almoxarifado = NULL,
                   release_mode = COALESCE(release_mode, $4),
                   version = COALESCE(version, 1) + 1,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [
                keep.id,
                qty,
                user.name || "Almoxarifado",
                releaseMode === "entered-only" ? "entered-only" : null
              ]
            );
            await client.query("DELETE FROM pedidos WHERE id = $1", [asInt(item.id)]);
          }
        }
        changedItems += 1;

        // Reabrir um item finalizado estorna a baixa anterior (mesmo raciocínio do bloco de cima)
        if (currentStatus === "Finalizado" && itemStatus !== "Finalizado") {
          const oldQty = asInt(current.quantidade_liberada);
          await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [oldQty, current.sku_produto]);
          await client.query(
            "UPDATE estoque_pdv SET quantidade = GREATEST(0, quantidade - $1) WHERE pdv_id = $2 AND sku_produto = $3",
            [oldQty, current.pdv_id, current.sku_produto]
          );
          // Mesmo raciocínio do bloco de cima: o estorno também precisa chegar na integração
          await registrarCompensacaoDaReabertura(client, {
            codigoPedido: current.codigo_pedido,
            itens: [
              { pedidoItemId: asInt(item.id), sku: current.sku_produto, pdvId: current.pdv_id, quantidade: oldQty }
            ]
          });
        }
      }
      if (releaseMode === "entered-only" && nextStatus === "Aguardando Retirada" && changedItems === 0) {
        const error = new Error("Informe a quantidade que deseja liberar em pelo menos um produto.");
        error.statusCode = 400;
        throw error;
      }
      await registrarAuditoriaStatus(client, {
        codigoPedido: orderCode || items[0]?.codigo_pedido || "",
        acao: "status_alterado_painel",
        usuario: user.name || "Almoxarifado",
        de: currentStatusFilter,
        para: nextStatus,
        dados: { origem: "order-flow", release_mode: releaseMode || null, itens: items.length, excedentes }
      });
    });
    publishOrderStatusChange({
      codigoPedido: orderCode,
      de: currentStatusFilter,
      para: nextStatus,
      usuario: user.name || "Almoxarifado",
      origem: "painel"
    });
    send(res, 200, { ok: true, excedentes });
    return true;
  }

  // Linha do tempo do pedido: todas as mudanças de etapa registradas na auditoria
  if (url.pathname === "/api/admin/order-timeline" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const orderCode = normalizeText(url.searchParams.get("codigo_pedido"), 80);
    if (!orderCode) return send(res, 400, { error: "Pedido inválido." }), true;
    await ensurePedidoAuditTable();
    const timeline = await query(
      `SELECT acao, usuario, observacao, dados, criado_em
       FROM pedido_auditoria
       WHERE codigo_pedido = $1
       ORDER BY criado_em ASC, id ASC
       LIMIT 200`,
      [orderCode]
    );
    send(res, 200, { timeline });
    return true;
  }

  // Confirma a retirada física do pedido: exige assinatura e dá baixa definitiva no estoque
  if (url.pathname === "/api/admin/order-withdrawal" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const orderCode = normalizeText(body.codigo_pedido, 80);
    const responsavel = normalizeText(body.responsavel_retirada, 160).toUpperCase();
    const observacao = normalizeText(body.observacao, 500);
    const assinatura = String(body.assinatura || "");
    if (!orderCode) return send(res, 400, { error: "Pedido inválido." }), true;
    if (!responsavel) return send(res, 400, { error: "Informe o responsável pela retirada." }), true;
    if (!assinatura.startsWith("data:image/png;base64,") || assinatura.length < 1200) {
      return send(res, 400, { error: "A assinatura do responsável é obrigatória." }), true;
    }
    // Avisos devolvidos à tela: saldos que ficaram negativos e itens liberados abaixo do solicitado
    const negativos = [];
    const sobras = [];
    // Resumo do que foi enfileirado para a integração externa, devolvido como aviso à tela
    let lancamentoIntegracao = null;
    await ensurePedidoAuditTable();

    await tx(async (client) => {
      const requestedStatus = orderStatuses.includes(body.status) ? body.status : "";
      const rows = await client.query(
        `SELECT id, codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada,
                status, observacao, retirada_assinatura, pedido_editado, pedido_editado_em, pedido_editado_por,
                release_mode
         FROM pedidos
         WHERE codigo_pedido = $1
         ORDER BY id
         FOR UPDATE`,
        [orderCode]
      );
      if (!rows.rows.length) {
        const error = new Error("Pedido não encontrado.");
        error.statusCode = 404;
        throw error;
      }
      const normalizedRows = rows.rows.map((row) => ({
        ...row,
        normalizedStatus: normalizeOrderStatus(row.status)
      }));
      const targetStatus = requestedStatus === "Aguardando Retirada"
        ? requestedStatus
        : normalizedRows.some((row) => row.normalizedStatus === "Aguardando Retirada")
          ? "Aguardando Retirada"
          : "";
      if (!targetStatus) {
        const error = new Error("Não há produtos aguardando retirada para confirmar.");
        error.statusCode = 400;
        throw error;
      }
      const targetRows = normalizedRows.filter((row) => row.normalizedStatus === targetStatus);
      if (!targetRows.length) {
        const error = new Error("Não há produtos deste status para confirmar a retirada.");
        error.statusCode = 400;
        throw error;
      }
      // Idempotência simples: se já existe assinatura registrada, a retirada não pode ser repetida
      if (targetRows.some((row) => row.retirada_assinatura)) {
        const error = new Error("A retirada deste pedido já foi confirmada.");
        error.statusCode = 400;
        throw error;
      }
      if (targetRows.some((row) => row.normalizedStatus !== "Aguardando Retirada")) {
        const error = new Error("A retirada só pode ser confirmada para pedidos aguardando retirada.");
        error.statusCode = 400;
        throw error;
      }
      if (targetRows.some((row) => asInt(row.quantidade_liberada) <= 0)) {
        const error = new Error("A retirada só pode ser confirmada para produtos com quantidade liberada.");
        error.statusCode = 400;
        throw error;
      }
      // Baixa definitiva: sai do estoque central e entra no saldo físico do PDV.
      // Só a quantidade liberada é movimentada; a diferença para o solicitado não vira pendência.
      for (const row of targetRows) {
        const qty = asInt(row.quantidade_liberada);
        const baixa = await client.query(
          "UPDATE produtos SET qtd_total = qtd_total - $1 WHERE sku = $2 RETURNING sku, nome, qtd_total",
          [qty, row.sku_produto]
        );
        // Saldo central negativo não bloqueia a retirada, mas volta para a tela como aviso
        const saldo = baixa.rows[0];
        if (saldo && asInt(saldo.qtd_total) < 0) {
          negativos.push({ sku: saldo.sku, nome: saldo.nome, saldo: asInt(saldo.qtd_total) });
        }
        const pendente = asInt(row.quantidade_solicitada) - qty;
        if (pendente > 0) sobras.push({ sku: row.sku_produto, solicitada: asInt(row.quantidade_solicitada), liberada: qty, nao_atendida: pendente });
        await client.query(
          `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade)
           VALUES ($1, $2, $3)
           ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET quantidade = estoque_pdv.quantidade + EXCLUDED.quantidade`,
          [row.pdv_id, row.sku_produto, qty]
        );
      }

      // Enfileira a transferência ALMOXARIFADO → PDV para a integração externa.
      // Nunca bloqueia: sem integração, sem vínculo ou sem internet, a retirada conclui
      // do mesmo jeito e o lançamento fica pendente na fila.
      lancamentoIntegracao = await registrarTransferenciasDaRetirada(client, {
        codigoPedido: orderCode,
        itens: targetRows.map((row) => ({
          pedidoItemId: row.id,
          sku: row.sku_produto,
          pdvId: row.pdv_id,
          quantidade: asInt(row.quantidade_liberada)
        }))
      });

      const finalized = await client.query(
        `UPDATE pedidos
         SET status = 'Finalizado',
             retirada_assinatura = $2,
             retirada_responsavel = $3,
             retirada_observacao = $4,
             retirada_em = CURRENT_TIMESTAMP,
             retirada_usuario_almoxarifado = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE codigo_pedido = $1
           AND status = $6
           AND quantidade_liberada > 0
         RETURNING id, codigo_pedido, sku_produto, quantidade_liberada`,
        [orderCode, assinatura, responsavel, observacao || null, user.name || "Almoxarifado", targetStatus]
      );
      // Mescla com outro item finalizado do mesmo produto, evitando linhas duplicadas no histórico
      for (const row of finalized.rows || []) {
        const existing = await client.query(
          `SELECT id
           FROM pedidos
           WHERE codigo_pedido = $1
             AND sku_produto = $2
             AND status = 'Finalizado'
             AND id <> $3
           ORDER BY id
           LIMIT 1
           FOR UPDATE`,
          [row.codigo_pedido, row.sku_produto, row.id]
        );
        const keep = existing.rows[0];
        if (!keep) continue;
        await client.query(
          `UPDATE pedidos
           SET quantidade_liberada = COALESCE(quantidade_liberada, 0) + $2,
               quantidade_solicitada = GREATEST(quantidade_solicitada, COALESCE(quantidade_liberada, 0) + $2),
               retirada_assinatura = $3,
               retirada_responsavel = $4,
               retirada_observacao = $5,
               retirada_em = CURRENT_TIMESTAMP,
               retirada_usuario_almoxarifado = $6,
               pedido_editado = TRUE,
               pedido_editado_em = CURRENT_TIMESTAMP,
               pedido_editado_por = $6,
               version = COALESCE(version, 1) + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [keep.id, asInt(row.quantidade_liberada), assinatura, responsavel, observacao || null, user.name || "Almoxarifado"]
        );
        await client.query("DELETE FROM pedidos WHERE id = $1", [row.id]);
      }
      await registrarAuditoriaStatus(client, {
        codigoPedido: orderCode,
        acao: "retirada_confirmada",
        usuario: user.name || "Almoxarifado",
        de: targetStatus,
        para: "Finalizado",
        observacao: `Retirada confirmada por ${responsavel}`,
        dados: {
          origem: "order-withdrawal",
          responsavel,
          itens: finalized.rows?.length || targetRows.length,
          sobras,
          saldos_negativos: negativos
        }
      });
    });

    publishOrderStatusChange({
      codigoPedido: orderCode,
      de: "Aguardando Retirada",
      para: "Finalizado",
      usuario: user.name || "Almoxarifado",
      origem: "retirada"
    });
    send(res, 200, { ok: true, sobras, saldos_negativos: negativos, integracao: lancamentoIntegracao });
    return true;
  }

  // Histórico consolidado de pedidos para relatórios (com filtro de pedidos automáticos)
  if (url.pathname === "/api/admin/history") {
    if (!requireUser(req, res, "admin")) return true;
    await ensurePedidoEditColumns();
    const pdvId = asInt(url.searchParams.get("pdvId"));
    const autoOnly = url.searchParams.get("auto") === "1";
    const status = normalizeText(url.searchParams.get("status"), 40);
    const allowedStatus = orderStatuses.includes(status) ? status : "";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = await query(
      `SELECT p.id, p.data_hora, p.codigo_pedido, pd.nome AS pdv, p.solicitante, p.observacao,
              p.sku_produto, pr.nome AS produto, p.quantidade_solicitada, p.quantidade_liberada,
              COALESCE(p.item_origem, 'PDV') AS item_origem,
              p.retirada_assinatura, p.retirada_responsavel, p.retirada_em, p.retirada_usuario_almoxarifado,
              CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') THEN 'Aguardando Retirada'
                ELSE p.status
              END AS status,
              COALESCE(p.pedido_editado, FALSE) AS pedido_editado, p.pedido_editado_em, p.pedido_editado_por,
              COALESCE(p.pedido_reaberto_finalizado, FALSE) AS pedido_reaberto_finalizado
       FROM pedidos p
       JOIN pdvs pd ON pd.id = p.pdv_id
       JOIN produtos pr ON pr.sku = p.sku_produto
       WHERE ($1::int = 0 OR p.pdv_id = $1)
         AND ($2::boolean = FALSE OR p.codigo_pedido LIKE 'AUTO-%')
         AND ($3::text IS NULL OR CASE
                WHEN p.status = 'Liberado' THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') THEN 'Aguardando Retirada'
                ELSE p.status
              END = $3)
         AND ($4::date IS NULL OR p.data_hora::date >= $4::date)
         AND ($5::date IS NULL OR p.data_hora::date <= $5::date)
       ORDER BY p.data_hora DESC, p.id ASC
       LIMIT 500`,
      [pdvId, autoOnly, allowedStatus || null, from || null, to || null]
    );
    send(res, 200, { history: rows });
    return true;
  }

  return false;
}



import { asInt, query, tx } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { processNextOmieJob } from "../../services/omie/omie.movements.js";

// Roteador administrativo para acompanhar e reprocessar jobs de integração com o OMIE
export async function handleOmieRoutes(req, res, context) {
  const { method, requireUser, url, user } = context;

  // Lista os jobs OMIE com filtros de status, tipo de entidade e período
  if (url.pathname === "/api/admin/omie/jobs") {
    if (!requireUser(req, res, "admin")) return true;
    if (method !== "GET") return false;

    const status = normalizeText(url.searchParams.get("status"), 30);
    const entityType = normalizeText(url.searchParams.get("type"), 50);
    const entityId = asInt(url.searchParams.get("entityId"));
    const from = normalizeText(url.searchParams.get("from"), 20);
    const to = normalizeText(url.searchParams.get("to"), 20);
    const rows = await query(
      `SELECT j.*, pd.nome AS pdv, p.nome AS produto
       FROM omie_jobs j
       LEFT JOIN pdvs pd ON pd.id = j.pdv_id
       LEFT JOIN produtos p ON p.sku = j.product_sku
       WHERE ($1::text = '' OR j.status = $1)
         AND ($2::text = '' OR j.entity_type = $2)
         AND ($3::bigint = 0 OR j.entity_id = $3)
         AND ($4::date IS NULL OR j.created_at::date >= $4::date)
         AND ($5::date IS NULL OR j.created_at::date <= $5::date)
       ORDER BY j.created_at DESC
       LIMIT 500`,
      [status, entityType, entityId, from || null, to || null]
    );
    return send(res, 200, { jobs: rows }), true;
  }

  // Força um job com falha a voltar para a fila de reprocessamento (jobs concluídos ficam bloqueados)
  if (url.pathname === "/api/admin/omie/reprocess" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    const id = asInt(body.id);
    const reason = normalizeText(body.motivo || body.reason, 500);
    if (!id) return send(res, 400, { error: "Job inválido." }), true;
    if (!reason) return send(res, 400, { error: "Informe o motivo do reprocessamento." }), true;

    const result = await tx(async (client) => {
      const current = await client.query("SELECT * FROM omie_jobs WHERE id = $1 FOR UPDATE", [id]);
      const job = current.rows[0];
      if (!job) throw new Error("Job OMIE não encontrado.");
      if (job.status === "SUCCESS") {
        // Evita reverter um job já concluído com sucesso, pois exigiria estorno manual no OMIE
        const error = new Error("Integrações concluídas não podem ser reprocessadas sem fluxo de estorno.");
        error.statusCode = 400;
        throw error;
      }
      await client.query(
        `UPDATE omie_jobs
         SET status = 'RETRY_REQUIRED',
             last_error = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, `Reprocessamento solicitado por ${user.name}: ${reason}`]
      );
      return processNextOmieJob(client);
    });

    return send(res, 200, { ok: true, job: result }), true;
  }

  // Processa manualmente o próximo job pendente da fila OMIE
  if (url.pathname === "/api/admin/omie/process-next" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const result = await tx((client) => processNextOmieJob(client));
    return send(res, 200, { ok: true, job: result }), true;
  }

  return false;
}

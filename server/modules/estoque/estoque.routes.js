import { query, tx, asInt } from "../../db.js";
import { readBody, send } from "../../utils/http.js";

// Roteador das rotas de estoque; retorna true quando a rota foi tratada
export async function handleEstoqueRoutes(req, res, context) {
  const { method, requireUser, url, user } = context;

  // Lista os produtos liberados e ativos disponíveis para um PDV consultar/pedir
  if (url.pathname === "/api/pdv/products") {
    const pdvId = user.role === "pdv" ? user.pdvId : asInt(url.searchParams.get("pdvId"));
    const rows = await query(
      `SELECT p.sku, p.nome, p.qtd_total AS estoque_central,
              COALESCE(string_agg(DISTINCT prc.categoria, ', ' ORDER BY prc.categoria), '') AS categoria,
              e.quantidade, e.estoque_minimo, e.estoque_maximo
       FROM estoque_pdv e
       JOIN produtos p ON p.sku = e.sku_produto
       JOIN produto_categorias prc ON prc.sku_produto = p.sku
       JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
       WHERE e.pdv_id = $1 AND e.permitido = TRUE AND p.ativo = TRUE
       GROUP BY p.sku, p.nome, p.qtd_total, e.quantidade, e.estoque_minimo, e.estoque_maximo
       ORDER BY p.nome`,
      [pdvId]
    );
    send(res, 200, { products: rows });
    return true;
  }

  // Tela do almoxarifado para consultar/editar estoque mínimo, máximo e quantidade por PDV
  if (url.pathname === "/api/admin/stock") {
    if (!requireUser(req, res, "admin")) return true;
    const pdvId = asInt(url.searchParams.get("pdvId"));
    if (method === "GET") {
      const pdvRows = await query("SELECT id, nome, categoria, is_cozinha FROM pdvs WHERE id = $1", [pdvId]);
      const pdv = pdvRows[0] || null;
      const categoryRows = await query("SELECT categoria FROM pdv_categorias WHERE pdv_id = $1 ORDER BY categoria", [pdvId]);
      const categorias = categoryRows.map((row) => row.categoria);
      const rows = await query(
        `SELECT p.sku, p.nome, p.qtd_total AS estoque_central,
                COALESCE(string_agg(DISTINCT pcg.categoria, ', ' ORDER BY pcg.categoria), '') AS categoria,
                TRUE AS permitido, COALESCE(e.quantidade, 0) quantidade,
                COALESCE(e.estoque_minimo, 0) estoque_minimo, COALESCE(e.estoque_maximo, 0) estoque_maximo
         FROM produtos p
         JOIN produto_categorias pcg ON pcg.sku_produto = p.sku
         LEFT JOIN estoque_pdv e ON e.sku_produto = p.sku AND e.pdv_id = $1
         WHERE (
           COALESCE(array_length($2::text[], 1), 0) > 0
           AND pcg.categoria = ANY($2::text[])
         )
         GROUP BY p.sku, p.nome, p.qtd_total, e.quantidade, e.estoque_minimo, e.estoque_maximo
         ORDER BY p.nome`,
        [pdvId, categorias]
      );
      send(res, 200, { stock: rows, pdv: { ...pdv, categorias } });
      return true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      const categoryRows = await query("SELECT categoria FROM pdv_categorias WHERE pdv_id = $1 ORDER BY categoria", [asInt(body.pdvId)]);
      const categorias = categoryRows.map((row) => row.categoria);
      await tx(async (client) => {
        for (const item of items) {
          // Um produto só fica permitido no PDV se pertencer a alguma categoria liberada para o PDV
          const product = await client.query("SELECT categoria FROM produto_categorias WHERE sku_produto = $1", [item.sku]);
          const permitido = product.rows.some((row) => categorias.includes(row.categoria));
          await client.query(
            `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade, estoque_minimo, estoque_maximo, permitido)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET
               quantidade = EXCLUDED.quantidade,
               estoque_minimo = EXCLUDED.estoque_minimo,
               estoque_maximo = EXCLUDED.estoque_maximo,
               permitido = EXCLUDED.permitido`,
            [asInt(body.pdvId), item.sku, asInt(item.quantidade), asInt(item.estoque_minimo), asInt(item.estoque_maximo), permitido]
          );
        }
      });
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return false;
}

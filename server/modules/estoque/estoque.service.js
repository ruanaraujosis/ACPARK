// Recalcula quais produtos ficam liberados (permitido) para um PDV, com base nas categorias do PDV
//
// Produto inativo nunca fica permitido: a OMIE recusa movimentar cadastro inativo, entao um
// item descontinuado liberado aqui vira pedido que o PDV separa e retira, e so falha depois,
// na hora de lancar no ERP (nove casos em set/2026).
export async function syncPdvAllowedProducts(client, pdvId) {
  // Libera produtos ATIVOS cujas categorias batem com as categorias atribuídas ao PDV
  await client.query(
    `INSERT INTO estoque_pdv (pdv_id, sku_produto, permitido)
     SELECT DISTINCT $1, p.sku, TRUE
     FROM produtos p
     JOIN produto_categorias prc ON prc.sku_produto = p.sku
     JOIN pdv_categorias pc ON pc.pdv_id = $1 AND pc.categoria = prc.categoria
     WHERE p.ativo IS NOT FALSE
     ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET permitido = TRUE`,
    [pdvId]
  );
  // Bloqueia produto que ficou inativo ou que não tem mais categoria correspondente às do PDV
  await client.query(
    `UPDATE estoque_pdv e
     SET permitido = FALSE
     WHERE e.pdv_id = $1
       AND NOT EXISTS (
         SELECT 1
         FROM produtos p
         JOIN produto_categorias prc ON prc.sku_produto = p.sku
         JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
         WHERE p.sku = e.sku_produto
           AND p.ativo IS NOT FALSE
       )`,
    [pdvId]
  );
}

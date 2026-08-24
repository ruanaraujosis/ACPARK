import { chamarOmie, ENDPOINTS, extrairLista, totalDePaginas } from "../omie.api.js";
import { mapearLocal } from "../omie.mappers.js";

const CALL = "ListarLocaisEstoque";
const CAMPOS_LISTA = ["locaisEncontrados", "locais_estoque", "cadastros"];
const TAMANHO_PAGINA = 50;

// Importa os locais de estoque da OMIE. Sao poucos (um por deposito/loja), entao o job
// percorre todas as paginas de uma vez.
//
// Esta e a tarefa que precisa rodar antes de saldos e movimentos: sem os locais importados
// nao da para o operador vincular cada PDV ao seu local oficial, e sem esse vinculo o saldo
// nao tem onde ser gravado.
export async function sincronizarLocais(contexto) {
  const { client, integracao, segredos, fetchImpl } = contexto;
  const resumo = {
    paginas: 0,
    recebidos: 0,
    criados: 0,
    atualizados: 0,
    ignorados: 0
  };

  let pagina = 1;
  let totalPaginas = 1;

  do {
    const resposta = await chamarOmie({
      integracao,
      segredos,
      endpoint: ENDPOINTS.LOCAIS,
      call: CALL,
      params: { nPagina: pagina, nRegPorPagina: TAMANHO_PAGINA },
      fetchImpl
    });

    const lista = extrairLista(resposta.dados, CAMPOS_LISTA);
    totalPaginas = totalDePaginas(resposta.dados);
    resumo.paginas += 1;
    resumo.recebidos += lista.length;

    for (const bruto of lista) {
      const local = mapearLocal(bruto);
      if (!local.idExterno || !local.nome) {
        resumo.ignorados += 1;
        continue;
      }
      const gravado = await client.query(
        `INSERT INTO omie_stock_locations
           (integration_id, omie_location_id, code, name, description, active, raw_payload, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (integration_id, omie_location_id) DO UPDATE
         SET code = EXCLUDED.code,
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             active = EXCLUDED.active,
             raw_payload = EXCLUDED.raw_payload,
             synced_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         RETURNING (xmax = 0) AS inserido`,
        [
          integracao.id,
          local.idExterno,
          local.codigo,
          local.nome,
          local.descricao,
          local.ativo,
          JSON.stringify(local.bruto || {})
        ]
      );
      if (gravado.rows[0]?.inserido) resumo.criados += 1;
      else resumo.atualizados += 1;
    }

    pagina += 1;
  } while (pagina <= totalPaginas);

  if (!resumo.recebidos) {
    resumo.alerta =
      "Nenhum local de estoque retornado pela OMIE. Confira se a conta usa controle de estoque por local.";
  }

  resumo.cursor = { ultimaPagina: totalPaginas, estatisticas: { ...resumo } };
  return resumo;
}

import { pool, query } from "../../../db.js";

// Vinculo entre a categoria local e o agrupamento equivalente do sistema externo
// (familia, grupo, departamento -- o nome muda por ERP).
//
// Existe porque casar os dois lados PELO NOME e fragil: em 21/09/2026 a familia
// MANIPULADOS foi excluida e recriada no ERP com outro codigo, e 400 produtos ficaram
// sem agrupamento de uma vez, sem aviso nenhum. Guardando o identificador externo, uma
// renomeacao vira renomeacao (e nao categoria nova), e um sumico vira alerta.
//
// Este arquivo e do nucleo: nao conhece nenhuma API especifica, so o formato do vinculo.

let tabelaGarantida = null;

// Cria a tabela na primeira utilizacao, como as demais tabelas de runtime do projeto.
// Aceita o client da transacao em curso; sem ele, usa a conexao do pool.
export function ensureCategoriaVinculoTable(client = null) {
  if (!tabelaGarantida) {
    const rodar = (texto) => (client ? client.query(texto) : query(texto));
    tabelaGarantida = (async () => {
      await rodar(`
        CREATE TABLE IF NOT EXISTS integration_category_links (
          id SERIAL PRIMARY KEY,
          integration_id INTEGER NOT NULL,
          external_id TEXT NOT NULL,
          external_code TEXT,
          external_name TEXT NOT NULL,
          categoria TEXT NOT NULL,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          ausente_desde TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (integration_id, external_id)
        )
      `);
      await rodar(
        "CREATE INDEX IF NOT EXISTS idx_category_links_categoria ON integration_category_links (integration_id, categoria)",
      );
    })();
  }
  return tabelaGarantida;
}

// Usado so pelos testes, para nao carregar a memoizacao entre casos
export function resetarCacheDaTabela() {
  tabelaGarantida = null;
}

const executar = (client, texto, valores) =>
  client ? client.query(texto, valores) : pool.query(texto, valores);

export async function listarVinculos(client, integrationId) {
  const r = await executar(
    client,
    "SELECT * FROM integration_category_links WHERE integration_id = $1",
    [integrationId],
  );
  return r.rows || [];
}

// Grava o vinculo. Conflito resolve pelo identificador externo, entao o agrupamento que
// trocou de nome atualiza a linha existente em vez de criar outra.
export async function salvarVinculo(
  client,
  { integrationId, externalId, externalCode, externalName, categoria },
) {
  await executar(
    client,
    `INSERT INTO integration_category_links
       (integration_id, external_id, external_code, external_name, categoria, active, ausente_desde)
     VALUES ($1, $2, $3, $4, $5, TRUE, NULL)
     ON CONFLICT (integration_id, external_id) DO UPDATE
     SET external_code = EXCLUDED.external_code,
         external_name = EXCLUDED.external_name,
         categoria = EXCLUDED.categoria,
         active = TRUE,
         ausente_desde = NULL,
         updated_at = CURRENT_TIMESTAMP`,
    [
      integrationId,
      String(externalId),
      externalCode ? String(externalCode) : null,
      String(externalName),
      String(categoria),
    ],
  );
}

// Agrupamento que sumiu do sistema externo: o vinculo e desativado e a data registrada.
// A categoria local NUNCA e apagada aqui -- pdv_categorias amarra permissao pelo nome, e
// apagar categoria por reflexo tiraria produtos da tela de quem podia pedi-los.
export async function marcarVinculoAusente(
  client,
  { integrationId, externalId },
) {
  await executar(
    client,
    `UPDATE integration_category_links
     SET active = FALSE,
         ausente_desde = COALESCE(ausente_desde, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND external_id = $2`,
    [integrationId, String(externalId)],
  );
}

// Renomeia a categoria local e leva junto todas as tabelas que guardam o NOME dela.
//
// Sao quatro lugares e nenhum tem chave estrangeira para categorias.nome: se a renomeacao
// parasse na tabela categorias, os produtos continuariam apontando para um nome que nao
// existe mais e a permissao de PDV (pdv_categorias) ficaria orfa. Por isso tudo numa
// transacao so.
export async function renomearCategoria(client, deNome, paraNome) {
  const de = String(deNome || "").trim();
  const para = String(paraNome || "").trim();
  if (!de || !para || de === para) return { renomeada: false };

  const executarAqui = (texto, valores) => executar(client, texto, valores);

  // Se o nome novo ja existe como categoria, as duas viram uma so: a antiga e removida e
  // os vinculos passam a apontar para a nova, sem violar as chaves unicas por nome.
  const jaExiste = await executarAqui(
    "SELECT 1 FROM categorias WHERE nome = $1 LIMIT 1",
    [para],
  );
  const fundir = Boolean(jaExiste.rows[0]);

  await executarAqui(
    "UPDATE produtos SET categoria = $2 WHERE categoria = $1",
    [de, para],
  );
  if (fundir) {
    await executarAqui(
      `DELETE FROM produto_categorias a
       WHERE a.categoria = $1
         AND EXISTS (SELECT 1 FROM produto_categorias b WHERE b.sku_produto = a.sku_produto AND b.categoria = $2)`,
      [de, para],
    );
    await executarAqui(
      `DELETE FROM pdv_categorias a
       WHERE a.categoria = $1
         AND EXISTS (SELECT 1 FROM pdv_categorias b WHERE b.pdv_id = a.pdv_id AND b.categoria = $2)`,
      [de, para],
    );
  }
  await executarAqui(
    "UPDATE produto_categorias SET categoria = $2 WHERE categoria = $1",
    [de, para],
  );
  await executarAqui(
    "UPDATE pdv_categorias SET categoria = $2 WHERE categoria = $1",
    [de, para],
  );
  await executarAqui(
    "UPDATE integration_category_links SET categoria = $2 WHERE categoria = $1",
    [de, para],
  );

  if (fundir)
    await executarAqui("DELETE FROM categorias WHERE nome = $1", [de]);
  else
    await executarAqui("UPDATE categorias SET nome = $2 WHERE nome = $1", [
      de,
      para,
    ]);

  return { renomeada: true, fundida: fundir };
}

// Categorias locais que ainda nao tem vinculo com o sistema externo -- candidatas a serem
// criadas la. Categoria sem produto nenhum fica de fora: e sobra de teste ou de limpeza.
export async function categoriasSemVinculo(client, integrationId) {
  const r = await executar(
    client,
    `SELECT c.nome
     FROM categorias c
     WHERE NOT EXISTS (
             SELECT 1 FROM integration_category_links v
             WHERE v.integration_id = $1 AND v.categoria = c.nome AND v.active
           )
       AND (
             EXISTS (SELECT 1 FROM produtos p WHERE p.categoria = c.nome)
             OR EXISTS (SELECT 1 FROM produto_categorias pc WHERE pc.categoria = c.nome)
           )
     ORDER BY c.nome`,
    [integrationId],
  );
  return (r.rows || []).map((linha) => linha.nome);
}

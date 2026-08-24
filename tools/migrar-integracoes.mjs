import "../server/env.js";
import { pool, query } from "../server/db.js";
import { normalizarUrlBase } from "../server/services/integrations/providers/omie/omie.api.js";
import "../server/services/integrations/providers/index.js";
import { obterProvider } from "../server/services/integrations/core/provider-registry.js";

// Migra os dados da arquitetura antiga de integracoes para a nova.
//
// Roda em simulacao por padrao: sem --executar, so mostra o que faria. O que ele arruma:
//
// 1. url_base com o endpoint colado na raiz (foi assim que a instalacao ficou 25 dias
//    sincronizando sem importar nada);
// 2. os escopos antigos em integration_sync_state (SYNC_OMIE_PRODUCTS e afins), que nao
//    batem com os ids de capacidade do provider e por isso deixariam o agendador achar
//    que nada nunca rodou;
// 3. jobs antigos em integration_jobs -- 102 mil linhas de lixo geradas pelo tick que
//    enfileirava tudo a cada 15 segundos.

const executar = process.argv.includes("--executar");
const rotulo = executar ? "APLICANDO" : "SIMULACAO";

// Escopos gravados pela versao anterior -> id da capacidade correspondente hoje
const ESCOPOS_ANTIGOS = {
  SYNC_OMIE_PRODUCTS: "PRODUTOS",
  SYNC_OMIE_LOCATIONS: "LOCAIS",
  SYNC_OMIE_STOCK: "SALDOS",
  SYNC_OMIE_STOCK_ITEM: "SALDO_ITEM",
  SYNC_OMIE_MOVEMENTS: "MOVIMENTOS",
  RECONCILE_OMIE_STOCK: "RECONCILIACAO",
  SYNC_OMIE_FULL: "PRODUTOS",
  // Nome solto deixado por uma versao ainda mais antiga, encontrado no banco desta instalacao
  MOVEMENTS: "MOVIMENTOS",
  PRODUCTS: "PRODUTOS",
  LOCATIONS: "LOCAIS",
  STOCK: "SALDOS"
};

// Mantem por integracao/tipo os jobs mais recentes; o resto e descartavel
const MANTER_POR_TIPO = 50;

function linha(texto) {
  console.log(texto);
}

async function corrigirUrlBase() {
  linha("\n== 1. URL base das integracoes ==");
  const integracoes = await query("SELECT id, nome, provedor, url_base FROM integrations ORDER BY id");
  let ajustadas = 0;

  for (const integracao of integracoes) {
    const provider = obterProvider(integracao.provedor);
    if (!provider) {
      linha(`  [${integracao.id}] ${integracao.nome}: provider ${integracao.provedor} nao registrado - ignorado`);
      continue;
    }
    // So a OMIE tem regra propria de normalizacao; outros providers ficam como estao
    const correta = integracao.provedor === "OMIE" ? normalizarUrlBase(integracao.url_base) : integracao.url_base;

    if (correta === integracao.url_base) {
      linha(`  [${integracao.id}] ${integracao.nome}: ja correta (${integracao.url_base})`);
      continue;
    }
    linha(`  [${integracao.id}] ${integracao.nome}:`);
    linha(`      de:   ${integracao.url_base}`);
    linha(`      para: ${correta}`);
    ajustadas += 1;
    if (executar) {
      await query("UPDATE integrations SET url_base = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
        integracao.id,
        correta
      ]);
    }
  }
  linha(`  -> ${ajustadas} integracao(oes) a ajustar`);
}

async function migrarEscopos() {
  linha("\n== 2. Escopos de sincronizacao ==");
  const estados = await query(
    "SELECT integration_id, scope, last_success_at FROM integration_sync_state ORDER BY integration_id, scope"
  );
  if (!estados.length) {
    linha("  Nenhum estado de sincronizacao registrado.");
    return;
  }

  // Ids de capacidade validos hoje, para nao confiar so no mapa de nomes antigos
  const integracoes = await query("SELECT id, provedor FROM integrations");
  const validosPorIntegracao = new Map(
    integracoes.map((item) => [
      String(item.id),
      new Set((obterProvider(item.provedor)?.capacidades || []).map((c) => c.id))
    ])
  );

  for (const estado of estados) {
    const validos = validosPorIntegracao.get(String(estado.integration_id)) || new Set();
    if (validos.has(estado.scope)) {
      linha(`  [${estado.integration_id}] ${estado.scope}: ja no formato novo`);
      continue;
    }
    const novo = ESCOPOS_ANTIGOS[estado.scope];
    if (!novo) {
      // Escopo que nao existe mais e nao tem para onde migrar: o cursor dele nao serve
      // para nada e so confundiria o painel de saude
      linha(`  [${estado.integration_id}] ${estado.scope}: sem correspondencia - sera removido`);
      if (executar) {
        await query("DELETE FROM integration_sync_state WHERE integration_id = $1 AND scope = $2", [
          estado.integration_id,
          estado.scope
        ]);
      }
      continue;
    }
    // A tabela tem unico (integration_id, scope). Dois escopos antigos podem apontar para a
    // mesma capacidade nova (MOVEMENTS e SYNC_OMIE_MOVEMENTS viram MOVIMENTOS), entao um dos
    // dois tem de sair. Vence sempre o cursor MAIS RECENTE -- descartar por ordem alfabetica
    // apagaria justamente a linha que tem historico e faria a leitura incremental recomecar.
    const conflito = await query(
      "SELECT last_success_at FROM integration_sync_state WHERE integration_id = $1 AND scope = $2",
      [estado.integration_id, novo]
    );

    if (conflito.length) {
      const existente = conflito[0].last_success_at ? new Date(conflito[0].last_success_at).getTime() : 0;
      const candidato = estado.last_success_at ? new Date(estado.last_success_at).getTime() : 0;
      const venceOCandidato = candidato > existente;
      linha(
        `  [${estado.integration_id}] ${estado.scope} -> ${novo} (ja existe; mantem o cursor de ` +
          `${venceOCandidato ? estado.scope : novo}` +
          `${venceOCandidato ? "" : ", mais recente"})`
      );
      if (!executar) continue;
      if (venceOCandidato) {
        // O antigo tem historico melhor: substitui o que ja estava la
        await query("DELETE FROM integration_sync_state WHERE integration_id = $1 AND scope = $2", [
          estado.integration_id,
          novo
        ]);
        await query("UPDATE integration_sync_state SET scope = $3 WHERE integration_id = $1 AND scope = $2", [
          estado.integration_id,
          estado.scope,
          novo
        ]);
      } else {
        await query("DELETE FROM integration_sync_state WHERE integration_id = $1 AND scope = $2", [
          estado.integration_id,
          estado.scope
        ]);
      }
      continue;
    }

    linha(`  [${estado.integration_id}] ${estado.scope} -> ${novo}`);
    if (!executar) continue;
    {
      await query("UPDATE integration_sync_state SET scope = $3 WHERE integration_id = $1 AND scope = $2", [
        estado.integration_id,
        estado.scope,
        novo
      ]);
    }
  }
}

async function podarJobs() {
  linha("\n== 3. Fila de jobs ==");
  const [{ total }] = await query("SELECT COUNT(*)::int AS total FROM integration_jobs");
  linha(`  Jobs hoje: ${total}`);

  const porTipo = await query(
    `SELECT job_type, status, COUNT(*)::int AS total
     FROM integration_jobs GROUP BY job_type, status ORDER BY total DESC LIMIT 12`
  );
  for (const item of porTipo) {
    linha(`    ${String(item.job_type).padEnd(24)} ${String(item.status).padEnd(24)} ${item.total}`);
  }

  // Jobs a manter: os mais recentes de cada integracao/tipo. Todo o resto sai.
  const [{ manter }] = await query(
    `WITH ranqueados AS (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY integration_id, job_type ORDER BY created_at DESC) AS posicao
       FROM integration_jobs
     )
     SELECT COUNT(*)::int AS manter FROM ranqueados WHERE posicao <= $1`,
    [MANTER_POR_TIPO]
  );
  linha(`  A manter: ${manter} | a remover: ${total - manter}`);

  if (!executar) return;
  const resultado = await pool.query(
    `WITH ranqueados AS (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY integration_id, job_type ORDER BY created_at DESC) AS posicao
       FROM integration_jobs
     )
     DELETE FROM integration_jobs WHERE id IN (SELECT id FROM ranqueados WHERE posicao > $1)`,
    [MANTER_POR_TIPO]
  );
  linha(`  -> ${resultado.rowCount} jobs removidos`);
}

async function principal() {
  linha(`Migracao de integracoes -- modo: ${rotulo}`);
  if (!executar) linha("(nada sera alterado; rode com --executar para aplicar)");

  await corrigirUrlBase();
  await migrarEscopos();
  await podarJobs();

  linha(`\nConcluido (${rotulo}).`);
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

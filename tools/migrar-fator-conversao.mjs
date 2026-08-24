import "../server/env.js";
import { pool, query } from "../server/db.js";

// Adiciona ao vinculo produto x ERP as colunas do fator de conversao.
//
// Aditiva: colunas novas, todas anulaveis. O fator mora no vinculo (nao em produtos) porque
// e um dado que vem do ERP, junto com o codigo externo -- se a integracao for desligada, o
// fator sai junto e o produto nao fica com um numero orfao que ninguem sabe de onde veio.
//
// Simulacao por padrao; --executar aplica.

const executar = process.argv.includes("--executar");

const DDL = [
  // Quantas unidades tem a embalagem. NULL = ainda nao lido do ERP.
  `ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS fator_conversao integer`,
  // Nome da embalagem (FARDO, CAIXA...), opcional, so para a tela falar a lingua do PDV
  `ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS embalagem text`,
  // UNITARIO | DEFINIDO | INVALIDO -- INVALIDO alimenta a lista de pendencias de cadastro
  `ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS fator_status text`,
  // Conteudo cru que veio do ERP, para a pendencia mostrar o que precisa ser corrigido la
  `ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS fator_conteudo_bruto text`,
  // Quando foi lido: e o que permite reler so quem nao tem fator ou esta velho
  `ALTER TABLE product_integration_mappings ADD COLUMN IF NOT EXISTS fator_lido_em timestamp without time zone`,

  // A varredura busca quem ainda nao foi lido; sem indice ela varre 5 mil linhas a cada ciclo
  `CREATE INDEX IF NOT EXISTS idx_mappings_fator_pendente
     ON product_integration_mappings (integration_id, fator_lido_em NULLS FIRST)`,
  `CREATE INDEX IF NOT EXISTS idx_mappings_fator_status
     ON product_integration_mappings (integration_id, fator_status)`
];

async function principal() {
  console.log(`Migracao do fator de conversao -- modo: ${executar ? "APLICANDO" : "SIMULACAO"}`);
  if (!executar) console.log("(nada sera alterado; rode com --executar para aplicar)\n");

  const antes = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'product_integration_mappings' AND column_name LIKE 'fator%' OR
           (table_name = 'product_integration_mappings' AND column_name = 'embalagem')`
  );
  console.log(
    `  colunas de fator ja existentes: ${antes.length ? antes.map((c) => c.column_name).join(", ") : "nenhuma"}`
  );

  if (!executar) {
    console.log("\n  DDL que seria aplicada:");
    for (const c of DDL) console.log(`    ${c.trim().split("\n")[0]}`);
    console.log("\nConcluido (SIMULACAO).");
    await pool.end();
    return;
  }

  for (const comando of DDL) await query(comando);

  const depois = await query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'product_integration_mappings'
       AND (column_name LIKE 'fator%' OR column_name = 'embalagem')
     ORDER BY column_name`
  );
  console.log("  -> colunas agora:");
  for (const c of depois) console.log(`     ${c.column_name} (${c.data_type})`);

  const pendentes = await query(
    "SELECT COUNT(*)::int n FROM product_integration_mappings WHERE integration_id = 1 AND fator_lido_em IS NULL"
  );
  console.log(`  -> produtos aguardando leitura do fator: ${pendentes[0].n}`);
  console.log("\nConcluido (APLICANDO).");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

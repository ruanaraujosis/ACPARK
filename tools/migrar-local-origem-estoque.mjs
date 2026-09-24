import "../server/env.js";
import { pool, query } from "../server/db.js";

// Local de estoque de ORIGEM de um pedido (transferência entre PDVs).
//
// Até aqui toda retirada saía do Almoxarifado (produtos.qtd_total). Duas colunas novas, ambas
// NULL = Almoxarifado, então o comportamento de hoje não muda para nenhum pedido existente:
//   - pdvs.local_estoque_padrao_pdv_id: de onde saem, por padrão, os pedidos NOVOS deste PDV;
//   - pedidos.local_origem_pdv_id: de onde sai ESTE pedido (copiado do padrão na criação,
//     editável pelo Almoxarifado enquanto o pedido não foi finalizado).
// Só ADD COLUMN IF NOT EXISTS, sem DEFAULT que reescreva a tabela e sem mexer em dado.
//
// Simulação por padrão; --executar aplica.

const executar = process.argv.includes("--executar");

const DDL = [
  "ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS local_estoque_padrao_pdv_id INTEGER",
  "ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS local_origem_pdv_id INTEGER"
];

// Quais das duas colunas já existem
async function colunasExistentes() {
  const linhas = await query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE (table_name = 'pdvs' AND column_name = 'local_estoque_padrao_pdv_id')
        OR (table_name = 'pedidos' AND column_name = 'local_origem_pdv_id')`
  );
  return linhas.map((l) => `${l.table_name}.${l.column_name}`);
}

async function principal() {
  console.log(`Migracao local de origem do estoque -- modo: ${executar ? "APLICANDO" : "SIMULACAO"}`);
  if (!executar) console.log("(nada sera alterado; rode com --executar para aplicar)\n");

  const antes = await colunasExistentes();
  const [pedidos] = await query("SELECT COUNT(*)::int AS n FROM pedidos");
  const [pdvs] = await query("SELECT COUNT(*)::int AS n FROM pdvs");
  console.log(`  colunas ja existentes: ${antes.length ? antes.join(", ") : "nenhuma"}`);
  console.log(`  linhas: pedidos=${pedidos.n} pdvs=${pdvs.n} (nenhuma e alterada; todas ficam NULL = Almoxarifado)`);

  if (!executar) {
    console.log("\n  DDL que seria aplicada:");
    for (const c of DDL) console.log(`    ${c}`);
    console.log("\nConcluido (SIMULACAO).");
    await pool.end();
    return;
  }

  for (const comando of DDL) await query(comando);
  console.log(`  -> colunas agora: ${(await colunasExistentes()).join(", ")}`);
  console.log("\nConcluido (APLICANDO).");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

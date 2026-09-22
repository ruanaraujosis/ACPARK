import "../server/env.js";
import { pool, query } from "../server/db.js";

// Remove a tabela da planilha de fardos (feature removida em 22/09/2026 -- ela decidia o
// fator sozinha em vários casos, não só corroborava; ver docs/INTEGRACOES.md).
//
// A sequence cai junto (OWNED BY); os dois índices (idx_factor_sheet_produto,
// uq_factor_sheet_nome) também caem junto por serem da própria tabela.
//
// Simulacao por padrao; --executar aplica.

const executar = process.argv.includes("--executar");

const DDL = [`DROP TABLE IF EXISTS integration_factor_sheet`];

async function existe() {
  const linhas = await query(
    `SELECT table_name FROM information_schema.tables WHERE table_name = 'integration_factor_sheet'`
  );
  return linhas.length > 0;
}

async function principal() {
  console.log(`Remocao de integration_factor_sheet -- modo: ${executar ? "APLICANDO" : "SIMULACAO"}`);
  if (!executar) console.log("(nada sera alterado; rode com --executar para aplicar)\n");

  const antes = await existe();
  console.log(`  tabela existe hoje: ${antes ? "sim" : "não"}`);

  if (!antes) {
    console.log("\nNada a fazer -- tabela já não existe.");
    await pool.end();
    return;
  }

  if (!executar) {
    console.log("\n  DDL que seria aplicada:");
    for (const c of DDL) console.log(`    ${c.trim()}`);
    console.log("\nConcluido (SIMULACAO).");
    await pool.end();
    return;
  }

  for (const comando of DDL) await query(comando);

  const depois = await existe();
  console.log(`  -> tabela existe agora: ${depois ? "sim" : "não"}`);
  console.log("\nConcluido (APLICANDO).");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

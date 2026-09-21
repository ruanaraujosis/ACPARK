import "../server/env.js";
import { pool, query } from "../server/db.js";

// Amplia produtos.qtd_total de INTEGER para NUMERIC.
//
// qtd_total e o estoque central (espelho do saldo do Almoxarifado na OMIE). Ate aqui, saldo
// fracionario (itens vendidos a granel) era arredondado ao gravar -- Math.round() em
// gravarEstoqueCentral() e no ajuste manual de saldo, com o valor exato preservado a parte em
// saldo_omie so para a reconciliacao nao acusar diferenca falsa. Decisao do usuario
// (21/09/2026): produto de alimento contado em KG/ML nao pode perder precisao -- qtd_total
// passa a guardar o valor exato, e os dois Math.round() saem do codigo (paralelo a este
// script). Widening de INTEGER para NUMERIC e seguro e nao perde dado.
//
// Simulacao por padrao; --executar aplica.

const executar = process.argv.includes("--executar");

const DDL = [
  `ALTER TABLE produtos ALTER COLUMN qtd_total TYPE NUMERIC USING qtd_total::numeric`
];

async function tipoAtual() {
  const linhas = await query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'produtos' AND column_name = 'qtd_total'`
  );
  return linhas[0] || null;
}

async function principal() {
  console.log(`Migracao produtos.qtd_total -> NUMERIC -- modo: ${executar ? "APLICANDO" : "SIMULACAO"}`);
  if (!executar) console.log("(nada sera alterado; rode com --executar para aplicar)\n");

  const antes = await tipoAtual();
  console.log(`  tipo atual: ${antes ? antes.data_type : "coluna nao encontrada"}`);

  if (!executar) {
    console.log("\n  DDL que seria aplicada:");
    for (const c of DDL) console.log(`    ${c.trim()}`);
    console.log("\nConcluido (SIMULACAO).");
    await pool.end();
    return;
  }

  for (const comando of DDL) await query(comando);

  const depois = await tipoAtual();
  console.log(`  -> tipo agora: ${depois ? depois.data_type : "coluna nao encontrada"}`);
  console.log("\nConcluido (APLICANDO).");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

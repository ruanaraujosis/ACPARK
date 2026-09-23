import "../server/env.js";
import { pool, query } from "../server/db.js";

// Amplia estoque_pdv.quantidade de INTEGER para NUMERIC.
//
// O ajuste de inventario grava a contagem exata (ex.: 6,01 kg) em estoque_pdv.quantidade, mas a
// coluna era INTEGER: o valor fracionario travava a assinatura do inventario do PDV (caso
// Kemily/Cabana). Mesma correcao ja feita em produtos.qtd_total. Widening de INTEGER para
// NUMERIC e seguro e nao perde dado. Nenhuma view depende da coluna (conferido antes).
//
// Simulacao por padrao; --executar aplica.

const executar = process.argv.includes("--executar");

const DDL = [
  `ALTER TABLE estoque_pdv ALTER COLUMN quantidade TYPE NUMERIC USING quantidade::numeric`
];

// Tipo atual da coluna, para mostrar antes/depois
async function tipoAtual() {
  const linhas = await query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'estoque_pdv' AND column_name = 'quantidade'`
  );
  return linhas[0] || null;
}

// Soma e contagem, para provar que a migracao nao mexeu em nenhum valor
async function totais() {
  const [linha] = await query("SELECT COUNT(*)::int AS linhas, COALESCE(SUM(quantidade), 0)::text AS soma FROM estoque_pdv");
  return linha;
}

async function principal() {
  console.log(`Migracao estoque_pdv.quantidade -> NUMERIC -- modo: ${executar ? "APLICANDO" : "SIMULACAO"}`);
  if (!executar) console.log("(nada sera alterado; rode com --executar para aplicar)\n");

  const antes = await tipoAtual();
  const totalAntes = await totais();
  console.log(`  tipo atual: ${antes ? antes.data_type : "coluna nao encontrada"}`);
  console.log(`  linhas: ${totalAntes.linhas} | soma das quantidades: ${totalAntes.soma}`);

  if (!executar) {
    console.log("\n  DDL que seria aplicada:");
    for (const c of DDL) console.log(`    ${c.trim()}`);
    console.log("\nConcluido (SIMULACAO).");
    await pool.end();
    return;
  }

  for (const comando of DDL) await query(comando);

  const depois = await tipoAtual();
  const totalDepois = await totais();
  console.log(`  -> tipo agora: ${depois ? depois.data_type : "coluna nao encontrada"}`);
  console.log(`  -> linhas: ${totalDepois.linhas} | soma: ${totalDepois.soma}`);
  if (totalDepois.linhas !== totalAntes.linhas || totalDepois.soma !== totalAntes.soma) {
    console.error("ATENCAO: totais diferentes depois da migracao!");
    process.exitCode = 1;
  }
  console.log("\nConcluido (APLICANDO).");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

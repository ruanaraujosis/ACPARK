// Corrige os saldos negativos do estoque central com relatório do que seria alterado.
//
// Por padrão roda em SIMULAÇÃO: não escreve nada no banco, só mostra o relatório.
// Para aplicar de verdade é preciso passar --aplicar explicitamente.
//
//   node tools/corrigir-estoque-negativo.mjs                 (simulação, padrão)
//   node tools/corrigir-estoque-negativo.mjs --csv relatorio.csv
//   node tools/corrigir-estoque-negativo.mjs --aplicar       (grava no banco)
//
// Contexto: o estoque central nunca recebeu carga inicial de saldo. Todos os produtos
// entraram em zero e cada retirada foi decrementando a partir daí, então o saldo negativo
// de um produto corresponde ao total já retirado dele. Zerar apenas devolve o saldo ao
// ponto de partida — não inventa estoque. O saldo real precisa ser importado à parte.
import "../server/env.js";
import { writeFileSync } from "node:fs";
import { pool } from "../server/db.js";

const args = process.argv.slice(2);
const aplicar = args.includes("--aplicar");
const csvIndex = args.indexOf("--csv");
const csvPath = csvIndex >= 0 ? args[csvIndex + 1] : "";

// Formata número com sinal, para o relatório ficar legível
const sinal = (valor) => (valor > 0 ? `+${valor}` : String(valor));

async function main() {
  // Levanta os negativos e confronta com o total já retirado em pedidos finalizados
  const { rows } = await pool.query(`
    SELECT p.sku,
           p.nome,
           p.qtd_total,
           COALESCE(p.origem, '') AS origem,
           COALESCE(p.stock_mode, '') AS stock_mode,
           COALESCE(SUM(pe.quantidade_liberada) FILTER (WHERE pe.status = 'Finalizado'), 0)::int AS total_retirado,
           COUNT(DISTINCT pe.codigo_pedido) FILTER (WHERE pe.status = 'Finalizado')::int AS pedidos
    FROM produtos p
    LEFT JOIN pedidos pe ON pe.sku_produto = p.sku
    WHERE p.qtd_total < 0
    GROUP BY p.sku, p.nome, p.qtd_total, p.origem, p.stock_mode
    ORDER BY p.qtd_total ASC
  `);

  if (!rows.length) {
    console.log("Nenhum produto com saldo negativo. Nada a corrigir.");
    return;
  }

  const explicados = rows.filter((r) => r.qtd_total === -r.total_retirado);
  const inexplicados = rows.filter((r) => r.qtd_total !== -r.total_retirado);
  const somaNegativa = rows.reduce((soma, r) => soma + r.qtd_total, 0);

  console.log(`\n=== Saldos negativos no estoque central ===`);
  console.log(`Produtos afetados......: ${rows.length}`);
  console.log(`Soma dos negativos.....: ${somaNegativa}`);
  console.log(`Pior saldo.............: ${rows[0].qtd_total} (${rows[0].nome || rows[0].sku})`);
  console.log(`Explicados pela retirada: ${explicados.length} (saldo = -total já retirado)`);
  console.log(`Sem explicação exata....: ${inexplicados.length}`);
  console.log(`Modo...................: ${aplicar ? "APLICAR (grava no banco)" : "SIMULAÇÃO (não grava nada)"}\n`);

  console.log("Top 15 por impacto:");
  console.log("SKU".padEnd(16) + "SALDO".padStart(8) + "RETIRADO".padStart(10) + "PEDIDOS".padStart(9) + "  PRODUTO");
  for (const row of rows.slice(0, 15)) {
    console.log(
      String(row.sku).padEnd(16)
      + sinal(row.qtd_total).padStart(8)
      + String(row.total_retirado).padStart(10)
      + String(row.pedidos).padStart(9)
      + "  " + String(row.nome || "").slice(0, 46)
    );
  }
  if (rows.length > 15) console.log(`... e mais ${rows.length - 15} produtos.`);

  if (inexplicados.length) {
    console.log(`\nProdutos cujo negativo NÃO bate com o total retirado (conferir antes de aplicar):`);
    for (const row of inexplicados) {
      console.log(`  ${row.sku} | saldo ${row.qtd_total} | retirado ${row.total_retirado} | diferença ${row.qtd_total + row.total_retirado}`);
    }
  }

  // Relatório completo em CSV, para conferência fora do terminal
  if (csvPath) {
    const cabecalho = "sku;nome;saldo_atual;total_retirado;pedidos;origem;stock_mode;saldo_apos_correcao";
    const linhas = rows.map((r) => [
      r.sku,
      String(r.nome || "").replace(/;/g, ","),
      r.qtd_total,
      r.total_retirado,
      r.pedidos,
      r.origem,
      r.stock_mode,
      0
    ].join(";"));
    writeFileSync(csvPath, `﻿${[cabecalho, ...linhas].join("\n")}`, "utf8");
    console.log(`\nRelatório completo gravado em ${csvPath}`);
  }

  if (!aplicar) {
    console.log(`\nNada foi alterado. Para aplicar a correção rode novamente com --aplicar.`);
    console.log(`Atenção: zerar os saldos não cria estoque real. Depois de aplicar, importe os saldos verdadeiros.`);
    return;
  }

  // Aplica em uma única transação: zera os saldos negativos
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await client.query(
      "UPDATE produtos SET qtd_total = 0 WHERE qtd_total < 0 RETURNING sku"
    );
    await client.query("COMMIT");
    console.log(`\n${resultado.rowCount} produtos tiveram o saldo negativo zerado.`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Falha ao aplicar a correção. Nenhuma alteração foi mantida.", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

await main();
await pool.end();

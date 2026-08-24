import "../server/env.js";
import { pool, query } from "../server/db.js";

// Cria a tabela de lancamentos de escrita nas integracoes.
//
// Aditiva de proposito: nao altera nenhuma tabela que o caminho de leitura ja usa. Cada linha
// e um lancamento que o MyEstoque deve enviar (ou ja enviou) para o sistema externo, com tudo
// que a rastreabilidade exige -- pedido de origem, item, quantidade, locais, payload, resposta,
// chave de idempotencia e resultado.
//
// Roda em simulacao por padrao; --executar aplica.

const executar = process.argv.includes("--executar");

const DDL = [
  `CREATE TABLE IF NOT EXISTS integration_stock_launches (
     id bigserial PRIMARY KEY,
     integration_id bigint,
     codigo_pedido text NOT NULL,
     pedido_item_id bigint,
     sku_produto text NOT NULL,
     pdv_id integer,
     quantidade numeric NOT NULL,
     local_origem text,
     local_destino text,
     evento text NOT NULL,
     idempotency_key text NOT NULL,
     modo text NOT NULL DEFAULT 'SIMULACAO',
     status text NOT NULL DEFAULT 'PENDENTE',
     payload jsonb,
     resposta jsonb,
     external_id text,
     erro text,
     tentativas integer NOT NULL DEFAULT 0,
     enviado_em timestamp without time zone,
     created_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,

  // A chave de idempotencia e o que impede reprocessar a fila de duplicar movimento
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_launches_idempotency
     ON integration_stock_launches (idempotency_key)`,

  // A tela do pedido busca por codigo; a fila busca por status
  `CREATE INDEX IF NOT EXISTS idx_stock_launches_pedido
     ON integration_stock_launches (codigo_pedido)`,
  `CREATE INDEX IF NOT EXISTS idx_stock_launches_status
     ON integration_stock_launches (status, created_at)`
];

async function principal() {
  console.log(`Migracao de escrita das integracoes -- modo: ${executar ? "APLICANDO" : "SIMULACAO"}`);
  if (!executar) console.log("(nada sera alterado; rode com --executar para aplicar)\n");

  const existe = await query("SELECT to_regclass('public.integration_stock_launches') AS tabela");
  console.log(`  tabela integration_stock_launches: ${existe[0].tabela ? "ja existe" : "sera criada"}`);

  if (!executar) {
    console.log("\n  DDL que seria aplicada:");
    for (const comando of DDL) console.log(`    ${comando.trim().split("\n")[0]}...`);
    console.log("\nConcluido (SIMULACAO).");
    await pool.end();
    return;
  }

  for (const comando of DDL) await query(comando);

  const colunas = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'integration_stock_launches' ORDER BY ordinal_position`
  );
  console.log(`  -> tabela pronta com ${colunas.length} colunas`);

  // Dono correto: sem isso o RLS herdado do Supabase faz quem nao e dono ler zero linhas
  const dono = process.env.DATABASE_URL?.match(/\/\/([^:]+):/)?.[1] || "myestoque_app";
  await query(`ALTER TABLE integration_stock_launches OWNER TO ${dono}`).catch(() => {});
  await query(`ALTER SEQUENCE integration_stock_launches_id_seq OWNER TO ${dono}`).catch(() => {});
  console.log(`  -> dono ajustado para ${dono}`);

  console.log("\nConcluido (APLICANDO).");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

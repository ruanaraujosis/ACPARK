// Migracao pontual: remove o default inseguro de pdvs.senha e apaga 9 tabelas sem uso.
//
// Contexto: as 9 tabelas nao sao criadas nem lidas por nenhum ponto do codigo -- sao residuo de
// versoes antigas (impressao automatica, antecessoras de pedido_auditoria/pedido_idempotencia e
// um snapshot de permissoes da epoca do Supabase). O default '123' em pdvs.senha seria embarcado
// em toda instalacao nova.
//
// Roda tudo em transacao unica: ou aplica inteiro, ou nao aplica nada.
//
// Uso:
//   node tools/migracao-limpeza-tabelas-mortas.mjs           (simulacao, nao grava)
//   node tools/migracao-limpeza-tabelas-mortas.mjs --aplicar (aplica de verdade)
import "../server/env.js";

const db = await import("../server/db.js");
const aplicar = process.argv.includes("--aplicar");

const TABELAS_MORTAS = [
  "logs_atividades",
  "pedido_historico",
  "pedido_impressao_historico",
  "pedido_impressao_jobs",
  "pedido_operacao_idempotencia",
  "security_hardening_backup_privileges",
  "solicitacoes",
  "stock_refresh_queue",
  "vendas_orion"
];

// Confere que nada vivo depende das tabelas antes de apaga-las
const dependencias = await db.query(
  `SELECT tc.table_name AS origem, ccu.table_name AS destino
   FROM information_schema.table_constraints tc
   JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type = 'FOREIGN KEY'
     AND ccu.table_name = ANY($1::text[])
     AND tc.table_name <> ALL($1::text[])`,
  [TABELAS_MORTAS]
);
if (dependencias.length) {
  console.error("ABORTADO: existem tabelas vivas apontando para as que seriam apagadas:");
  for (const d of dependencias) console.error(`  ${d.origem} -> ${d.destino}`);
  process.exit(1);
}

// Estado antes, para o relatorio
const antes = await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'");
const defaultAntes = await db.query(
  `SELECT column_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'pdvs' AND column_name = 'senha'`
);
const existentes = await db.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename",
  [TABELAS_MORTAS]
);

console.log(aplicar ? "=== APLICANDO ===" : "=== SIMULACAO (use --aplicar para valer) ===");
console.log("Tabelas antes:", antes[0].n);
console.log("Default atual de pdvs.senha:", defaultAntes[0]?.column_default ?? "(nenhum)");
console.log("Tabelas mortas encontradas:", existentes.length);
for (const t of existentes) console.log("  -", t.tablename);

if (!aplicar) {
  console.log("\nNada foi alterado.");
  process.exit(0);
}

await db.tx(async (client) => {
  // Remove o default '123': o codigo sempre exige e criptografa a senha ao criar PDV,
  // entao nada depende desse valor -- ele so serviria para insercao direta via SQL
  await client.query("ALTER TABLE pdvs ALTER COLUMN senha DROP DEFAULT");
  // Apaga as tabelas sem uso (ja conferido que nada vivo depende delas)
  for (const tabela of existentes.map((t) => t.tablename)) {
    await client.query(`DROP TABLE IF EXISTS public.${tabela}`);
  }
});

// Confirma o resultado
const depois = await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'");
const defaultDepois = await db.query(
  `SELECT column_default FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'pdvs' AND column_name = 'senha'`
);
const restantes = await db.query(
  "SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
  [TABELAS_MORTAS]
);
// Sanidade: os dados de verdade continuam intactos
const pedidos = await db.query("SELECT count(*)::int n FROM pedidos");
const produtos = await db.query("SELECT count(*)::int n FROM produtos");
const pdvs = await db.query("SELECT count(*)::int n FROM pdvs");

console.log("\n=== RESULTADO ===");
console.log("Tabelas:", antes[0].n, "->", depois[0].n);
console.log("Default de pdvs.senha:", defaultDepois[0]?.column_default ?? "(removido)");
console.log("Tabelas mortas restantes:", restantes[0].n);
console.log("Dados intactos -> pedidos:", pedidos[0].n, "| produtos:", produtos[0].n, "| pdvs:", pdvs[0].n);
process.exit(0);

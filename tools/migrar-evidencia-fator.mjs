import "../server/env.js";
import { pool, query } from "../server/db.js";

// Cria as tabelas do assistente de fator: evidencia documental colhida dos documentos de
// compra do ERP, e a decisao humana tomada em cima dela.
//
// Duas tabelas em vez de colunas novas em product_integration_mappings porque um produto tem
// VARIAS evidencias (a mesma caixa aparece em dezenas de notas, e o mesmo produto pode ser
// comprado em mais de um formato de embalagem). Achatar isso numa coluna so perderia
// justamente o conflito, que e o sinal mais importante -- ver docs/INTEGRACOES.md.
//
// Aditiva: nao toca em nada que ja existe. Simulacao por padrao; --executar aplica.

const executar = process.argv.includes("--executar");

const DDL = [
  // Uma linha por (produto, fator observado). O mesmo produto com dois fatores = duas linhas,
  // e e exatamente esse par que impede a sugestao automatica.
  `CREATE TABLE IF NOT EXISTS integration_factor_evidence (
     id bigserial PRIMARY KEY,
     integration_id bigint NOT NULL,
     external_product_id text NOT NULL,
     fator integer NOT NULL,
     vezes integer NOT NULL DEFAULT 0,
     primeira_em date,
     ultima_em date,
     documento jsonb,
     atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
   )`,
  // Sem a unicidade a varredura duplicaria a evidencia a cada releitura do historico
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_factor_evidence
     ON integration_factor_evidence (integration_id, external_product_id, fator)`,
  `CREATE INDEX IF NOT EXISTS idx_factor_evidence_produto
     ON integration_factor_evidence (integration_id, external_product_id)`,

  // A decisao de uma pessoa sobre a sugestao. Separada da evidencia de proposito: reler o
  // historico nunca pode apagar o que alguem ja conferiu e aprovou.
  `CREATE TABLE IF NOT EXISTS integration_factor_decisions (
     id bigserial PRIMARY KEY,
     integration_id bigint NOT NULL,
     external_product_id text NOT NULL,
     status text NOT NULL,
     fator_sugerido integer,
     fator_decidido integer,
     decidido_por text,
     decidido_em timestamp without time zone,
     escrito_em timestamp without time zone,
     erro text,
     criado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
     atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_factor_decisions
     ON integration_factor_decisions (integration_id, external_product_id)`,
  // A tela de revisao filtra por status; a de escrita busca so os aprovados ainda nao escritos
  `CREATE INDEX IF NOT EXISTS idx_factor_decisions_status
     ON integration_factor_decisions (integration_id, status)`,

  // Auditoria da gravacao: sem o valor anterior nao da para desfazer nem para saber se o
  // assistente sobrescreveu algo que alguem tinha conferido a mao no ERP.
  `ALTER TABLE integration_factor_decisions ADD COLUMN IF NOT EXISTS valor_anterior text`,
  // Payload enviado e resposta recebida: e o que permite conferir uma gravacao meses depois
  // sem depender de log de servidor, e o que a tela mostra quando algo da errado.
  `ALTER TABLE integration_factor_decisions ADD COLUMN IF NOT EXISTS payload jsonb`,
  `ALTER TABLE integration_factor_decisions ADD COLUMN IF NOT EXISTS resposta jsonb`,
  // Qual operacao foi usada (incluir ou alterar) -- muda o que aconteceu no cadastro
  `ALTER TABLE integration_factor_decisions ADD COLUMN IF NOT EXISTS operacao text`,
  // Evidencia congelada no momento da aprovacao: a varredura seguinte pode mudar a evidencia,
  // e a auditoria precisa dizer em que base a pessoa decidiu naquele dia.
  `ALTER TABLE integration_factor_decisions ADD COLUMN IF NOT EXISTS evidencia jsonb`,

  // Planilha de controle de fardos: fonte de CORROBORACAO, separada da evidencia das notas.
  //
  // Tabela propria porque a planilha e chaveada por NOME DE OPERACAO, nao por SKU
  // ("AGUA MINERAL GASOSA 500ML" na planilha contra "AGUA COM GAS" na OMIE). Enquanto ninguem
  // confirmar o vinculo, a linha existe sem produto -- e vincular e ato humano, nunca
  // automatico, porque o casamento e textual e aproximado.
  `CREATE TABLE IF NOT EXISTS integration_factor_sheet (
     id bigserial PRIMARY KEY,
     integration_id bigint NOT NULL,
     nome_operacao text NOT NULL,
     fator integer,
     divergente boolean NOT NULL DEFAULT FALSE,
     valores_por_aba jsonb,
     secao text,
     external_product_id text,
     vinculado_por text,
     vinculado_em timestamp without time zone,
     importado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
     atualizado_em timestamp without time zone DEFAULT CURRENT_TIMESTAMP
   )`,
  // Uma linha por nome de operacao: reimportar a planilha atualiza, nunca duplica
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_factor_sheet_nome
     ON integration_factor_sheet (integration_id, nome_operacao)`,
  // A derivacao busca a linha pelo produto ja vinculado
  `CREATE INDEX IF NOT EXISTS idx_factor_sheet_produto
     ON integration_factor_sheet (integration_id, external_product_id)`
];

async function principal() {
  console.log(`Migracao do assistente de fator -- modo: ${executar ? "APLICANDO" : "SIMULACAO"}`);
  if (!executar) console.log("(nada sera alterado; rode com --executar para aplicar)\n");

  const existentes = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('integration_factor_evidence', 'integration_factor_decisions')
     ORDER BY 1`
  );
  console.log(
    `  tabelas ja existentes: ${existentes.length ? existentes.map((t) => t.table_name).join(", ") : "nenhuma"}`
  );

  if (!executar) {
    console.log("\n  DDL que seria aplicada:");
    for (const c of DDL) console.log(`    ${c.trim().split("\n")[0].trim()}`);
    console.log("\nConcluido (SIMULACAO).");
    await pool.end();
    return;
  }

  for (const comando of DDL) await query(comando);

  // Restore de backup entra sem dono; sem isso a RLS herdada do Supabase esconde tudo
  for (const tabela of [
    "integration_factor_evidence",
    "integration_factor_decisions",
    "integration_factor_sheet"
  ]) {
    await query(`ALTER TABLE ${tabela} OWNER TO myestoque_app`);
    await query(`ALTER SEQUENCE ${tabela}_id_seq OWNER TO myestoque_app`);
  }

  const depois = await query(
    `SELECT table_name, COUNT(*)::int AS colunas
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('integration_factor_evidence', 'integration_factor_decisions', 'integration_factor_sheet')
     GROUP BY table_name ORDER BY 1`
  );
  console.log("  -> tabelas agora:");
  for (const t of depois) console.log(`     ${t.table_name} (${t.colunas} colunas)`);

  console.log("\nConcluido (APLICANDO).");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha na migracao:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

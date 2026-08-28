// Estrutura das tabelas de inventário (contagem física de estoque).
//
// Segue o padrão do resto do sistema: função memoizada, criada sob demanda pela primeira rota
// que precisa dela, e registrada em ensureAllRuntimeTables() para que um restore de backup
// antigo não dependa de qual tela alguém abre primeiro.
//
// Por que tabelas novas e não as que já existem: stock_reconciliations/_items pertencem à
// capacidade RECONCILIACAO (compara espelho local × OMIE e registra divergência, sem contagem
// física nem ciclo de vida); stock_movements/_items são espelho de LEITURA do que a OMIE
// devolve. Nenhuma modela contagem com ciclo de vida e assinatura, e reaproveitá-las
// colidiria com funções vivas.
import { tx } from "../../db.js";

let inventarioTablesReady = null;

// Estados do inventário, em ordem. Explícitos de propósito: nada é deduzido de campo nulo,
// igual ao fluxo de status do pedido.
export const STATUS_INVENTARIO = Object.freeze({
  EM_CONTAGEM: "Em contagem",
  ENVIADO: "Enviado",
  AGUARDANDO_ASSINATURA: "Aguardando assinatura",
  CONFIRMADO: "Confirmado"
});

// Estados em que o inventário ainda ocupa a vaga do PDV (um aberto por vez)
export const STATUS_ABERTOS = Object.freeze([
  STATUS_INVENTARIO.EM_CONTAGEM,
  STATUS_INVENTARIO.ENVIADO,
  STATUS_INVENTARIO.AGUARDANDO_ASSINATURA
]);

// Chaves em `configuracoes` que controlam a janela de contagem
export const CHAVE_BLOQUEIO = "inventario_bloqueado";
export const CHAVE_AGENDAMENTO = "inventario_agendado_para";

export function ensureInventarioTables() {
  inventarioTablesReady ||= tx(async (client) => {
    // Cabeçalho da contagem. pdv_id nulo = inventário do próprio Almoxarifado, mesma convenção
    // que stock_movements.pdv_id já usa para distinguir almoxarifado de PDV.
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventarios (
        id SERIAL PRIMARY KEY,
        codigo_inventario TEXT NOT NULL UNIQUE,
        pdv_id INTEGER,
        status TEXT NOT NULL DEFAULT '${STATUS_INVENTARIO.EM_CONTAGEM}',
        criado_por TEXT,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        enviado_por TEXT,
        enviado_em TIMESTAMP,
        confirmado_por TEXT,
        confirmado_em TIMESTAMP,
        assinatura_imagem TEXT,
        assinado_por TEXT,
        assinado_em TIMESTAMP,
        ajuste_aplicado_em TIMESTAMP,
        observacao TEXT,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    // Um item por produto contado.
    //
    // quantidade_contada NULL é "não contado" e é diferente de 0, que só existe se a pessoa
    // digitou. Essa distinção decide se o produto é tocado na OMIE: não contado não é tocado,
    // contado como zero é zerado. Por isso a coluna aceita NULL e não tem DEFAULT 0.
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventario_itens (
        id SERIAL PRIMARY KEY,
        inventario_id INTEGER REFERENCES inventarios(id) ON DELETE CASCADE,
        sku_produto TEXT,
        quantidade_contada NUMERIC,
        contado_em TIMESTAMP,
        quantidade_anterior NUMERIC,
        origem TEXT DEFAULT 'PDV',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (inventario_id, sku_produto)
      )`);

    // Trilha de edição: toda alteração do Almoxarifado guarda valor anterior e novo
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventario_auditoria (
        id SERIAL PRIMARY KEY,
        inventario_id INTEGER,
        codigo_inventario TEXT,
        item_id INTEGER,
        sku_produto TEXT,
        acao TEXT NOT NULL,
        usuario TEXT,
        valor_anterior TEXT,
        valor_novo TEXT,
        observacao TEXT,
        dados JSONB DEFAULT '{}'::jsonb,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    // Avisos exibidos aos PDVs (agendamento de inventário e avisos manuais do Almoxarifado)
    await client.query(`
      CREATE TABLE IF NOT EXISTS avisos (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL DEFAULT 'MANUAL',
        titulo TEXT,
        mensagem TEXT NOT NULL,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        criado_por TEXT,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expira_em TIMESTAMP
      )`);

    // Um inventário aberto por PDV por vez. COALESCE(-1) porque pdv_id nulo (almoxarifado)
    // não seria restringido por índice único — NULLs são distintos entre si no Postgres.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inventario_aberto_por_pdv
        ON inventarios (COALESCE(pdv_id, -1))
        WHERE status IN ('${STATUS_ABERTOS.join("', '")}')`);

    await client.query("CREATE INDEX IF NOT EXISTS idx_inventario_itens_inventario ON inventario_itens(inventario_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_inventario_auditoria_inventario ON inventario_auditoria(inventario_id, criado_em DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_inventarios_status ON inventarios(status, criado_em DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_avisos_ativo ON avisos(ativo, criado_em DESC) WHERE ativo");
  });
  return inventarioTablesReady;
}

// Grava uma linha na trilha de auditoria do inventário
export async function auditarInventario(client, { inventarioId, codigoInventario, itemId, sku, acao, usuario, valorAnterior, valorNovo, observacao, dados }) {
  await client.query(
    `INSERT INTO inventario_auditoria
      (inventario_id, codigo_inventario, item_id, sku_produto, acao, usuario, valor_anterior, valor_novo, observacao, dados)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      inventarioId || null,
      codigoInventario || null,
      itemId || null,
      sku || null,
      acao,
      usuario || null,
      valorAnterior === null || valorAnterior === undefined ? null : String(valorAnterior),
      valorNovo === null || valorNovo === undefined ? null : String(valorNovo),
      observacao || null,
      JSON.stringify(dados || {})
    ]
  );
}

// Estrutura das tabelas do MyControl (prefixo mc_).
//
// Tudo aditivo: só tabelas novas, nenhuma tabela do MyEstoque é tocada. Segue o padrão do
// resto do sistema -- função memoizada, chamada pelas rotas do MyControl e registrada em
// ensureAllRuntimeTables() para que um restore de backup antigo recupere as tabelas.
//
// DATAS: as colunas novas são TIMESTAMPTZ DEFAULT now(), DIFERENTE de propósito das tabelas
// antigas (timestamp without time zone, lidas como texto cru pelo parser do tipo 1114 em
// server/db.js). Com fuso gravado, o instante é inequívoco; a tela exibe em America/Sao_Paulo.
import { tx } from "../../db.js";

let tabelasProntas = null;

// Cria as tabelas mc_ se ainda não existirem. Se falhar (banco fora do ar, por exemplo), a
// promessa rejeitada não fica memoizada -- a próxima chamada tenta de novo.
export function ensureMyControlTables() {
  tabelasProntas ||= tx(async (client) => {
    // Usuários do MyControl: independentes dos perfis do MyEstoque (Almoxarifado/PDV).
    // `usuario` é o login, sempre minúsculo (o CHECK garante que a unicidade não dependa de caixa).
    await client.query(`
      CREATE TABLE IF NOT EXISTS mc_usuarios (
        id SERIAL PRIMARY KEY,
        usuario TEXT NOT NULL UNIQUE CHECK (usuario = lower(usuario)),
        nome TEXT NOT NULL,
        senha TEXT NOT NULL,
        permissoes TEXT[] NOT NULL DEFAULT '{}',
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        criado_por INTEGER REFERENCES mc_usuarios(id) ON DELETE SET NULL,
        ultimo_login_em TIMESTAMPTZ
      )`);

    // Trilha de auditoria do MyControl, no padrão de inventario_auditoria: quem fez, o quê,
    // em qual entidade, estado antes/depois e motivo. Nunca guarda hash de senha.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mc_auditoria (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER,
        usuario TEXT,
        acao TEXT NOT NULL,
        entidade TEXT NOT NULL,
        entidade_id TEXT,
        antes JSONB,
        depois JSONB,
        motivo TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    await client.query("CREATE INDEX IF NOT EXISTS idx_mc_auditoria_entidade ON mc_auditoria(entidade, entidade_id, criado_em DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_mc_auditoria_criado_em ON mc_auditoria(criado_em DESC)");
  }).catch((erro) => {
    tabelasProntas = null;
    throw erro;
  });
  return tabelasProntas;
}

// Grava uma linha na auditoria do MyControl, dentro da transação de quem chamou
export async function registrarAuditoria(client, { ator, acao, entidade, entidadeId, antes, depois, motivo }) {
  await client.query(
    `INSERT INTO mc_auditoria (usuario_id, usuario, acao, entidade, entidade_id, antes, depois, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ator?.id || null,
      ator?.usuario || null,
      acao,
      entidade,
      entidadeId === null || entidadeId === undefined ? null : String(entidadeId),
      antes === undefined || antes === null ? null : JSON.stringify(antes),
      depois === undefined || depois === null ? null : JSON.stringify(depois),
      motivo || null
    ]
  );
}

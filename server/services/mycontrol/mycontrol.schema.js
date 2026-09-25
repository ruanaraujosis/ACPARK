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
import { ENTIDADES, camposDoSistema } from "./campos.catalogo.js";

let tabelasProntas = null;

// Fase 2: arquivos (fotos e assinaturas), campos configuráveis, cargos e os três cadastros
async function criarTabelasDeCadastro(client) {
  // Fotos e assinaturas: o binário fica no storage (mesmo serviço das fotos de avaria); aqui
  // só a chave e os metadados. Nunca base64 no banco. A miniatura é gerada no navegador e
  // enviada à parte, para a lista não baixar a foto grande.
  await client.query(`
    CREATE TABLE IF NOT EXISTS mc_arquivos (
      id SERIAL PRIMARY KEY,
      entidade TEXT NOT NULL,
      papel TEXT NOT NULL CHECK (papel IN ('foto', 'assinatura')),
      storage_key TEXT NOT NULL,
      mime TEXT NOT NULL,
      tamanho INTEGER NOT NULL,
      largura INTEGER,
      altura INTEGER,
      sha256 TEXT NOT NULL,
      miniatura_key TEXT,
      miniatura_mime TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  // Campos de cada cadastro. Exclusão é LÓGICA (excluido_em): a linha fica, então a chave
  // nunca é reaproveitada e o seed (ON CONFLICT DO NOTHING) não recria um campo apagado.
  await client.query(`
    CREATE TABLE IF NOT EXISTS mc_campos (
      id SERIAL PRIMARY KEY,
      entidade TEXT NOT NULL CHECK (entidade IN ('${Object.keys(ENTIDADES).join("', '")}')),
      chave TEXT NOT NULL CHECK (chave ~ '^[a-z][a-z0-9_]{0,59}$'),
      rotulo TEXT NOT NULL,
      tipo TEXT NOT NULL,
      opcoes JSONB NOT NULL DEFAULT '[]'::jsonb,
      obrigatorio BOOLEAN NOT NULL DEFAULT FALSE,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      sistema BOOLEAN NOT NULL DEFAULT FALSE,
      travado BOOLEAN NOT NULL DEFAULT FALSE,
      excluido_em TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      criado_por INTEGER,
      atualizado_em TIMESTAMPTZ,
      UNIQUE (entidade, chave)
    )`);

  // Cargos: a abreviação (2 a 6 letras maiúsculas) vira o prefixo da matrícula
  await client.query(`
    CREATE TABLE IF NOT EXISTS mc_cargos (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      abreviacao TEXT NOT NULL UNIQUE CHECK (abreviacao ~ '^[A-Z]{2,6}$'),
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      criado_por INTEGER,
      atualizado_em TIMESTAMPTZ
    )`);
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS mc_cargos_nome_unico ON mc_cargos (lower(nome))");

  // Numeração da matrícula: UMA sequence para todos os cargos. Número queimado (transação que
  // falhou, colaborador desativado) nunca volta -- a matrícula nunca é reaproveitada.
  await client.query("CREATE SEQUENCE IF NOT EXISTS mc_matricula_seq START 1");

  await client.query(`
    CREATE TABLE IF NOT EXISTS mc_colaboradores (
      id SERIAL PRIMARY KEY,
      matricula TEXT NOT NULL UNIQUE CHECK (matricula ~ '^[A-Z]{2,6}-[0-9]{6,}$'),
      matricula_numero BIGINT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      cargo_id INTEGER NOT NULL REFERENCES mc_cargos(id) ON DELETE RESTRICT,
      assinatura_id INTEGER REFERENCES mc_arquivos(id),
      foto_id INTEGER REFERENCES mc_arquivos(id),
      dados JSONB NOT NULL DEFAULT '{}'::jsonb,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      criado_por INTEGER,
      atualizado_em TIMESTAMPTZ,
      atualizado_por INTEGER
    )`);
  await client.query("CREATE INDEX IF NOT EXISTS idx_mc_colaboradores_cargo ON mc_colaboradores(cargo_id)");

  // Matrícula imutável também no banco: a API já recusa, e o gatilho garante que nem um UPDATE
  // direto (script, correção manual) troque o número de um colaborador
  await client.query(`
    CREATE OR REPLACE FUNCTION mc_matricula_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.matricula IS DISTINCT FROM OLD.matricula OR NEW.matricula_numero IS DISTINCT FROM OLD.matricula_numero THEN
        RAISE EXCEPTION 'A matricula do colaborador nao pode ser alterada.';
      END IF;
      RETURN NEW;
    END $$`);
  await client.query(`
    CREATE OR REPLACE TRIGGER mc_colaboradores_matricula_imutavel
      BEFORE UPDATE ON mc_colaboradores
      FOR EACH ROW EXECUTE FUNCTION mc_matricula_imutavel()`);

  // Veículos: placa sempre normalizada (AAA9999 antigo ou AAA9A99 Mercosul, sem hífen)
  await client.query(`
    CREATE TABLE IF NOT EXISTS mc_veiculos (
      id SERIAL PRIMARY KEY,
      numero_chave TEXT NOT NULL,
      nome TEXT NOT NULL,
      placa TEXT NOT NULL CHECK (placa ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
      foto_id INTEGER REFERENCES mc_arquivos(id),
      descricao TEXT,
      dados JSONB NOT NULL DEFAULT '{}'::jsonb,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      criado_por INTEGER,
      atualizado_em TIMESTAMPTZ,
      atualizado_por INTEGER
    )`);
  // Número da chave e placa únicos só entre os ATIVOS: um veículo baixado libera a chave
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS mc_veiculos_chave_ativa ON mc_veiculos (numero_chave) WHERE ativo");
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS mc_veiculos_placa_ativa ON mc_veiculos (placa) WHERE ativo");

  // Ferramentas: identificador único sempre (inclusive entre as desativadas)
  await client.query(`
    CREATE TABLE IF NOT EXISTS mc_ferramentas (
      id SERIAL PRIMARY KEY,
      identificador TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      foto_id INTEGER REFERENCES mc_arquivos(id),
      descricao TEXT,
      dados JSONB NOT NULL DEFAULT '{}'::jsonb,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      criado_por INTEGER,
      atualizado_em TIMESTAMPTZ,
      atualizado_por INTEGER
    )`);
}

// Semeia os campos do sistema. Roda a cada boot, então é idempotente e NUNCA desfaz o que o
// usuário mudou (rótulo, ordem, obrigatoriedade, campo desativado): ON CONFLICT DO NOTHING só
// insere o que ainda não existe e não toca nas linhas que já estão lá.
async function semearCamposDoSistema(client) {
  for (const entidade of Object.keys(ENTIDADES)) {
    const campos = camposDoSistema(entidade);
    for (const [indice, campo] of campos.entries()) {
      await client.query(
        `INSERT INTO mc_campos (entidade, chave, rotulo, tipo, obrigatorio, ordem, sistema, travado)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
         ON CONFLICT (entidade, chave) DO NOTHING`,
        [entidade, campo.chave, campo.rotulo, campo.tipo, Boolean(campo.obrigatorio), (indice + 1) * 10, Boolean(campo.travado)]
      );
    }
  }
}

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

    // Fase 2: quando a senha foi redefinida. Token emitido antes disso deixa de valer
    // (requireMcUser compara com o `iat`), então redefinir a senha derruba as sessões abertas.
    await client.query("ALTER TABLE mc_usuarios ADD COLUMN IF NOT EXISTS senha_alterada_em TIMESTAMPTZ");

    await criarTabelasDeCadastro(client);
    await semearCamposDoSistema(client);
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

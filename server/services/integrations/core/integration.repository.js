import { CODIGOS_ERRO, IntegrationError } from "./errors.js";
import { decryptSecret, encryptSecret, maskSecret } from "./integration.security.js";
import { obterProvider } from "./provider-registry.js";

// Acesso as tabelas genericas de integracao (integrations + integration_credentials).
// Nada aqui conhece OMIE: o que e especifico de cada API mora na pasta do provider.

// Le uma integracao pelo id, sem credenciais
export async function obterIntegracao(client, id) {
  const resultado = await client.query("SELECT * FROM integrations WHERE id = $1 LIMIT 1", [id]);
  return resultado.rows[0] || null;
}

export async function listarIntegracoes(client) {
  const resultado = await client.query("SELECT * FROM integrations ORDER BY provedor, nome");
  return resultado.rows;
}

// Lista apenas as integracoes que o agendador deve considerar
export async function listarIntegracoesAtivas(client) {
  const resultado = await client.query("SELECT * FROM integrations WHERE ativo = TRUE ORDER BY id");
  return resultado.rows;
}

// Carrega a integracao junto com as credenciais ja descriptografadas.
// Usado por qualquer coisa que va efetivamente chamar a API externa.
export async function carregarComSegredos(client, id) {
  const integracao = await obterIntegracao(client, id);
  if (!integracao) {
    throw new IntegrationError("Integracao nao encontrada.", {
      codigo: CODIGOS_ERRO.CONFIGURACAO,
      status: 404
    });
  }
  const credenciais = await client.query(
    "SELECT credential_key, encrypted_value FROM integration_credentials WHERE integration_id = $1",
    [id]
  );
  const segredos = {};
  for (const linha of credenciais.rows) {
    try {
      segredos[linha.credential_key] = decryptSecret(linha.encrypted_value);
    } catch (erro) {
      // Chave de criptografia trocada ou credencial corrompida: e erro de configuracao, nao
      // adianta retentar. Antes isso caia no catch generico e o job repetia para sempre com
      // a mensagem "Unsupported state or unable to authenticate data".
      throw new IntegrationError(
        `Nao foi possivel ler a credencial "${linha.credential_key}". Confira INTEGRATION_ENCRYPTION_KEY e cadastre a credencial de novo.`,
        {
          codigo: CODIGOS_ERRO.CONFIGURACAO,
          status: 400,
          detalhes: { causa: erro?.message }
        }
      );
    }
  }
  return { integracao, segredos };
}

// Confere se todas as credenciais obrigatorias declaradas pelo provider estao preenchidas
export function validarCredenciaisObrigatorias(provider, segredos = {}) {
  const faltando = (provider.credenciais || [])
    .filter((credencial) => credencial.obrigatoria !== false && !segredos[credencial.chave])
    .map((credencial) => credencial.rotulo || credencial.chave);
  if (faltando.length) {
    throw new IntegrationError(`Configure ${faltando.join(" e ")} antes de sincronizar.`, {
      codigo: CODIGOS_ERRO.CONFIGURACAO,
      status: 400
    });
  }
}

// Confere os ajustes que UMA capacidade exige, nao os do provider inteiro.
//
// A diferenca importa: exigir toda configuracao obrigatoria antes de qualquer job criaria um
// impasse, porque a tarefa que importa os locais e justamente a que precisa rodar antes de
// alguem conseguir escolher qual local e o almoxarifado.
export function validarConfiguracaoDaCapacidade(provider, configuracao = {}, capacidade = null) {
  const exigidas = capacidade?.requerConfiguracao || [];
  const faltando = exigidas
    .filter((chave) => !configuracao?.[chave])
    .map((chave) => (provider.configuracoes || []).find((item) => item.chave === chave)?.rotulo || chave);
  if (faltando.length) {
    throw new IntegrationError(`Configure ${faltando.join(" e ")} nesta integracao antes de sincronizar.`, {
      codigo: CODIGOS_ERRO.CONFIGURACAO,
      status: 400
    });
  }
}

// Cria ou atualiza uma integracao. Sem id, o upsert usa provedor+ambiente para nao
// duplicar a mesma API duas vezes por engano.
export async function salvarIntegracao(client, dados, { autor = null } = {}) {
  const existente = dados.id
    ? await client.query("SELECT id FROM integrations WHERE id = $1 LIMIT 1", [dados.id])
    : await client.query("SELECT id FROM integrations WHERE provedor = $1 AND ambiente = $2 ORDER BY id LIMIT 1", [
        dados.provedor,
        dados.ambiente
      ]);

  const parametros = [
    dados.nome,
    dados.provedor,
    dados.tipo,
    dados.ambiente,
    dados.urlBase,
    dados.empresaVinculada,
    dados.ativo,
    dados.stockMode,
    JSON.stringify(dados.syncIntervals || {}),
    JSON.stringify(dados.configuracao || {}),
    autor
  ];

  if (existente.rows[0]) {
    const resultado = await client.query(
      `UPDATE integrations
       SET nome = $2, provedor = $3, tipo = $4, ambiente = $5, url_base = $6,
           empresa_vinculada = $7, ativo = $8, stock_mode = $9,
           sync_intervals = $10::jsonb, configuracao = $11::jsonb,
           updated_by = $12, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [existente.rows[0].id, ...parametros]
    );
    return resultado.rows[0];
  }

  const resultado = await client.query(
    `INSERT INTO integrations
       (nome, provedor, tipo, ambiente, url_base, empresa_vinculada, ativo, stock_mode,
        sync_intervals, configuracao, created_by, updated_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $11, 'PENDENTE')
     RETURNING *`,
    parametros
  );
  return resultado.rows[0];
}

// Grava apenas as credenciais enviadas (campo vazio = manter a atual), sempre criptografadas
export async function salvarCredenciais(client, integrationId, valores = {}) {
  const gravadas = [];
  for (const [chave, valor] of Object.entries(valores)) {
    if (valor === undefined || valor === null || valor === "") continue;
    await client.query(
      `INSERT INTO integration_credentials (integration_id, credential_key, encrypted_value, masked_value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (integration_id, credential_key) DO UPDATE
       SET encrypted_value = EXCLUDED.encrypted_value,
           masked_value = EXCLUDED.masked_value,
           updated_at = CURRENT_TIMESTAMP`,
      [integrationId, chave, encryptSecret(valor), maskSecret(valor)]
    );
    gravadas.push(chave);
  }
  return gravadas;
}

export async function listarCredenciaisMascaradas(client, integrationId = null) {
  const resultado = integrationId
    ? await client.query(
        "SELECT integration_id, credential_key, masked_value FROM integration_credentials WHERE integration_id = $1",
        [integrationId]
      )
    : await client.query("SELECT integration_id, credential_key, masked_value FROM integration_credentials");
  return resultado.rows;
}

// Marca sucesso de sincronizacao e limpa o ultimo erro
export async function registrarSucesso(client, integrationId) {
  await client.query(
    `UPDATE integrations
     SET status = 'CONECTADO', ultima_sincronizacao = CURRENT_TIMESTAMP,
         last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [integrationId]
  );
}

// Reflete na integracao o erro que derrubou o job, com o status derivado do codigo do erro
export async function registrarFalha(client, integrationId, erro) {
  await client.query(
    `UPDATE integrations
     SET status = $2, last_error = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [integrationId, erro.statusJob || "ERRO_TEMPORARIO", String(erro.message || "").slice(0, 1000)]
  );
}

export async function registrarTesteConexao(client, integrationId, { sucesso, duracaoMs = 0, mensagem = null }) {
  await client.query(
    `UPDATE integrations
     SET status = $2,
         last_connection_test_at = CURRENT_TIMESTAMP,
         last_connection_duration_ms = $3,
         last_connection_message = $4,
         last_error = CASE WHEN $5 THEN NULL ELSE $4 END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [integrationId, sucesso ? "CONECTADO" : "ERRO_CONFIGURACAO", Math.round(duracaoMs), mensagem, sucesso]
  );
}

// Monta a versao publica da integracao para API/UI.
// Nunca devolve credencial em texto puro: so o rotulo declarado pelo provider, a mascara e
// o indicador de "configurada".
export function sanitizarIntegracao(integracao = {}, credenciais = []) {
  const provider = obterProvider(integracao.provedor);
  const declaradas = provider?.credenciais || [];
  const porChave = new Map(credenciais.map((credencial) => [credencial.credential_key, credencial]));

  // Mostra toda credencial que o provider declara (mesmo ainda nao preenchida) e tambem
  // qualquer credencial salva que o provider nao declara mais, para nao esconder resto antigo
  const chaves = [...new Set([...declaradas.map((item) => item.chave), ...porChave.keys()])];

  return {
    id: integracao.id,
    nome: integracao.nome,
    provedor: integracao.provedor,
    provider_registrado: Boolean(provider),
    tipo: integracao.tipo,
    ambiente: integracao.ambiente,
    ativo: integracao.ativo,
    status: integracao.status,
    url_base: integracao.url_base,
    stock_mode: integracao.stock_mode,
    empresa_vinculada: integracao.empresa_vinculada,
    sync_intervals: integracao.sync_intervals || {},
    configuracao: integracao.configuracao || {},
    ultima_sincronizacao: integracao.ultima_sincronizacao,
    last_connection_test_at: integracao.last_connection_test_at,
    last_connection_duration_ms: integracao.last_connection_duration_ms,
    last_connection_message: integracao.last_connection_message,
    last_error: integracao.last_error,
    created_at: integracao.created_at,
    updated_at: integracao.updated_at,
    credenciais: chaves.map((chave) => {
      const declarada = declaradas.find((item) => item.chave === chave);
      const salva = porChave.get(chave);
      return {
        chave,
        rotulo: declarada?.rotulo || chave,
        obrigatoria: declarada ? declarada.obrigatoria !== false : false,
        mascara: salva?.masked_value || "",
        configurada: Boolean(salva)
      };
    })
  };
}

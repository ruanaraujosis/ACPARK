import { derivarDoGemeo, derivarSugestao, ehPendenciaDeCadastro, SITUACAO } from "./fator-evidencia.js";
import { lerFatorDaDescricao } from "./fator-planilha.js";
import { mapaPorProduto } from "./fator-planilha.repository.js";

// Acesso as tabelas do assistente de fator: a evidencia colhida dos documentos de compra e
// a decisao humana tomada em cima dela.
//
// As duas ficam separadas de proposito. Reler o historico atualiza a evidencia; nunca pode
// apagar o que alguem ja conferiu e aprovou.

// As duas filas da tela de revisao. Cadastro generico nunca aparece junto com conferencia
// de fator: sao problemas diferentes, resolvidos em lugares diferentes.
export const FILAS = {
  FATOR: "FATOR",
  CADASTRO: "CADASTRO",
  TODAS: "TODAS"
};

export const STATUS_DECISAO = {
  APROVADA: "APROVADA",
  RECUSADA: "RECUSADA",
  ESCRITA: "ESCRITA",
  ERRO: "ERRO"
};

// Registra uma linha de documento como evidencia. Acumula em vez de sobrescrever: a mesma
// caixa aparece em dezenas de notas, e a contagem e o que da forca a sugestao.
//
// O documento de exemplo so e gravado na primeira vez (COALESCE): trocar o exemplo a cada
// releitura faria a tela de revisao mostrar uma nota diferente a cada carga, sem motivo.
export async function registrarEvidencia(client, dados) {
  const { integrationId, externalProductId, fator, data, documento } = dados;
  await client.query(
    `INSERT INTO integration_factor_evidence
       (integration_id, external_product_id, fator, vezes, primeira_em, ultima_em, documento)
     VALUES ($1, $2, $3, 1, $4, $4, $5)
     ON CONFLICT (integration_id, external_product_id, fator) DO UPDATE
       SET vezes = integration_factor_evidence.vezes + 1,
           primeira_em = LEAST(integration_factor_evidence.primeira_em, EXCLUDED.primeira_em),
           ultima_em = GREATEST(integration_factor_evidence.ultima_em, EXCLUDED.ultima_em),
           documento = COALESCE(integration_factor_evidence.documento, EXCLUDED.documento),
           atualizado_em = CURRENT_TIMESTAMP`,
    [integrationId, externalProductId, fator, data || null, documento ? JSON.stringify(documento) : null]
  );
}

// Zera a evidencia antes de uma varredura completa do historico.
//
// Necessario porque a contagem e acumulativa: reprocessar as mesmas notas sem limpar dobraria
// o numero de vezes e daria a uma sugestao uma forca que ela nao tem. As decisoes ficam.
export async function limparEvidencia(client, integrationId) {
  const resultado = await client.query(
    "DELETE FROM integration_factor_evidence WHERE integration_id = $1",
    [integrationId]
  );
  return resultado.rowCount || 0;
}

// Junta evidencia, cadastro e decisao de um produto so
export async function obterEvidenciaDoProduto(client, integrationId, externalProductId) {
  const linhas = await client.query(
    `SELECT fator, vezes, primeira_em, ultima_em, documento
     FROM integration_factor_evidence
     WHERE integration_id = $1 AND external_product_id = $2
     ORDER BY vezes DESC, fator`,
    [integrationId, externalProductId]
  );
  return linhas.rows;
}

// Cadastros duplicados do mesmo item fisico.
//
// O criterio e factual, nao textual: o `ean` de um mapeamento e o `sku_produto` de outro. Foi
// assim que a OMIE ficou com o mesmo picole em dois registros, um pelo codigo interno e outro
// pelo EAN. Nome parecido NAO entra -- ja foi medido que ele aponta produtos opostos.
export async function mapaDeGemeos(client, integrationId) {
  const resultado = await client.query(
    `SELECT a.external_product_id AS id, b.external_product_id AS id_gemeo,
            b.sku_produto AS sku_gemeo
     FROM product_integration_mappings a
     JOIN product_integration_mappings b
       ON b.integration_id = a.integration_id
      AND b.active = TRUE
      AND b.sku_produto = a.ean
      AND b.sku_produto <> a.sku_produto
     WHERE a.integration_id = $1 AND a.active = TRUE AND a.ean IS NOT NULL AND a.ean <> ''`,
    [integrationId]
  );
  // A relacao vale nos dois sentidos: qualquer um dos dois pode ser o que ja tem fator
  const mapa = new Map();
  for (const linha of resultado.rows) {
    mapa.set(String(linha.id), String(linha.id_gemeo));
    mapa.set(String(linha.id_gemeo), String(linha.id));
  }
  return mapa;
}

// Lista as sugestoes para a tela de revisao humana.
//
// A situacao NAO fica gravada: e derivada da evidencia a cada leitura. Gravar criaria um
// segundo lugar onde a verdade mora, e uma releitura do historico poderia deixar o campo
// gravado contradizendo as linhas que o originaram.
export async function listarSugestoes(client, integrationId, filtros = {}) {
  const { situacao, fila = FILAS.FATOR, apenasPendentes = false, limite = 500 } = filtros;

  const linhas = await client.query(
    // A demanda entra como CTE, nao como subconsulta por linha: um produto tem varias linhas
    // de evidencia, e contar pedidos dentro do SELECT repetiria a varredura para cada uma.
    `WITH demanda AS (
       SELECT sku_produto, COUNT(*)::int AS pedidos_recentes
       FROM pedidos
       WHERE criado_em > CURRENT_DATE - INTERVAL '90 days'
       GROUP BY sku_produto
     )
     SELECT e.external_product_id,
            e.fator,
            e.vezes,
            e.primeira_em,
            e.ultima_em,
            e.documento,
            m.sku_produto,
            m.fator_conversao AS fator_no_erp,
            m.fator_status,
            p.nome AS nome_produto,
            d.status AS status_decisao,
            d.fator_decidido,
            d.decidido_por,
            d.decidido_em,
            d.escrito_em,
            d.erro,
            COALESCE(dem.pedidos_recentes, 0) AS pedidos_recentes
     FROM integration_factor_evidence e
     JOIN product_integration_mappings m
       ON m.integration_id = e.integration_id
      AND m.external_product_id = e.external_product_id
      AND m.active = TRUE
     LEFT JOIN produtos p ON p.sku = m.sku_produto
     LEFT JOIN integration_factor_decisions d
       ON d.integration_id = e.integration_id
      AND d.external_product_id = e.external_product_id
     LEFT JOIN demanda dem ON dem.sku_produto = m.sku_produto
     WHERE e.integration_id = $1
     ORDER BY m.sku_produto, e.vezes DESC`,
    [integrationId]
  );

  // Uma consulta so para toda a planilha: buscar linha a linha faria uma ida ao banco por
  // produto, e a tela lista milhares deles.
  const planilhaPorProduto = await mapaPorProduto(client, integrationId);
  const gemeos = await mapaDeGemeos(client, integrationId);

  // Agrupa por produto para derivar a situacao com TODA a evidencia dele em maos
  const porProduto = new Map();
  for (const linha of linhas.rows) {
    const chave = linha.external_product_id;
    if (!porProduto.has(chave)) {
      porProduto.set(chave, {
        external_product_id: chave,
        sku: linha.sku_produto,
        nome: linha.nome_produto || null,
        fator_no_erp: linha.fator_no_erp,
        fator_status: linha.fator_status,
        pedidos_recentes: Number(linha.pedidos_recentes) || 0,
        decisao: linha.status_decisao
          ? {
              status: linha.status_decisao,
              fator: linha.fator_decidido,
              por: linha.decidido_por,
              em: linha.decidido_em,
              escrito_em: linha.escrito_em,
              erro: linha.erro
            }
          : null,
        evidencias: []
      });
    }
    porProduto.get(chave).evidencias.push({
      fator: linha.fator,
      vezes: linha.vezes,
      primeira_em: linha.primeira_em,
      ultima_em: linha.ultima_em,
      documento: linha.documento
    });
  }

  // Primeira passada: deriva cada produto com a evidencia dele
  const derivados = new Map();
  for (const produto of porProduto.values()) {
    derivados.set(
      String(produto.external_product_id),
      derivarSugestao(produto.evidencias, {
        planilha: planilhaPorProduto.get(String(produto.external_product_id)) || null,
        descricao: lerFatorDaDescricao(produto.nome)
      })
    );
  }

  // Cadastro gemeo SEM evidencia propria tambem precisa aparecer.
  //
  // A listagem parte da evidencia, entao um duplicado que nunca foi comprado por aquele
  // codigo nao entraria -- e ele e justamente quem mais depende do fator do gemeo. Aqui os
  // que tem um gemeo com fator sao trazidos para a lista, sem evidencia nenhuma propria.
  const idsComEvidencia = new Set(porProduto.keys());
  const faltantes = [...gemeos.entries()]
    .filter(([id, idGemeo]) => !idsComEvidencia.has(id) && idsComEvidencia.has(idGemeo))
    .map(([id]) => id);

  if (faltantes.length) {
    const extras = await client.query(
      `SELECT m.external_product_id, m.sku_produto, m.fator_conversao, m.fator_status, p.nome,
              COALESCE(dem.pedidos_recentes, 0) AS pedidos_recentes,
              d.status AS status_decisao, d.fator_decidido, d.decidido_por, d.decidido_em,
              d.escrito_em, d.erro
       FROM product_integration_mappings m
       LEFT JOIN produtos p ON p.sku = m.sku_produto
       LEFT JOIN (
         SELECT sku_produto, COUNT(*)::int AS pedidos_recentes FROM pedidos
         WHERE criado_em > CURRENT_DATE - INTERVAL '90 days' GROUP BY sku_produto
       ) dem ON dem.sku_produto = m.sku_produto
       LEFT JOIN integration_factor_decisions d
         ON d.integration_id = m.integration_id AND d.external_product_id = m.external_product_id
       WHERE m.integration_id = $1 AND m.active = TRUE
         AND m.external_product_id = ANY($2::text[])`,
      [integrationId, faltantes]
    );
    for (const linha of extras.rows) {
      porProduto.set(String(linha.external_product_id), {
        external_product_id: String(linha.external_product_id),
        sku: linha.sku_produto,
        nome: linha.nome || null,
        fator_no_erp: linha.fator_conversao,
        fator_status: linha.fator_status,
        pedidos_recentes: Number(linha.pedidos_recentes) || 0,
        decisao: linha.status_decisao
          ? {
              status: linha.status_decisao,
              fator: linha.fator_decidido,
              por: linha.decidido_por,
              em: linha.decidido_em,
              escrito_em: linha.escrito_em,
              erro: linha.erro
            }
          : null,
        evidencias: []
      });
      derivados.set(String(linha.external_product_id), derivarSugestao([], {}));
    }
  }

  const saida = [];
  for (const produto of porProduto.values()) {
    const chave = String(produto.external_product_id);
    let derivado = derivados.get(chave);

    // Sem fator proprio, mas com um cadastro gemeo que tem: o item fisico e o mesmo, entao
    // um fardo tem a mesma quantidade. So preenche quem nao tem numero proprio -- evidencia
    // propria sempre vence a herdada.
    if (!derivado.fator || derivado.fator === 1) {
      const idGemeo = gemeos.get(chave);
      const doGemeo = idGemeo ? derivados.get(idGemeo) : null;
      const dadosGemeo = doGemeo
        ? { fator: doGemeo.fator, sku: porProduto.get(idGemeo)?.sku, nome: porProduto.get(idGemeo)?.nome }
        : null;
      const herdado = derivarDoGemeo(dadosGemeo);
      if (herdado) derivado = { ...derivado, ...herdado };
    }
    const item = { ...produto, ...derivado, pendencia_de_cadastro: ehPendenciaDeCadastro(derivado.situacao) };
    if (situacao && item.situacao !== situacao) continue;
    // Fila de cadastro generico e separada da de conferencia de fator: um codigo servindo
    // produtos diferentes precisa ser corrigido no ERP, nao receber um fator carimbado.
    if (fila === FILAS.CADASTRO && !item.pendencia_de_cadastro) continue;
    if (fila === FILAS.FATOR && item.pendencia_de_cadastro) continue;
    // Pendente = ainda sem decisao humana, numa situacao que admite confirmacao
    if (apenasPendentes && (item.decisao || !item.exigeConfirmacao)) continue;
    saida.push(item);
  }

  // Impacto primeiro: produto que os PDVs realmente pedem vale mais tempo de conferencia do
  // que um que ninguem pede. Confianca alta antes, para a confirmacao em lote render.
  saida.sort((a, b) => {
    if (b.pedidos_recentes !== a.pedidos_recentes) return b.pedidos_recentes - a.pedidos_recentes;
    return (b.vezes || 0) - (a.vezes || 0);
  });

  return saida.slice(0, limite);
}

// Conta quantos produtos estao em cada situacao, para o cabecalho da tela
export async function resumirSugestoes(client, integrationId) {
  const todos = await listarSugestoes(client, integrationId, {
    fila: FILAS.TODAS,
    limite: Number.MAX_SAFE_INTEGER
  });
  const resumo = {
    total: todos.length,
    sugeridos: 0,
    conflito_embalagem: 0,
    cadastro_generico: 0,
    so_avulso: 0,
    confianca_maxima: 0,
    confianca_alta: 0,
    confianca_media: 0,
    evidencia_unica: 0,
    aguardando_revisao: 0,
    aprovados: 0,
    recusados: 0,
    escritos: 0,
    com_erro: 0
  };
  for (const item of todos) {
    if (item.situacao === SITUACAO.SUGERIDO) resumo.sugeridos += 1;
    else if (item.situacao === SITUACAO.CONFLITO_EMBALAGEM) resumo.conflito_embalagem += 1;
    else if (item.situacao === SITUACAO.CADASTRO_GENERICO) resumo.cadastro_generico += 1;
    else if (item.situacao === SITUACAO.SO_AVULSO) resumo.so_avulso += 1;

    if (item.confianca === "MAXIMA") resumo.confianca_maxima += 1;
    else if (item.confianca === "ALTA") resumo.confianca_alta += 1;
    else if (item.confianca === "MEDIA") resumo.confianca_media += 1;
    else if (item.confianca === "UNICA") resumo.evidencia_unica += 1;

    if (!item.decisao && item.exigeConfirmacao) resumo.aguardando_revisao += 1;
    if (item.decisao?.status === STATUS_DECISAO.APROVADA) resumo.aprovados += 1;
    if (item.decisao?.status === STATUS_DECISAO.RECUSADA) resumo.recusados += 1;
    if (item.decisao?.status === STATUS_DECISAO.ESCRITA) resumo.escritos += 1;
    if (item.decisao?.status === STATUS_DECISAO.ERRO) resumo.com_erro += 1;
  }
  return resumo;
}

// Grava a decisao de uma pessoa sobre um produto.
//
// O fator aprovado vem do parametro, nao da evidencia: quem revisa pode corrigir o numero
// (a nota pode estar certa e mesmo assim nao ser a embalagem que o PDV pede). O que nunca
// acontece e o sistema escolher sozinho.
export async function registrarDecisao(client, dados) {
  const { integrationId, externalProductId, status, fatorSugerido, fatorDecidido, decididoPor } = dados;

  // Congela a evidencia usada na decisao. A varredura seguinte pode mudar a evidencia (nota
  // nova, formato de embalagem novo), e a auditoria precisa dizer em que base a pessoa
  // decidiu naquele dia -- nao em que base o sistema esta hoje.
  const evidencia = await obterEvidenciaDoProduto(client, integrationId, externalProductId);

  await client.query(
    `INSERT INTO integration_factor_decisions
       (integration_id, external_product_id, status, fator_sugerido, fator_decidido,
        decidido_por, decidido_em, evidencia)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7)
     ON CONFLICT (integration_id, external_product_id) DO UPDATE
       SET status = EXCLUDED.status,
           fator_sugerido = EXCLUDED.fator_sugerido,
           fator_decidido = EXCLUDED.fator_decidido,
           decidido_por = EXCLUDED.decidido_por,
           decidido_em = CURRENT_TIMESTAMP,
           evidencia = EXCLUDED.evidencia,
           erro = NULL,
           atualizado_em = CURRENT_TIMESTAMP`,
    [
      integrationId,
      externalProductId,
      status,
      fatorSugerido ?? null,
      fatorDecidido ?? null,
      decididoPor || null,
      JSON.stringify(evidencia)
    ]
  );
}

// Aprovados que ainda nao foram gravados no ERP -- a fila da escrita
// `apenas` restringe a um unico produto.
//
// Existe para a virada de simulacao para real: o primeiro envio verdadeiro e de UM produto,
// conferido na tela do ERP, e so depois o lote segue. Sem esse filtro a unica forma de
// limitar seria mexer no status dos outros, que e pior.
export async function listarAprovadasNaoEscritas(client, integrationId, limite = 50, apenas = null) {
  const resultado = await client.query(
    `SELECT d.external_product_id, d.fator_decidido, m.sku_produto
     FROM integration_factor_decisions d
     JOIN product_integration_mappings m
       ON m.integration_id = d.integration_id
      AND m.external_product_id = d.external_product_id
      AND m.active = TRUE
     WHERE d.integration_id = $1
       AND d.status = $2
       AND d.fator_decidido IS NOT NULL
       AND ($4::text IS NULL OR d.external_product_id = $4)
     ORDER BY d.decidido_em
     LIMIT $3`,
    [integrationId, STATUS_DECISAO.APROVADA, limite, apenas]
  );
  return resultado.rows;
}

// Registra o que SERIA enviado, sem sair do estado aprovado.
//
// Diferente de marcarEscrita: o status continua APROVADA de proposito. Simulacao nao gravou
// nada no ERP, entao o item tem de continuar na fila da escrita real -- se virasse ESCRITA,
// ligar o modo REAL depois nao encontraria mais ninguem para gravar.
export async function marcarEscritaSimulada(client, integrationId, externalProductId, auditoria = {}) {
  const { valorAnterior = null, operacao = null, payload = null } = auditoria;
  await client.query(
    `UPDATE integration_factor_decisions
     SET valor_anterior = COALESCE($3, valor_anterior),
         operacao = $4,
         payload = $5::jsonb,
         resposta = NULL,
         erro = NULL,
         atualizado_em = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND external_product_id = $2`,
    [integrationId, externalProductId, valorAnterior, operacao, payload ? JSON.stringify(payload) : null]
  );
}

// Marca o resultado da gravacao no ERP
export async function marcarEscrita(client, integrationId, externalProductId, auditoria = {}) {
  const { erro = null, valorAnterior = null, operacao = null, payload = null, resposta = null } = auditoria;

  await client.query(
    `UPDATE integration_factor_decisions
     SET status = $3,
         escrito_em = CASE WHEN $4::text IS NULL THEN CURRENT_TIMESTAMP ELSE escrito_em END,
         erro = $4,
         valor_anterior = COALESCE($5, valor_anterior),
         operacao = COALESCE($6, operacao),
         payload = COALESCE($7::jsonb, payload),
         resposta = COALESCE($8::jsonb, resposta),
         atualizado_em = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND external_product_id = $2`,
    [
      integrationId,
      externalProductId,
      erro ? STATUS_DECISAO.ERRO : STATUS_DECISAO.ESCRITA,
      erro || null,
      valorAnterior,
      operacao,
      payload ? JSON.stringify(payload) : null,
      resposta ? JSON.stringify(resposta) : null
    ]
  );
}

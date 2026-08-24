import { chamarOmie, ENDPOINTS, extrairLista, totalDePaginas, totalDeRegistros } from "../omie.api.js";
import { mapearProduto } from "../omie.mappers.js";

const CALL = "ListarProdutos";
const CAMPOS_LISTA = ["produto_servico_cadastro", "produtos_cadastro"];
const PAGINAS_POR_JOB = 5;
const TAMANHO_PAGINA = 100;

// Compara nomes de categoria ignorando acento e caixa.
//
// As 20 categorias do MyEstoque saem das familias da OMIE, mas com acentuacao divergente:
// "CONVENIENCIA" aqui e "CONVENIÊNCIA" la, "MATERIAL DE ESCRITORIO" contra "ESCRITÓRIO".
// Como pdv_categorias amarra o que cada PDV pode pedir PELO NOME da categoria, criar a
// variante acentuada como categoria nova faria os produtos sairem de baixo da permissao
// existente e sumirem da tela do PDV.
function chaveDeCategoria(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase();
}

// Resolve a familia da OMIE para um nome de categoria local, reaproveitando a categoria
// existente quando ela e a mesma a menos de acento/caixa. Familia nova vira categoria nova.
// O cache evita reler a tabela a cada produto.
async function resolverCategoria(client, familia, cache) {
  const nome = String(familia || "").trim();
  if (!nome) return null;

  if (!cache.carregado) {
    const existentes = await client.query("SELECT nome FROM categorias");
    for (const linha of existentes.rows) cache.porChave.set(chaveDeCategoria(linha.nome), linha.nome);
    cache.carregado = true;
  }

  const chave = chaveDeCategoria(nome);
  const jaExiste = cache.porChave.get(chave);
  if (jaExiste) return jaExiste;

  await client.query(
    "INSERT INTO categorias (nome) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM categorias WHERE nome = $1)",
    [nome]
  );
  cache.porChave.set(chave, nome);
  cache.criadas.push(nome);
  return nome;
}

// Grava/atualiza o produto local e o vinculo com o produto da OMIE.
// Retorna "criado", "atualizado", "ignorado", "inativo_ignorado" ou "desativado".
async function gravarProduto(client, integrationId, produto, cacheCategorias) {
  if (!produto.sku || !produto.nome || !produto.idExterno) return "ignorado";

  const existente = await client.query("SELECT sku, origem, categoria FROM produtos WHERE sku = $1 LIMIT 1", [
    produto.sku
  ]);

  // So produto ATIVO entra no catalogo. Um inativo que nunca existiu aqui e simplesmente
  // ignorado -- nem o vinculo e criado, para nao poluir o cadastro com item descontinuado.
  if (!produto.ativo && !existente.rows[0]) return "inativo_ignorado";

  // Esta tarefa cuida do CADASTRO; quem manda no saldo e a tarefa de estoque do
  // almoxarifado. Sao dois donos diferentes de proposito: o quantidade_estoque que vem
  // do ListarProdutos veio zerado nesta conta enquanto o local ALMOXARIFADO acusava 270
  // unidades do mesmo item. Se as duas tarefas escrevessem saldo, a ultima a rodar venceria
  // e o estoque central ficaria oscilando entre o numero certo e zero.
  const categoria = await resolverCategoria(client, produto.familia, cacheCategorias);

  if (existente.rows[0]) {
    // A categoria so e preenchida quando esta vazia. Sobrescrever a categoria de um produto
    // ja classificado o moveria entre as permissoes de pdv_categorias e ele sumiria da tela
    // de quem podia pedi-lo -- alinhar categoria com familia e decisao do operador, nao
    // efeito colateral de uma sincronizacao de cadastro.
    await client.query(
      `UPDATE produtos
       SET nome = $2,
           ativo = $3,
           categoria = COALESCE(NULLIF(categoria, ''), $4)
       WHERE sku = $1`,
      [produto.sku, produto.nome, produto.ativo, categoria]
    );
    // Produto que virou inativo na OMIE precisa ser desativado aqui tambem, senao o PDV
    // continua conseguindo pedir item descontinuado
    if (!produto.ativo) return "desativado";
  } else {
    // Produto novo entra sem saldo: quem preenche e a sincronizacao de estoque
    await client.query(
      `INSERT INTO produtos
         (sku, nome, qtd_total, estoque_central, ativo, categoria, origem,
          saldo_omie, quantidade_reservada_acpark, saldo_disponivel_acpark,
          sincronizacao_status, stock_mode)
       VALUES ($1, $2, 0, 0, $3, $4, 'omie', 0, 0, 0, 'PENDENTE_ESTOQUE', 'TRANSICAO')`,
      [produto.sku, produto.nome, produto.ativo, categoria]
    );
  }

  // A categoria tambem entra na tabela de vinculo produto x categoria, que e por onde
  // varias telas filtram
  if (categoria) {
    await client.query(
      `INSERT INTO produto_categorias (sku_produto, categoria)
       SELECT $1, $2
       WHERE NOT EXISTS (SELECT 1 FROM produto_categorias WHERE sku_produto = $1 AND categoria = $2)`,
      [produto.sku, categoria]
    );
  }

  // O vinculo usa a chave unica (integration_id, external_product_id), entao um produto
  // que trocou de SKU na OMIE atualiza a linha existente em vez de duplicar
  await client.query(
    `INSERT INTO product_integration_mappings
       (integration_id, sku_produto, external_product_id, external_code, integration_code,
        product_type, unit, family, ean, ncm, price, stock_control, review_status,
        raw_payload, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'SINCRONIZADO', $13::jsonb, $14)
     ON CONFLICT (integration_id, external_product_id) DO UPDATE
     SET sku_produto = EXCLUDED.sku_produto,
         external_code = EXCLUDED.external_code,
         integration_code = EXCLUDED.integration_code,
         product_type = EXCLUDED.product_type,
         unit = EXCLUDED.unit,
         family = EXCLUDED.family,
         ean = EXCLUDED.ean,
         ncm = EXCLUDED.ncm,
         price = EXCLUDED.price,
         stock_control = EXCLUDED.stock_control,
         raw_payload = EXCLUDED.raw_payload,
         active = EXCLUDED.active,
         updated_at = CURRENT_TIMESTAMP`,
    [
      integrationId,
      produto.sku,
      produto.idExterno,
      produto.sku,
      produto.codigoIntegracao,
      produto.tipo,
      produto.unidade,
      produto.familia,
      produto.ean,
      produto.ncm,
      produto.preco,
      produto.controleEstoque,
      JSON.stringify(produto.bruto || {}),
      produto.ativo
    ]
  );

  return existente.rows[0] ? "atualizado" : "criado";
}

// Importa o cadastro de produtos da OMIE, algumas paginas por job.
// Quando sobra pagina, o proprio job agenda a continuacao — assim um catalogo de 5 mil
// produtos nao vira uma unica transacao gigante segurando o banco.
export async function sincronizarProdutos(contexto) {
  const { client, integracao, segredos, payload, fetchImpl } = contexto;
  const tamanhoPagina = Math.min(Number(payload.tamanhoPagina) || TAMANHO_PAGINA, 500);
  const paginasPorJob = Math.min(Number(payload.paginasPorJob) || PAGINAS_POR_JOB, 20);
  let pagina = Math.max(Number(payload.pagina) || 1, 1);

  const resumo = {
    paginas: 0,
    recebidos: 0,
    criados: 0,
    atualizados: 0,
    ignorados: 0,
    inativos_ignorados: 0,
    desativados: 0,
    categorias_criadas: [],
    pagina_inicial: pagina,
    total_paginas: null,
    total_registros: 0
  };

  // Cache das categorias, compartilhado por todas as paginas deste job
  const cacheCategorias = { carregado: false, porChave: new Map(), criadas: [] };

  let totalPaginas = 1;
  let ultimaProcessada = pagina;
  // Guarda a proxima pagina AINDA nao lida. Calcular isso depois do laco a partir do
  // contador daria errado: ele ja foi incrementado na ultima volta e a continuacao
  // deixava de ser agendada, travando a importacao no meio do catalogo.
  let proximaPagina = null;

  for (let processadas = 0; processadas < paginasPorJob; processadas += 1) {
    const resposta = await chamarOmie({
      integracao,
      segredos,
      endpoint: ENDPOINTS.PRODUTOS,
      call: CALL,
      params: {
        pagina,
        registros_por_pagina: tamanhoPagina,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N"
      },
      fetchImpl
    });

    const lista = extrairLista(resposta.dados, CAMPOS_LISTA);
    totalPaginas = totalDePaginas(resposta.dados);
    resumo.total_paginas = totalPaginas;
    resumo.total_registros = totalDeRegistros(resposta.dados) || resumo.total_registros;
    resumo.paginas += 1;
    resumo.recebidos += lista.length;

    for (const bruto of lista) {
      const produto = mapearProduto(bruto);
      const efeito = await gravarProduto(client, integracao.id, produto, cacheCategorias);
      if (efeito === "criado") resumo.criados += 1;
      else if (efeito === "atualizado") resumo.atualizados += 1;
      else if (efeito === "desativado") resumo.desativados += 1;
      else if (efeito === "inativo_ignorado") resumo.inativos_ignorados += 1;
      else resumo.ignorados += 1;
    }

    ultimaProcessada = pagina;
    if (!lista.length || pagina >= totalPaginas) {
      proximaPagina = null;
      break;
    }
    pagina += 1;
    proximaPagina = pagina;
  }

  // Ainda ha catalogo a importar: agenda a proxima faixa de paginas
  if (proximaPagina) {
    resumo.proxima_pagina = proximaPagina;
    await contexto.enfileirar("PRODUTOS", { ...payload, pagina: proximaPagina }, { prioridade: "NORMAL" });
  }

  resumo.categorias_criadas = cacheCategorias.criadas;

  if (!resumo.recebidos) {
    resumo.alerta = "A OMIE respondeu a listagem, mas nao retornou nenhum produto nesta pagina.";
  }

  resumo.cursor = { ultimaPagina: ultimaProcessada, estatisticas: { ...resumo } };
  return resumo;
}

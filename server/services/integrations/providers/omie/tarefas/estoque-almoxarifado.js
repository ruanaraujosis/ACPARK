import { CODIGOS_ERRO, IntegrationError } from "../../../core/errors.js";
import { chamarOmie, ENDPOINTS, extrairLista, totalDePaginas } from "../omie.api.js";
import { mapearSaldo } from "../omie.mappers.js";

const CALL = "ListarPosEstoque";
const CAMPOS_LISTA = ["produtos", "posEstoque", "lista_estoque"];
const TAMANHO_PAGINA = 100;

// Estoque central do MyEstoque a partir do local de almoxarifado da OMIE.
//
// Esta e a tarefa que responde ao fluxo real do sistema:
//   OMIE (local ALMOXARIFADO)  ->  produtos.qtd_total   (estoque central)
//   liberacao de pedido        ->  estoque_pdv.quantidade (estoque do PDV)
//
// O saldo importado SUBSTITUI o valor local, nao soma: a OMIE e a fonte da verdade do
// estoque central. Foi a ausencia disso que deixou produtos.qtd_total somar -13.373 --
// as liberacoes debitavam ha meses e nada nunca repunha.

// Data de posicao no formato dd/mm/aaaa exigido pela OMIE
function dataDeHoje(agora = new Date()) {
  const dia = String(agora.getDate()).padStart(2, "0");
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}/${agora.getFullYear()}`;
}

// Traduz id externo do produto para o SKU local usando o vinculo criado na tarefa de produtos
async function mapaDeSkus(client, integrationId, idsExternos) {
  if (!idsExternos.length) return new Map();
  const resultado = await client.query(
    `SELECT external_product_id, sku_produto
     FROM product_integration_mappings
     WHERE integration_id = $1 AND external_product_id = ANY($2::text[]) AND sku_produto IS NOT NULL`,
    [integrationId, idsExternos]
  );
  return new Map(resultado.rows.map((linha) => [linha.external_product_id, linha.sku_produto]));
}

// Grava o saldo do almoxarifado no produto.
//
// qtd_total e o estoque central que a liberacao de pedido debita; saldo_omie guarda o mesmo
// numero como espelho do que a OMIE respondeu, para a reconciliacao comparar depois.
// saldo_disponivel_acpark nao e coluna gerada em "produtos" (so em estoque_pdv), entao
// precisa ser calculada aqui.
async function gravarEstoqueCentral(client, sku, quantidade) {
  const exato = Number(quantidade) || 0;
  // qtd_total e integer e o almoxarifado tem saldo fracionario de verdade (itens vendidos
  // a granel). Arredondar aqui deixa explicito o que o Postgres faria por cast implicito;
  // saldo_omie guarda o valor exato para a reconciliacao nao acusar diferenca falsa.
  const inteiro = Math.round(exato);

  const atualizado = await client.query(
    `UPDATE produtos
     SET qtd_total = $2,
         saldo_omie = $3,
         saldo_disponivel_acpark = $3 - COALESCE(quantidade_reservada_acpark, 0),
         ultima_sincronizacao = CURRENT_TIMESTAMP,
         sincronizacao_status = 'SINCRONIZADO'
     WHERE sku = $1`,
    [sku, inteiro, exato]
  );
  return atualizado.rowCount > 0;
}

// Le a posicao de estoque do local configurado como almoxarifado e atualiza o estoque central
export async function sincronizarEstoqueAlmoxarifado(contexto) {
  const { client, integracao, segredos, configuracao, payload, fetchImpl } = contexto;

  const localAlmoxarifado = String(configuracao?.local_almoxarifado || "").trim();
  if (!localAlmoxarifado) {
    throw new IntegrationError(
      "Escolha qual local de estoque da OMIE e o almoxarifado antes de sincronizar o estoque central.",
      { codigo: CODIGOS_ERRO.CONFIGURACAO, status: 400 }
    );
  }

  const dataPosicao = payload.dataPosicao || dataDeHoje();
  const resumo = {
    local_almoxarifado: localAlmoxarifado,
    data_posicao: dataPosicao,
    paginas: 0,
    recebidos: 0,
    atualizados: 0,
    sem_vinculo_de_produto: 0,
    sem_produto_local: 0,
    total_em_estoque: 0
  };

  let pagina = 1;
  let totalPaginas = 1;

  do {
    const resposta = await chamarOmie({
      integracao,
      segredos,
      endpoint: ENDPOINTS.CONSULTA,
      call: CALL,
      params: {
        nPagina: pagina,
        nRegPorPagina: TAMANHO_PAGINA,
        dDataPosicao: dataPosicao,
        cExibeTodos: "S",
        codigo_local_estoque: Number(localAlmoxarifado) || localAlmoxarifado
      },
      fetchImpl
    });

    const lista = extrairLista(resposta.dados, CAMPOS_LISTA).map(mapearSaldo);
    totalPaginas = totalDePaginas(resposta.dados);
    resumo.paginas += 1;
    resumo.recebidos += lista.length;

    const skus = await mapaDeSkus(client, integracao.id, lista.map((item) => item.idExternoProduto).filter(Boolean));

    for (const saldo of lista) {
      // O vinculo criado pela tarefa de produtos e o caminho normal; o codigo que veio
      // junto do saldo e so o plano B para quem ainda nao foi vinculado
      const sku = skus.get(saldo.idExternoProduto) || saldo.skuExterno;
      if (!sku) {
        resumo.sem_vinculo_de_produto += 1;
        continue;
      }
      const gravou = await gravarEstoqueCentral(client, sku, saldo.quantidade);
      if (gravou) {
        resumo.atualizados += 1;
        resumo.total_em_estoque += Number(saldo.quantidade) || 0;
      } else {
        resumo.sem_produto_local += 1;
      }
    }

    pagina += 1;
  } while (pagina <= totalPaginas);

  if (!resumo.recebidos) {
    resumo.alerta = "A OMIE nao retornou nenhuma posicao de estoque para o local do almoxarifado.";
  } else if (resumo.sem_produto_local) {
    resumo.alerta = `${resumo.sem_produto_local} produtos vieram da OMIE sem cadastro local. Rode a sincronizacao de produtos antes.`;
  }

  resumo.cursor = { estatisticas: { ...resumo } };
  return resumo;
}

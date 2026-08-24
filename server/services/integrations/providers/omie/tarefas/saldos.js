import { chamarOmie, ehSemRegistros, ENDPOINTS, extrairLista, totalDePaginas } from "../omie.api.js";
import { converterNumero, mapearSaldo } from "../omie.mappers.js";
import { SINCRONIZACAO_PDV_ATIVA } from "../omie.politica.js";

const CALL = "ListarPosEstoque";
const CAMPOS_LISTA = ["produtos", "posEstoque", "lista_estoque"];
const TAMANHO_PAGINA = 100;

// Data de posicao no formato dd/mm/aaaa exigido pela OMIE
function dataDeHoje() {
  const agora = new Date();
  const dia = String(agora.getDate()).padStart(2, "0");
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}/${agora.getFullYear()}`;
}

// Locais da OMIE que estao vinculados a um PDV. Saldo so e gravado onde existe vinculo:
// sem ele nao ha para qual PDV escrever, e adivinhar seria pior do que nao importar.
async function listarVinculos(client, integrationId) {
  const resultado = await client.query(
    `SELECT m.omie_location_id, m.pdv_acpark_id, p.nome AS pdv_nome
     FROM pdv_stock_location_mappings m
     JOIN pdvs p ON p.id = m.pdv_acpark_id
     WHERE m.integration_id = $1 AND m.active = TRUE`,
    [integrationId]
  );
  return resultado.rows;
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

// Grava o saldo da OMIE no PDV correspondente.
//
// A OMIE e a fonte da verdade do estoque do PDV: o saldo importado SUBSTITUI o valor local,
// nunca soma. A liberacao de pedido tambem credita estoque_pdv.quantidade, mas a mesma saida
// e lancada na OMIE — entao a proxima sincronizacao reconcilia os dois lados sozinha.
//
// quantidade e coluna integer, entao o saldo e arredondado; saldo_omie guarda o valor exato
// que a OMIE respondeu, para a reconciliacao comparar sem perder a fracao.
// quantidade_reservada_acpark nao e tocada, e saldo_disponivel_acpark e coluna gerada.
async function gravarSaldo(client, { pdvId, sku, quantidade }) {
  const exato = Number(quantidade) || 0;
  const inteiro = Math.round(exato);

  // Produto com saldo na OMIE que ainda nao tinha linha neste PDV entra como permitido = FALSE:
  // o saldo fica visivel, mas o que o PDV pode pedir continua sendo decisao do almoxarifado.
  // O WHERE EXISTS evita violar a integridade quando o produto ainda nao foi cadastrado.
  const gravado = await client.query(
    `INSERT INTO estoque_pdv
       (pdv_id, sku_produto, quantidade, saldo_omie, permitido, ultima_sincronizacao, sincronizacao_status)
     SELECT $1, $2, $3, $4, FALSE, CURRENT_TIMESTAMP, 'SINCRONIZADO'
     WHERE EXISTS (SELECT 1 FROM produtos WHERE sku = $2)
     ON CONFLICT (pdv_id, sku_produto) DO UPDATE
     SET quantidade = EXCLUDED.quantidade,
         saldo_omie = EXCLUDED.saldo_omie,
         ultima_sincronizacao = CURRENT_TIMESTAMP,
         sincronizacao_status = 'SINCRONIZADO'
     RETURNING (xmax = 0) AS inserido`,
    [pdvId, sku, inteiro, exato]
  );

  const linha = gravado.rows[0];
  if (!linha) return "sem_produto_local";
  return linha.inserido ? "criado" : "atualizado";
}

// Le a posicao de estoque de cada local vinculado e atualiza o saldo dos PDVs
export async function sincronizarSaldos(contexto) {
  const { client, integracao, segredos, payload, fetchImpl } = contexto;
  const vinculos = await listarVinculos(client, integracao.id);

  const resumo = {
    locais: vinculos.length,
    paginas: 0,
    recebidos: 0,
    atualizados: 0,
    criados: 0,
    sem_vinculo_de_produto: 0,
    sem_produto_local: 0,
    por_pdv: {}
  };

  if (!vinculos.length) {
    resumo.alerta =
      "Nenhum PDV vinculado a um local de estoque da OMIE. Importe os locais e crie os vinculos para o saldo comecar a chegar.";
    return resumo;
  }

  const dataPosicao = payload.dataPosicao || dataDeHoje();

  for (const vinculo of vinculos) {
    let pagina = 1;
    let totalPaginas = 1;

    do {
      let resposta;
      try {
        resposta = await chamarOmie({
          integracao,
          segredos,
          endpoint: ENDPOINTS.CONSULTA,
          call: CALL,
          params: {
            nPagina: pagina,
            nRegPorPagina: TAMANHO_PAGINA,
            dDataPosicao: dataPosicao,
            cExibeTodos: "S",
            codigo_local_estoque: Number(vinculo.omie_location_id) || vinculo.omie_location_id
          },
          fetchImpl
        });
      } catch (erro) {
        // Local sem posicao de estoque no periodo nao derruba a leitura dos outros locais
        if (ehSemRegistros(erro)) {
          resumo.locais_sem_saldo = (resumo.locais_sem_saldo || 0) + 1;
          break;
        }
        throw erro;
      }

      const lista = extrairLista(resposta.dados, CAMPOS_LISTA).map(mapearSaldo);
      totalPaginas = totalDePaginas(resposta.dados);
      resumo.paginas += 1;
      resumo.recebidos += lista.length;

      const skus = await mapaDeSkus(client, integracao.id, lista.map((item) => item.idExternoProduto).filter(Boolean));

      for (const saldo of lista) {
        const sku = skus.get(saldo.idExternoProduto) || saldo.skuExterno;
        if (!sku) {
          resumo.sem_vinculo_de_produto += 1;
          continue;
        }
        const efeito = await gravarSaldo(client, {
          pdvId: vinculo.pdv_acpark_id,
          sku,
          quantidade: saldo.quantidade
        });
        if (efeito === "atualizado") resumo.atualizados += 1;
        else if (efeito === "criado") resumo.criados += 1;
        else resumo.sem_produto_local += 1;

        if (efeito !== "sem_produto_local") {
          resumo.por_pdv[vinculo.pdv_nome] = (resumo.por_pdv[vinculo.pdv_nome] || 0) + 1;
        }
      }

      pagina += 1;
    } while (pagina <= totalPaginas);
  }

  if (resumo.sem_produto_local) {
    resumo.alerta = `${resumo.sem_produto_local} produtos vieram da OMIE sem cadastro local. Rode a sincronizacao de produtos antes.`;
  } else if (resumo.sem_vinculo_de_produto) {
    resumo.alerta = `${resumo.sem_vinculo_de_produto} saldos vieram de produtos ainda nao vinculados. Rode a sincronizacao de produtos antes.`;
  }

  resumo.cursor = { estatisticas: { ...resumo } };
  return resumo;
}

// Le o saldo de uma linha de listaEstoque (ObterEstoqueProduto).
// Confirmado contra a resposta real: os campos sao nSaldo, fisico e reservado.
function saldoDoLocal(linha = {}) {
  return converterNumero(linha.nSaldo ?? linha.fisico ?? linha.nFisico ?? linha.nDisponivel ?? 0);
}

// Atualizacao pontual do saldo de um produto, agendada quando chega um movimento novo.
//
// Usa ObterEstoqueProduto (estoque/resumo), que devolve o saldo do produto em TODOS os locais
// numa unica chamada. A versao anterior usava ListarPosEstoque e olhava apenas a pagina 1 de
// 101: qualquer produto fora dos 100 primeiros voltava como "nao encontrado".
export async function sincronizarSaldoDeItem(contexto) {
  const { client, integracao, segredos, configuracao, payload, fetchImpl } = contexto;
  const idExternoProduto = String(payload.idExternoProduto || "");

  if (!idExternoProduto) {
    return { atualizados: 0, alerta: "Job de saldo por item sem produto informado." };
  }

  const skus = await mapaDeSkus(client, integracao.id, [idExternoProduto]);
  const sku = skus.get(idExternoProduto);
  if (!sku) return { atualizados: 0, alerta: "Produto sem vinculo com SKU local." };

  const resposta = await chamarOmie({
    integracao,
    segredos,
    endpoint: ENDPOINTS.RESUMO,
    call: "ObterEstoqueProduto",
    params: { nIdProduto: Number(idExternoProduto) || idExternoProduto, dDia: dataDeHoje() },
    fetchImpl
  });

  const porLocal = extrairLista(resposta.dados, ["listaEstoque"]);
  if (!porLocal.length) {
    return { atualizados: 0, sku, alerta: "A OMIE nao devolveu posicao de estoque para este produto." };
  }

  const resumo = { sku, atualizados: 0, central_atualizado: false, pdvs_atualizados: 0, locais: porLocal.length };

  // O local do almoxarifado alimenta o estoque central
  const localAlmoxarifado = String(configuracao?.local_almoxarifado || "").trim();
  const noAlmoxarifado = porLocal.find((item) => String(item.nIdlocal) === localAlmoxarifado);
  if (localAlmoxarifado && noAlmoxarifado) {
    // Campos reais do listaEstoque: nSaldo / fisico / reservado. A documentacao promete
    // nFisico e nDisponivel, que NAO vem nesta resposta -- ler so por eles gravaria zero
    // no estoque central de todo produto.
    const quantidade = saldoDoLocal(noAlmoxarifado);
    const gravou = await client.query(
      `UPDATE produtos
       SET qtd_total = $2,
           saldo_omie = $3,
           saldo_disponivel_acpark = $3 - COALESCE(quantidade_reservada_acpark, 0),
           ultima_sincronizacao = CURRENT_TIMESTAMP,
           sincronizacao_status = 'SINCRONIZADO'
       WHERE sku = $1`,
      [sku, Math.round(quantidade), quantidade]
    );
    if (gravou.rowCount > 0) {
      resumo.central_atualizado = true;
      resumo.atualizados += 1;
      resumo.saldo_central = quantidade;
    }
  }

  // O lado PDV so e escrito quando a politica permite. Sem esta checagem, MOVIMENTOS ->
  // SALDO_ITEM gravaria estoque_pdv automaticamente a cada 5 minutos, furando pela porta
  // dos fundos o bloqueio que existe na capacidade SALDOS.
  if (!SINCRONIZACAO_PDV_ATIVA) {
    resumo.pdv_ignorado = "Sincronizacao de estoque de PDV desligada; so o estoque central foi atualizado.";
    return resumo;
  }

  const vinculos = await listarVinculos(client, integracao.id);
  for (const vinculo of vinculos) {
    const noLocal = porLocal.find((item) => String(item.nIdlocal) === String(vinculo.omie_location_id));
    if (!noLocal) continue;
    const efeito = await gravarSaldo(client, {
      pdvId: vinculo.pdv_acpark_id,
      sku,
      quantidade: saldoDoLocal(noLocal)
    });
    if (efeito !== "sem_produto_local") {
      resumo.pdvs_atualizados += 1;
      resumo.atualizados += 1;
    }
  }

  return resumo;
}

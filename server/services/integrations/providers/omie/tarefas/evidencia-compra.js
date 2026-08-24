import {
  interpretarRazao,
  unidadeSuspeita
} from "../../../core/fator-evidencia.js";
import { limparEvidencia, registrarEvidencia } from "../../../core/fator-evidencia.repository.js";
import { chamarOmie, ehSemRegistros, ENDPOINTS } from "../omie.api.js";

const CALL = "ListarRecebimentos";

// 100 e o maximo que a API aceita nesta listagem -- conferido: com 100 ela devolve 100 e
// reporta 48 paginas para os 4.778 recebimentos da conta. Com 20 seriam 239 chamadas.
const POR_PAGINA = 100;

// Quantas paginas por job. Cada chamada com detalhes leva ~10s: 6 paginas ocupam ~1 minuto e
// o job devolve a vez para a fila, em vez de segurar o worker por oito minutos seguidos.
const PAGINAS_POR_JOB = 6;

// Falha isolada e pagina pesada; falha atras de falha e internet caida. So a segunda para a
// varredura -- a primeira apenas registra a pagina e segue.
const FALHAS_SEGUIDAS_ATE_PARAR = 3;

// Timeout proprio, bem acima do padrao de 15s.
//
// Uma pagina traz 100 recebimentos COM todos os itens detalhados, e medido leva ~10s em
// condicao normal -- ou seja, o padrao dava so 5s de folga. Na pratica uma pagina aleatoria
// estourava a cada varredura (foi a 37 numa execucao e a 3 na seguinte), sempre passando na
// retentativa: era aperto de prazo, nao pagina defeituosa.
const TIMEOUT_MS = 60_000;

// Converte a data brasileira da nota para ISO, que e o que a coluna date espera
function dataParaIso(texto) {
  const partes = String(texto || "").trim().split("/");
  if (partes.length !== 3) return null;
  const [dia, mes, ano] = partes;
  return `${ano}-${mes}-${dia}`;
}

// Extrai de um item de recebimento a evidencia de fator, ou null quando nao ha.
//
// O elo com o nosso cadastro e o nIdProduto, NUNCA o cEAN: medido no historico real, o EAN da
// nota casou com 12 de 147 produtos -- vem vazio com frequencia e, quando vem, costuma ser o
// EAN da embalagem do fornecedor, nao o da unidade que o PDV pede.
export function lerEvidenciaDoItem(item, cabecalho = {}) {
  const cab = item?.itensCabec || {};
  const ajuste = item?.itensAjustes || {};

  const idProduto = cab.nIdProduto ? String(cab.nIdProduto) : null;
  if (!idProduto) return null;

  const fator = interpretarRazao(cab.nQtdeNFe, ajuste.nQtdeRecebida);
  if (!fator) return null;

  return {
    externalProductId: idProduto,
    fator,
    data: dataParaIso(cabecalho.dEmissaoNFe),
    documento: {
      nota: cabecalho.cNumeroNFe || null,
      serie: cabecalho.cSerieNFe || null,
      emissao: cabecalho.dEmissaoNFe || null,
      fornecedor: cabecalho.cNome || cabecalho.cRazaoSocial || null,
      descricao: cab.cDescricaoProduto || null,
      quantidade_documento: cab.nQtdeNFe,
      unidade_documento: cab.cUnidadeNfe || null,
      quantidade_estoque: ajuste.nQtdeRecebida,
      unidade_estoque: ajuste.cUnidade || null,
      preco_unitario: cab.nPrecoUnit ?? null,
      // Mesmo rotulo dos dois lados: a razao vale, mas quem conferir precisa saber
      unidade_suspeita: unidadeSuspeita(cab.cUnidadeNfe, ajuste.cUnidade)
    }
  };
}

// Varre o historico de recebimentos de NF-e e acumula a evidencia documental de fator.
//
// NAO decide nada e NAO escreve fator em lugar nenhum: so junta o que os documentos dizem.
// A sugestao e derivada na leitura, e so vira fator depois de aprovada por uma pessoa.
export async function sincronizarEvidenciaDeCompra(contexto) {
  const { client, integracao, segredos, payload, fetchImpl } = contexto;

  const paginaInicial = Number(payload.pagina) || 1;

  const resumo = {
    pagina_inicial: paginaInicial,
    paginas_lidas: 0,
    recebimentos: 0,
    itens: 0,
    evidencias: 0,
    sem_id_produto: 0,
    fora_do_cadastro: 0,
    falhas: 0,
    paginas_com_falha: []
  };

  // A contagem de evidencia e acumulativa; reprocessar o historico sem limpar dobraria o
  // numero de vezes e daria a uma sugestao uma forca que ela nao tem.
  if (paginaInicial === 1) {
    resumo.evidencia_apagada = await limparEvidencia(client, integracao.id);
  }

  // So interessa produto que existe no nosso cadastro ativo; o resto da nota e ruido
  const mapeados = await client.query(
    `SELECT external_product_id FROM product_integration_mappings
     WHERE integration_id = $1 AND active = TRUE AND external_product_id IS NOT NULL`,
    [integracao.id]
  );
  const nossos = new Set(mapeados.rows.map((linha) => String(linha.external_product_id)));

  let totalPaginas = null;
  let falhasSeguidas = 0;

  for (let i = 0; i < PAGINAS_POR_JOB; i++) {
    const pagina = paginaInicial + i;
    if (totalPaginas && pagina > totalPaginas) break;

    let dados;
    try {
      const resposta = await chamarOmie({
        integracao,
        segredos,
        endpoint: ENDPOINTS.RECEBIMENTOS,
        call: CALL,
        params: { nPagina: pagina, nRegistrosPorPagina: POR_PAGINA, cExibirDetalhes: "S" },
        timeoutMs: TIMEOUT_MS,
        fetchImpl
      });
      dados = resposta.dados;
    } catch (erro) {
      // Pagina vazia encerra a varredura em vez de virar falha
      if (ehSemRegistros(erro)) break;

      // Uma pagina que falha NAO pode matar as seguintes.
      //
      // Medido em producao: a pagina 37 de 48 estoura o timeout de 15s (recebimento com
      // muitos itens), e como a versao anterior fazia `break`, as 11 paginas seguintes nunca
      // eram lidas -- nem nesta execucao nem nas proximas, porque a continuacao tambem
      // parava ali. A pagina fica registrada para nova tentativa e a varredura segue.
      resumo.falhas += 1;
      resumo.paginas_com_falha.push({ pagina, erro: String(erro.message).slice(0, 120) });
      falhasSeguidas += 1;
      // Varias falhas seguidas sao sinal de internet caida, nao de pagina pesada: aí sim para
      if (falhasSeguidas >= FALHAS_SEGUIDAS_ATE_PARAR) break;
      continue;
    }
    falhasSeguidas = 0;

    totalPaginas = Number(dados.nTotalPaginas) || totalPaginas;
    resumo.paginas_lidas += 1;
    resumo.paginas_tentadas = pagina - paginaInicial + 1;

    for (const recebimento of dados.recebimentos || []) {
      resumo.recebimentos += 1;
      const cabecalho = recebimento.cabec || {};
      for (const item of recebimento.itensRecebimento || []) {
        resumo.itens += 1;
        const evidencia = lerEvidenciaDoItem(item, cabecalho);
        if (!evidencia) {
          if (!item?.itensCabec?.nIdProduto) resumo.sem_id_produto += 1;
          continue;
        }
        if (!nossos.has(evidencia.externalProductId)) {
          resumo.fora_do_cadastro += 1;
          continue;
        }
        await registrarEvidencia(client, { integrationId: integracao.id, ...evidencia });
        resumo.evidencias += 1;
      }
    }
  }

  // Avanca pelas paginas TENTADAS, nao pelas lidas: contar so as lidas faria a continuacao
  // voltar para a pagina que falhou e travar o cursor nela indefinidamente.
  const proximaPagina = paginaInicial + Math.max(resumo.paginas_lidas + resumo.falhas, 0);
  resumo.total_paginas = totalPaginas;
  resumo.restantes = totalPaginas ? Math.max(0, totalPaginas - (proximaPagina - 1)) : null;

  // Encadeia a continuacao. A pagina entra no payload de proposito: a fila deduplica por
  // (integracao, capacidade, payload) e considera jobs em PROCESSANDO -- com payload igual,
  // "enfileirar" devolveria o proprio job que esta pedindo a continuacao e a varredura
  // pararia no primeiro lote, andando so no tick seguinte do relogio.
  //
  // A continuacao vale mesmo quando nada foi lido: se a unica pagina do lote falhou, parar
  // aqui deixaria o resto do historico inalcancavel.
  if (totalPaginas && proximaPagina <= totalPaginas) {
    await contexto.enfileirar("EVIDENCIA_COMPRA", { ...payload, pagina: proximaPagina }, { prioridade: "BAIXA" });
  }

  if (resumo.falhas) {
    const quais = resumo.paginas_com_falha.map((f) => f.pagina).join(", ");
    resumo.alerta = `${resumo.falhas} pagina(s) falharam e foram puladas (${quais}). A varredura seguiu adiante; rode de novo para tentar essas paginas.`;
  }

  return resumo;
}

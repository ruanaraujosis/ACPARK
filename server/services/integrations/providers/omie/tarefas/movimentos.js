import { chamarOmie, ehSemRegistros, ENDPOINTS, extrairLista, totalDePaginas } from "../omie.api.js";
import { chaveDeduplicacao, mapearMovimento } from "../omie.mappers.js";

const CALL = "ListarMovimentoEstoque";
// movProdutoListar e o campo real devolvido pelo ListarMovimentoEstoque nesta conta;
// os outros nomes ficam como plano B
const CAMPOS_LISTA = ["movProdutoListar", "movimentos", "cadastros", "listaMovimentos"];
const TAMANHO_PAGINA = 100;

// A consulta de movimentos da OMIE tem granularidade de dia. Reler o dia anterior a cada
// ciclo garante que nada caia na fresta entre uma execucao e outra; a deduplicacao por
// chave e que impede o movimento repetido de entrar duas vezes.
const DIAS_SOBREPOSICAO = 1;
const DIAS_PRIMEIRA_CARGA = 7;

function formatarData(data) {
  const dia = String(data.getDate()).padStart(2, "0");
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}/${data.getFullYear()}`;
}

// Janela de leitura: continua de onde parou, com sobreposicao; na primeira carga usa um
// intervalo curto para nao puxar o historico inteiro da empresa de uma vez.
export function calcularJanela(estado, { agora = new Date() } = {}) {
  const fim = new Date(agora);
  const referencia = estado?.last_success_at ? new Date(estado.last_success_at) : null;
  const inicio = new Date(agora);

  if (referencia && Number.isFinite(referencia.getTime())) {
    inicio.setTime(referencia.getTime());
    inicio.setDate(inicio.getDate() - DIAS_SOBREPOSICAO);
  } else {
    inicio.setDate(inicio.getDate() - DIAS_PRIMEIRA_CARGA);
  }

  return { inicio: formatarData(inicio), fim: formatarData(fim) };
}

// Locais cujas movimentacoes serao lidas: o almoxarifado (que e onde esta o movimento de
// verdade -- 2.093 em 90 dias nesta conta) mais cada local vinculado a um PDV.
//
// O almoxarifado entra com pdv_acpark_id nulo, porque nao e PDV: a coluna stock_movements.pdv_id
// aceita nulo justamente para isso. Antes a tarefa so lia locais de PDV, entao com zero
// vinculos ela concluia sem importar nada e o sistema ficava sem trilha de auditoria.
async function listarLocaisParaLer(client, integrationId, configuracao) {
  const locais = [];

  const almoxarifado = String(configuracao?.local_almoxarifado || "").trim();
  if (almoxarifado) {
    locais.push({
      omie_location_id: almoxarifado,
      pdv_acpark_id: null,
      rotulo: "ALMOXARIFADO",
      ehAlmoxarifado: true
    });
  }

  const vinculos = await client.query(
    `SELECT m.omie_location_id, m.pdv_acpark_id, p.nome AS pdv_nome
     FROM pdv_stock_location_mappings m
     LEFT JOIN pdvs p ON p.id = m.pdv_acpark_id
     WHERE m.integration_id = $1 AND m.active = TRUE`,
    [integrationId]
  );
  for (const vinculo of vinculos.rows) {
    // Um PDV vinculado ao mesmo local do almoxarifado geraria o movimento duas vezes
    if (String(vinculo.omie_location_id) === almoxarifado) continue;
    locais.push({
      omie_location_id: vinculo.omie_location_id,
      pdv_acpark_id: vinculo.pdv_acpark_id,
      rotulo: vinculo.pdv_nome || `PDV ${vinculo.pdv_acpark_id}`,
      ehAlmoxarifado: false
    });
  }

  return locais;
}

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

// Grava o movimento se ele ainda nao existir. Devolve o id quando inseriu, null quando
// era duplicado — e essa distincao que evita contar duas vezes o mesmo movimento.
async function gravarMovimento(client, { movimento, chave, pdvId, sku }) {
  const inserido = await client.query(
    `INSERT INTO stock_movements
       (omie_movement_id, operation_type, origin_system, external_reference, idempotency_key,
        pdv_id, omie_location_id, status, movement_date, synced_at, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'IMPORTADO', $8, CURRENT_TIMESTAMP, $9::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      movimento.idExterno || null,
      movimento.tipoOperacao,
      movimento.origem,
      movimento.referencia || null,
      chave,
      pdvId,
      movimento.idExternoLocal || null,
      movimento.data,
      JSON.stringify(movimento.bruto || {})
    ]
  );

  const id = inserido.rows[0]?.id;
  if (!id) return null;

  if (sku) {
    await client.query(
      `INSERT INTO stock_movement_items (movement_id, sku_produto, quantity)
       VALUES ($1, $2, $3)`,
      [id, sku, movimento.quantidade]
    );
  }
  return id;
}

// Importa os movimentos de estoque ja registrados na OMIE.
//
// Esta tarefa e somente leitura: o ACPARK nunca devolve baixa de venda para a OMIE, porque
// o Orion ja integra direto com ela. Cada movimento novo agenda a atualizacao de saldo do
// item afetado, que e o caminho rapido para o estoque do PDV refletir a venda.
export async function sincronizarMovimentos(contexto) {
  const { client, integracao, segredos, configuracao, estado, fetchImpl } = contexto;
  const locais = await listarLocaisParaLer(client, integracao.id, configuracao);

  const resumo = {
    locais: locais.length,
    paginas: 0,
    recebidos: 0,
    importados: 0,
    duplicados: 0,
    sem_vinculo_de_produto: 0,
    saldos_agendados: 0,
    por_origem: {},
    por_local: {}
  };

  if (!locais.length) {
    resumo.alerta =
      "Nenhum local para ler. Configure o local do almoxarifado ou vincule ao menos um PDV a um local da OMIE.";
    return resumo;
  }

  const janela = calcularJanela(estado);
  resumo.janela = janela;
  const itensParaAtualizarSaldo = new Set();

  for (const vinculo of locais) {
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
            dDtInicial: janela.inicio,
            dDtFinal: janela.fim,
            codigo_local_estoque: Number(vinculo.omie_location_id) || vinculo.omie_location_id
          },
          fetchImpl
        });
      } catch (erro) {
        // Local sem movimento no periodo nao e falha: a OMIE so nao tem o que devolver.
        // Sem isso, um PDV parado derrubaria a leitura de todos os outros locais.
        if (ehSemRegistros(erro)) {
          resumo.locais_sem_movimento = (resumo.locais_sem_movimento || 0) + 1;
          break;
        }
        throw erro;
      }

      const lista = extrairLista(resposta.dados, CAMPOS_LISTA).map(mapearMovimento);
      totalPaginas = totalDePaginas(resposta.dados);
      resumo.paginas += 1;
      resumo.recebidos += lista.length;

      const skus = await mapaDeSkus(client, integracao.id, lista.map((item) => item.idExternoProduto).filter(Boolean));

      for (const movimento of lista) {
        // O local vem do vinculo quando a OMIE nao repete o codigo na linha do movimento
        movimento.idExternoLocal ||= String(vinculo.omie_location_id);
        const sku = skus.get(movimento.idExternoProduto);
        if (!sku) resumo.sem_vinculo_de_produto += 1;

        const chave = chaveDeduplicacao(integracao.id, movimento);
        const id = await gravarMovimento(client, {
          movimento,
          chave,
          pdvId: vinculo.pdv_acpark_id,
          sku
        });

        if (!id) {
          resumo.duplicados += 1;
          continue;
        }
        resumo.importados += 1;
        resumo.por_origem[movimento.origem] = (resumo.por_origem[movimento.origem] || 0) + 1;
        resumo.por_local[vinculo.rotulo] = (resumo.por_local[vinculo.rotulo] || 0) + 1;

        // Saldo pontual so para local de PDV. O almoxarifado nao precisa: a capacidade
        // ESTOQUE_ALMOXARIFADO ja reescreve o catalogo inteiro a cada 15 minutos, entao
        // enfileirar um job CRITICA por produto movimentado seria trabalho repetido -- e,
        // numa primeira carga de 7 dias, encheria a fila de jobs de prioridade maxima que
        // tomariam a vez de todo o resto.
        if (!vinculo.ehAlmoxarifado && movimento.idExternoProduto) {
          itensParaAtualizarSaldo.add(`${movimento.idExternoProduto}|${movimento.idExternoLocal}`);
        }
      }

      pagina += 1;
    } while (pagina <= totalPaginas);
  }

  // Um job de saldo por item para cada produto/local que se mexeu, em prioridade critica
  for (const item of itensParaAtualizarSaldo) {
    const [idExternoProduto, idExternoLocal] = item.split("|");
    await contexto.enfileirar("SALDO_ITEM", { idExternoProduto, idExternoLocal }, { prioridade: "CRITICA" });
    resumo.saldos_agendados += 1;
  }

  resumo.cursor = { inicioSobreposicao: null, estatisticas: { ...resumo } };
  return resumo;
}

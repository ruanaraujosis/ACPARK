import { interpretarFator, STATUS_FATOR } from "../../../core/fator-conversao.js";
import { chamarOmie, ehSemRegistros, ENDPOINTS } from "../omie.api.js";

const CALL = "ConsultarProduto";

// Quantos produtos por job. A caracteristica NAO vem no ListarProdutos -- conferido contra a
// API: o campo existe com exibir_caracteristicas "S", mas voltou null em 100 de 100 produtos.
// So o ConsultarProduto traz, e ele e por produto. Com 5 mil produtos isso e uma varredura
// longa, entao o job processa um lote e agenda a continuacao, em vez de segurar a fila.
const PRODUTOS_POR_JOB = 60;

// Pausa curta a cada bloco: a OMIE ja devolveu "Consumo redundante detectado, aguarde 53
// segundos" nesta conta. Espacar as chamadas evita bater no limite e derrubar o lote inteiro.
const CHAMADAS_ANTES_DA_PAUSA = 10;
const PAUSA_MS = 400;

// Depois de lido, o fator so e relido passado este prazo -- o cadastro do ERP nao muda toda
// hora, e reler 5 mil produtos por ciclo gastaria a cota da API a troco de nada.
const DIAS_ATE_RELER = 7;

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Nomes das caracteristicas sao CONFIGURACAO, nunca fixos no codigo: o operador pode renomear
// no ERP (de UNIDADE para UNIDADES_POR_EMBALAGEM, por exemplo) sem exigir mudanca de programa.
export const PADRAO_CARACTERISTICA_FATOR = "UNIDADES_POR_EMBALAGEM";

function nomeDaCaracteristica(configuracao, chave, padrao) {
  return String(configuracao?.[chave] || padrao || "").trim();
}

// Compara nome de caracteristica ignorando acento e caixa -- o ERP e digitado a mao
function mesmaCaracteristica(a, b) {
  const normal = (v) =>
    String(v || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .toUpperCase();
  return normal(a) === normal(b) && normal(a) !== "";
}

// Acha o conteudo de uma caracteristica pelo nome configurado
function conteudoDaCaracteristica(caracteristicas, nomeProcurado) {
  if (!Array.isArray(caracteristicas) || !nomeProcurado) return null;
  const achada = caracteristicas.find((item) => mesmaCaracteristica(item?.cNomeCaract, nomeProcurado));
  return achada ? String(achada.cConteudo ?? "") : null;
}

// Predicado de "ainda falta ler".
//
// Sem releitura forcada: nunca lido, ou lido ha mais de DIAS_ATE_RELER.
// Com releitura forcada: lido antes do instante em que a releitura comecou. E esse instante
// que faz a varredura terminar -- sem ele, cada lote deixaria o produto "fresco" e a conta de
// restantes zeraria na primeira volta, parando a releitura no lote 1.
const CONDICAO_PENDENTE = `
  integration_id = $1
  AND external_product_id IS NOT NULL
  AND active = TRUE
  AND (
    CASE WHEN $2::timestamp IS NULL
      THEN (fator_lido_em IS NULL OR fator_lido_em < CURRENT_TIMESTAMP - ($3::int * INTERVAL '1 day'))
      ELSE (fator_lido_em IS NULL OR fator_lido_em < $2::timestamp)
    END
  )`;

async function listarPendentes(client, integrationId, limite, relerDesde) {
  const resultado = await client.query(
    `SELECT external_product_id, sku_produto
     FROM product_integration_mappings
     WHERE ${CONDICAO_PENDENTE}
     ORDER BY fator_lido_em NULLS FIRST, id
     LIMIT $4`,
    [integrationId, relerDesde, DIAS_ATE_RELER, limite]
  );
  return resultado.rows;
}

async function gravarFator(client, integrationId, externalProductId, leitura, embalagem) {
  await client.query(
    `UPDATE product_integration_mappings
     SET fator_conversao = $3,
         fator_status = $4,
         fator_conteudo_bruto = $5,
         embalagem = $6,
         fator_lido_em = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND external_product_id = $2`,
    [
      integrationId,
      externalProductId,
      leitura.fator,
      leitura.status,
      leitura.conteudo || null,
      String(embalagem || "").trim() || null
    ]
  );
}

// Le o fator de conversao de cada produto a partir das caracteristicas do cadastro no ERP.
//
// Produto sem a caracteristica fica UNITARIO (fator 1, vendido por unidade). Conteudo que
// nao seja inteiro puro fica INVALIDO e entra na lista de pendencias de cadastro -- nunca
// e adivinhado, porque um fator errado multiplica o pedido inteiro em silencio.
export async function sincronizarFatores(contexto) {
  const { client, integracao, segredos, configuracao, payload, fetchImpl } = contexto;

  const nomeFator = nomeDaCaracteristica(configuracao, "caracteristica_fator", PADRAO_CARACTERISTICA_FATOR);
  const nomeEmbalagem = nomeDaCaracteristica(configuracao, "caracteristica_embalagem", "");
  const limite = Math.min(Number(payload.limite) || PRODUTOS_POR_JOB, 200);

  // Releitura forcada: usada depois de configurar caracteristicas no ERP, quando esperar os
  // 7 dias do ciclo normal nao faz sentido. O instante de inicio viaja no payload para que
  // todas as continuacoes do mesmo mutirao usem a mesma referencia.
  const relerDesde = payload.reler ? payload.relerDesde || new Date().toISOString() : null;

  const pendentes = await listarPendentes(client, integracao.id, limite, relerDesde);

  const resumo = {
    modo: relerDesde ? "RELEITURA" : "PENDENTES",
    caracteristica_fator: nomeFator,
    caracteristica_embalagem: nomeEmbalagem || null,
    lidos: 0,
    com_fator: 0,
    unitarios: 0,
    invalidos: 0,
    nao_encontrados: 0,
    falhas: 0,
    exemplos_invalidos: []
  };

  if (!pendentes.length) {
    resumo.alerta = undefined;
    return resumo;
  }

  for (const [indice, item] of pendentes.entries()) {
    if (indice && indice % CHAMADAS_ANTES_DA_PAUSA === 0) await dormir(PAUSA_MS);

    try {
      const resposta = await chamarOmie({
        integracao,
        segredos,
        endpoint: ENDPOINTS.PRODUTOS,
        call: CALL,
        params: { codigo_produto: Number(item.external_product_id) || item.external_product_id },
        fetchImpl
      });

      const caracteristicas = resposta.dados?.caracteristicas;
      const conteudo = conteudoDaCaracteristica(caracteristicas, nomeFator);
      const leitura = interpretarFator(conteudo);
      const embalagem = nomeEmbalagem ? conteudoDaCaracteristica(caracteristicas, nomeEmbalagem) : null;

      await gravarFator(client, integracao.id, item.external_product_id, leitura, embalagem);

      resumo.lidos += 1;
      if (leitura.status === STATUS_FATOR.DEFINIDO) resumo.com_fator += 1;
      else if (leitura.status === STATUS_FATOR.UNITARIO) resumo.unitarios += 1;
      else {
        resumo.invalidos += 1;
        if (resumo.exemplos_invalidos.length < 5) {
          resumo.exemplos_invalidos.push({ sku: item.sku_produto, conteudo: leitura.conteudo });
        }
      }
    } catch (erro) {
      // Produto que sumiu do ERP nao e falha da leitura: marca como lido para nao travar a fila
      if (ehSemRegistros(erro)) {
        resumo.nao_encontrados += 1;
        await gravarFator(
          client,
          integracao.id,
          item.external_product_id,
          { status: STATUS_FATOR.UNITARIO, fator: 1, conteudo: "" },
          null
        );
        continue;
      }
      resumo.falhas += 1;
      // Uma falha de rede no meio do lote nao deve descartar o que ja foi lido
      break;
    }
  }

  // Ainda ha produtos por ler: agenda a continuacao
  const restantes = await client.query(
    `SELECT COUNT(*)::int AS n FROM product_integration_mappings WHERE ${CONDICAO_PENDENTE}`,
    [integracao.id, relerDesde, DIAS_ATE_RELER]
  );
  resumo.restantes = restantes.rows[0]?.n || 0;

  if (resumo.restantes > 0 && resumo.lidos > 0) {
    // O numero do lote entra no payload de proposito. A fila deduplica por
    // (integracao, capacidade, payload) e considera o job em PROCESSANDO -- ou seja, o proprio
    // job que esta pedindo a continuacao. Com payload identico, "enfileirar" devolvia o job
    // atual em vez de criar o proximo, a continuacao era engolida em silencio, e a varredura
    // so avancava no tick seguinte do relogio: 60 produtos a cada 30 minutos, ~36 horas para
    // os 4.306 restantes. Com o lote, cada continuacao e um job distinto e a fila encadeia.
    await contexto.enfileirar(
      "FATORES",
      { ...payload, lote: Number(payload.lote || 0) + 1, relerDesde: relerDesde || undefined },
      { prioridade: "NORMAL" }
    );
  }

  if (resumo.invalidos) {
    resumo.alerta = `${resumo.invalidos} produto(s) com fator invalido no cadastro do ERP. Veja a lista de pendencias e corrija la.`;
  } else if (resumo.falhas) {
    resumo.alerta = `A leitura parou apos ${resumo.lidos} produto(s) por falha na API. O restante continua na proxima execucao.`;
  }

  return resumo;
}

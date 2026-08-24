import { emSimulacao, modoDeEscrita } from "../../../core/escrita.js";
import {
  listarAprovadasNaoEscritas,
  marcarEscrita,
  marcarEscritaSimulada
} from "../../../core/fator-evidencia.repository.js";
import { chamarOmie, ehSemRegistros, ENDPOINTS } from "../omie.api.js";
import { PADRAO_CARACTERISTICA_FATOR } from "./fatores.js";

const LISTAR = "ListarCaractProduto";
const INCLUIR = "IncluirCaractProduto";
const ALTERAR = "AlterarCaractProduto";

// Poucos por job de proposito: a API nao aceita chamada simultanea em inclusao/alteracao, e
// cada produto custa duas chamadas (consulta + gravacao). 25 produtos = ate 50 chamadas.
const PRODUTOS_POR_JOB = 25;

// Pausa entre produtos: o limite e 240 requisicoes por minuto e repetir uma chamada identica
// devolve "Consumo redundante detectado, aguarde N segundos"
const PAUSA_MS = 300;

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nomeDaCaracteristica(configuracao) {
  return String(configuracao?.caracteristica_fator || PADRAO_CARACTERISTICA_FATOR).trim();
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

// Descobre se o produto ja tem a caracteristica, e com que conteudo.
//
// Este passo NAO e opcional: incluir sobre uma caracteristica que ja existe e erro na API, e
// sobrescrever as cegas apagaria um valor que alguem pode ter conferido a mao no ERP.
async function caracteristicaAtual(contexto, externalProductId, nome) {
  const { integracao, segredos, fetchImpl } = contexto;
  try {
    const resposta = await chamarOmie({
      integracao,
      segredos,
      endpoint: ENDPOINTS.CARACTERISTICAS,
      call: LISTAR,
      params: { nPagina: 1, nRegPorPagina: 50, nCodProd: Number(externalProductId) },
      fetchImpl
    });
    const lista = resposta.dados?.listaCaracteristicas || [];
    return lista.find((item) => mesmaCaracteristica(item?.cNomeCaract, nome)) || null;
  } catch (erro) {
    // Produto sem caracteristica nenhuma responde "nao existem registros"
    if (ehSemRegistros(erro)) return null;
    throw erro;
  }
}

// Descobre o codigo interno da caracteristica alvo no ERP.
//
// A API identifica a caracteristica por nCodCaract ou cCodIntCaract -- NUNCA pelo nome: o
// campo cNomeCaract nao existe no request de inclusao, conferido contra a documentacao. Como
// o nome e configuracao e o codigo nao pode ser cravado no programa, ele e descoberto a
// partir de um produto que JA tenha a caracteristica preenchida.
//
// Sem esse codigo a gravacao para com erro explicito, em vez de enviar payload invalido e
// descobrir isso produto a produto.
async function descobrirCodigoDaCaracteristica(contexto, nome) {
  const { client, integracao } = contexto;

  // Produtos cuja leitura ja encontrou a caracteristica: sao eles que carregam o codigo
  const candidatos = await client.query(
    `SELECT external_product_id FROM product_integration_mappings
     WHERE integration_id = $1 AND active = TRUE AND fator_status = 'DEFINIDO'
       AND external_product_id IS NOT NULL
     LIMIT 5`,
    [integracao.id]
  );

  for (const candidato of candidatos.rows) {
    const achada = await caracteristicaAtual(contexto, candidato.external_product_id, nome);
    if (achada?.nCodCaract) return Number(achada.nCodCaract);
  }
  return null;
}

// Monta o payload da gravacao. Fica separado para que o modo simulacao registre exatamente
// o que seria enviado, sem uma segunda versao do payload divergir da real.
export function montarPayloadCaracteristica({ externalProductId, nCodCaract, fator }) {
  return {
    nCodProd: Number(externalProductId),
    // Identificacao pelo codigo, sempre. O nome nao serve: cNomeCaract nao faz parte do
    // request de inclusao, e mandar o nome faria a API recusar produto a produto.
    nCodCaract: Number(nCodCaract),
    cConteudo: String(fator),
    cExibirItemNF: "N",
    cExibirItemPedido: "N",
    cExibirOrdemProd: "N"
  };
}

// Grava no cadastro do ERP os fatores que uma pessoa aprovou na tela de revisao.
//
// So toca em produto com decisao APROVADA. Sugestao nao aprovada, conflito e produto sem
// evidencia nunca chegam aqui -- a fila da escrita e alimentada pela decisao humana, nao
// pela derivacao.
//
// Nasce em modo SIMULACAO, pela mesma trava generica das transferencias: monta o payload,
// registra o que seria enviado e nao envia.
export async function escreverFatoresAprovados(contexto) {
  const { client, integracao, segredos, configuracao, payload, fetchImpl } = contexto;

  const nome = nomeDaCaracteristica(configuracao);
  const simulacao = emSimulacao(configuracao);
  const limite = Math.min(Number(payload.limite) || PRODUTOS_POR_JOB, 100);

  // Um produto so: a virada para real comeca com um envio conferido na tela do ERP
  const apenas = payload.apenas ? String(payload.apenas) : null;
  const aprovados = await listarAprovadasNaoEscritas(client, integracao.id, limite, apenas);

  const resumo = {
    modo_escrita: modoDeEscrita(configuracao),
    caracteristica: nome,
    apenas: apenas || null,
    aprovados: aprovados.length,
    gravados: 0,
    simulados: 0,
    incluidos: 0,
    alterados: 0,
    ja_iguais: 0,
    falhas: 0,
    exemplos: []
  };

  if (!aprovados.length) return resumo;

  const codigoCaracteristica = await descobrirCodigoDaCaracteristica(contexto, nome);
  resumo.codigo_caracteristica = codigoCaracteristica;
  if (!codigoCaracteristica) {
    resumo.alerta = `Nao foi possivel descobrir o codigo da caracteristica "${nome}" no ERP. Preencha-a a mao em pelo menos um produto e rode de novo -- a API identifica caracteristica por codigo, nunca por nome.`;
    resumo.falhas = resumo.aprovados;
    return resumo;
  }

  for (const [indice, item] of aprovados.entries()) {
    if (indice) await dormir(PAUSA_MS);

    // Fator 1 nao vai para o ERP: produto sem a caracteristica ja e lido como unitario, entao
    // gravar "1" nao muda comportamento nenhum e so suja o cadastro.
    if (Number(item.fator_decidido) === 1) {
      await marcarEscrita(client, integracao.id, item.external_product_id, {
        operacao: "NENHUMA",
        resposta: { ignorado: "fator 1 nao precisa de caracteristica" }
      });
      resumo.ignorados_fator_um = (resumo.ignorados_fator_um || 0) + 1;
      continue;
    }

    try {
      const atual = await caracteristicaAtual(contexto, item.external_product_id, nome);

      // Ja esta com o valor aprovado: marcar como escrito sem gastar uma chamada de gravacao.
      // E isto que torna a reexecucao inofensiva -- rodar de novo nao duplica caracteristica
      // nem reescreve o que ja esta certo.
      if (atual && String(atual.cConteudo ?? "").trim() === String(item.fator_decidido)) {
        await marcarEscrita(client, integracao.id, item.external_product_id, {
          valorAnterior: String(atual.cConteudo ?? ""),
          operacao: "NENHUMA",
          resposta: { ja_estava_correto: true }
        });
        resumo.ja_iguais += 1;
        continue;
      }

      // O ERP ja tem um valor DIFERENTE do aprovado: nao sobrescreve.
      //
      // Ler antes de gravar existia para escolher entre incluir e alterar, mas o valor lido
      // tambem e uma trava: alguem pode ter conferido aquele numero a mao no cadastro, e o
      // assistente nao pode apagar isso em silencio. Aconteceu com AGUA SEM GAS, que tinha
      // "15" no ERP e recebeu 12 vindo da planilha. Agora vira pendencia para uma pessoa.
      if (atual && String(atual.cConteudo ?? "").trim()) {
        await marcarEscrita(client, integracao.id, item.external_product_id, {
          valorAnterior: String(atual.cConteudo ?? ""),
          operacao: "RECUSADA",
          erro: `O ERP ja tem ${JSON.stringify(atual.cConteudo)} nesta caracteristica e o aprovado e ${item.fator_decidido}. Nao foi sobrescrito: confira qual dos dois vale.`
        });
        resumo.conflito_com_erp = (resumo.conflito_com_erp || 0) + 1;
        continue;
      }

      const corpo = montarPayloadCaracteristica({
        externalProductId: item.external_product_id,
        nCodCaract: atual?.nCodCaract || codigoCaracteristica,
        fator: item.fator_decidido
      });

      if (resumo.exemplos.length < 3) {
        resumo.exemplos.push({
          sku: item.sku_produto,
          operacao: atual ? ALTERAR : INCLUIR,
          conteudo_anterior: atual ? (atual.cConteudo ?? "") : null,
          payload: corpo
        });
      }

      // Simulacao registra a auditoria completa do que SERIA enviado, sem enviar. Assim a
      // tela mostra exatamente o payload que vai sair quando o modo virar REAL.
      if (simulacao) {
        await marcarEscritaSimulada(client, integracao.id, item.external_product_id, {
          valorAnterior: atual ? String(atual.cConteudo ?? "") : null,
          operacao: atual ? ALTERAR : INCLUIR,
          payload: corpo
        });
        resumo.simulados += 1;
        continue;
      }

      const resposta = await chamarOmie({
        integracao,
        segredos,
        endpoint: ENDPOINTS.CARACTERISTICAS,
        call: atual ? ALTERAR : INCLUIR,
        params: corpo,
        fetchImpl
      });

      await marcarEscrita(client, integracao.id, item.external_product_id, {
        valorAnterior: atual ? String(atual.cConteudo ?? "") : null,
        operacao: atual ? ALTERAR : INCLUIR,
        payload: corpo,
        resposta: resposta?.dados ?? null
      });
      resumo.gravados += 1;
      if (atual) resumo.alterados += 1;
      else resumo.incluidos += 1;
    } catch (erro) {
      resumo.falhas += 1;
      // O erro fica na propria decisao: quem revisou precisa ver o que aconteceu com o item
      // dele, e nao um numero agregado escondido no resumo do job.
      await marcarEscrita(client, integracao.id, item.external_product_id, {
        erro: String(erro.message).slice(0, 400)
      });
    }
  }

  if (simulacao) {
    resumo.alerta = `Modo SIMULACAO: ${resumo.simulados} fator(es) foram montados e NAO enviados. Configure modo_escrita = REAL para gravar de verdade.`;
  } else if (resumo.falhas) {
    resumo.alerta = `${resumo.falhas} fator(es) falharam ao gravar. Veja o erro em cada linha da tela de revisao.`;
  }

  return resumo;
}

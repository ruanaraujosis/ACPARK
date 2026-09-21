import { emSimulacao } from "../../../core/escrita.js";
import {
  categoriasSemVinculo,
  ensureCategoriaVinculoTable,
  listarVinculos,
  marcarVinculoAusente,
  renomearCategoria,
  salvarVinculo,
} from "../../../core/categoria-vinculo.repository.js";
import {
  chamarOmie,
  ENDPOINTS,
  extrairLista,
  totalDePaginas,
} from "../omie.api.js";

const LISTAR = "PesquisarFamilias";
const INCLUIR = "IncluirFamilia";
// A listagem de familias nao se chama "ListarFamilias" -- esse metodo nao existe na API e
// responde 'Method "ListarFamilias" not exists'. Conferido contra a conta em 21/09/2026.
const CAMPOS_LISTA = ["famCadastro", "familia_cadastro", "cadastros"];
const TAMANHO_PAGINA = 50;

// Liberacao da criacao de familia no ERP, por integracao. Fica separada do modo_escrita de
// proposito: a integracao ja esta em REAL por causa da transferencia de estoque, entao uma
// capacidade de escrita nova herdaria REAL sem nunca ter passado por simulacao.
export const CHAVE_CRIAR_FAMILIA = "criar_familia_na_omie";

// Mesma comparacao usada na tarefa de produtos: acento e caixa nao criam categoria nova,
// porque pdv_categorias amarra a permissao do PDV pelo nome.
function chaveDeCategoria(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase();
}

function criacaoLiberada(configuracao = {}) {
  return (
    String(configuracao?.[CHAVE_CRIAR_FAMILIA] || "")
      .trim()
      .toUpperCase() === "SIM"
  );
}

// Codigo interno da familia nova, seguindo o padrao da conta: numeros sequenciais.
// Nunca reaproveita codigo em uso -- duas familias com o mesmo codigo confundem o operador
// na tela do ERP.
export function proximoCodigoDeFamilia(familias = []) {
  const usados = familias
    .map((f) => Number(String(f?.codFamilia ?? "").replace(/\D/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return String(Math.max(0, ...usados) + 1);
}

// Codigo de integracao: marca quem criou a familia, para dar para auditar do lado do ERP
export function codigoDeIntegracaoDaCategoria(nome) {
  const limpo = chaveDeCategoria(nome)
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `MYESTOQUE-${limpo}`.slice(0, 60);
}

export function montarPayloadFamilia({ nome, codFamilia }) {
  return {
    codInt: codigoDeIntegracaoDaCategoria(nome),
    codFamilia: String(codFamilia),
    nomeFamilia: String(nome).trim(),
  };
}

// Le todas as familias do ERP
async function lerFamilias(contexto) {
  const { integracao, segredos, fetchImpl } = contexto;
  const familias = [];
  let pagina = 1;
  let totalPaginas = 1;
  do {
    const resposta = await chamarOmie({
      integracao,
      segredos,
      endpoint: ENDPOINTS.FAMILIAS,
      call: LISTAR,
      params: {
        pagina,
        registros_por_pagina: TAMANHO_PAGINA,
        apenas_importado_api: "N",
      },
      fetchImpl,
    });
    familias.push(...extrairLista(resposta.dados, CAMPOS_LISTA));
    totalPaginas = totalDePaginas(resposta.dados);
    pagina += 1;
  } while (pagina <= totalPaginas);
  return familias;
}

// Mantem categoria local e familia do ERP sincronizadas nos dois sentidos.
//
// Regras, decididas com o usuario em 21/09/2026:
//  - o ERP manda no NOME: familia renomeada la renomeia a categoria aqui (e a renomeacao
//    leva junto produtos, produto_categorias e pdv_categorias, que guardam o nome solto);
//  - o MyEstoque pode CRIAR familia que ainda nao existe no ERP, nunca renomear nem excluir;
//  - exclusao nunca propaga em nenhum sentido: familia que sumiu vira alerta e o vinculo e
//    desativado. Foi o que aconteceu em 21/09/2026 -- a familia MANIPULADOS foi excluida no
//    ERP e 400 produtos ficaram sem agrupamento, sem aviso nenhum.
export async function sincronizarCategorias(contexto) {
  const { client, integracao, segredos, configuracao, fetchImpl } = contexto;
  await ensureCategoriaVinculoTable(client);

  const resumo = {
    familiasLidas: 0,
    vinculosCriados: 0,
    categoriasCriadas: 0,
    categoriasRenomeadas: 0,
    familiasAusentes: 0,
    familiasCriadasNoErp: 0,
    criacoesSimuladas: 0,
    falhas: 0,
    avisos: [],
  };

  const familias = await lerFamilias(contexto);
  resumo.familiasLidas = familias.length;
  if (!familias.length) {
    resumo.avisos.push(
      "O ERP nao devolveu nenhuma familia; nada foi alterado.",
    );
    return resumo;
  }

  const vinculos = await listarVinculos(client, integracao.id);
  const porExterno = new Map(vinculos.map((v) => [String(v.external_id), v]));

  const categoriasLocais = await client.query("SELECT nome FROM categorias");
  const porChaveLocal = new Map(
    (categoriasLocais.rows || []).map((l) => [
      chaveDeCategoria(l.nome),
      l.nome,
    ]),
  );

  for (const familia of familias) {
    const externalId = String(familia?.codigo ?? "").trim();
    const nome = String(familia?.nomeFamilia ?? "").trim();
    if (!externalId || !nome) continue;

    const vinculo = porExterno.get(externalId);
    let categoria = nome;

    if (vinculo) {
      // Mesmo identificador, nome diferente: renomeacao no ERP. O ERP manda no nome.
      if (chaveDeCategoria(vinculo.categoria) !== chaveDeCategoria(nome)) {
        const { renomeada } = await renomearCategoria(
          client,
          vinculo.categoria,
          nome,
        );
        if (renomeada) {
          resumo.categoriasRenomeadas += 1;
          resumo.avisos.push(
            `Categoria "${vinculo.categoria}" renomeada para "${nome}" (nome veio do ERP).`,
          );
          porChaveLocal.delete(chaveDeCategoria(vinculo.categoria));
          porChaveLocal.set(chaveDeCategoria(nome), nome);
        }
      } else {
        categoria = vinculo.categoria;
      }
    } else {
      // Sem vinculo ainda: reaproveita a categoria local de mesmo nome (a menos de acento e
      // caixa) em vez de criar uma variante, que tiraria produtos de baixo da permissao.
      const existente = porChaveLocal.get(chaveDeCategoria(nome));
      if (existente) {
        categoria = existente;
      } else {
        await client.query(
          "INSERT INTO categorias (nome) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM categorias WHERE nome = $1)",
          [nome],
        );
        porChaveLocal.set(chaveDeCategoria(nome), nome);
        resumo.categoriasCriadas += 1;
      }
      resumo.vinculosCriados += 1;
    }

    await salvarVinculo(client, {
      integrationId: integracao.id,
      externalId,
      externalCode: familia?.codFamilia ?? null,
      externalName: nome,
      categoria,
    });
  }

  // Familia que sumiu do ERP: alerta, nunca exclusao da categoria local
  const idsVivos = new Set(familias.map((f) => String(f?.codigo ?? "").trim()));
  for (const vinculo of vinculos) {
    if (idsVivos.has(String(vinculo.external_id)) || !vinculo.active) continue;
    await marcarVinculoAusente(client, {
      integrationId: integracao.id,
      externalId: vinculo.external_id,
    });
    resumo.familiasAusentes += 1;
    resumo.avisos.push(
      `A familia "${vinculo.external_name}" (${vinculo.external_id}) sumiu do ERP. A categoria "${vinculo.categoria}" foi mantida aqui e os produtos ficaram sem agrupamento no ERP.`,
    );
  }

  // Categoria local que ainda nao existe no ERP: o MyEstoque pode criar
  const pendentes = await categoriasSemVinculo(client, integracao.id);
  if (pendentes.length) {
    const simulacao = emSimulacao(configuracao);
    const liberada = criacaoLiberada(configuracao);
    const codigosEmUso = familias.map((f) => ({ codFamilia: f?.codFamilia }));

    for (const nome of pendentes) {
      const payload = montarPayloadFamilia({
        nome,
        codFamilia: proximoCodigoDeFamilia(codigosEmUso),
      });

      if (!liberada || simulacao) {
        resumo.criacoesSimuladas += 1;
        resumo.avisos.push(
          `Criacao simulada da familia "${nome}" no ERP: ${JSON.stringify(payload)}`,
        );
        continue;
      }

      try {
        const resposta = await chamarOmie({
          integracao,
          segredos,
          endpoint: ENDPOINTS.FAMILIAS,
          call: INCLUIR,
          params: payload,
          fetchImpl,
        });
        const codigo = resposta?.dados?.codigo;
        if (!codigo)
          throw new Error("O ERP nao devolveu o codigo da familia criada.");
        codigosEmUso.push({ codFamilia: payload.codFamilia });
        await salvarVinculo(client, {
          integrationId: integracao.id,
          externalId: codigo,
          externalCode: payload.codFamilia,
          externalName: payload.nomeFamilia,
          categoria: nome,
        });
        resumo.familiasCriadasNoErp += 1;
      } catch (erro) {
        resumo.falhas += 1;
        resumo.avisos.push(
          `Falha ao criar a familia "${nome}" no ERP: ${String(erro.message).slice(0, 200)}`,
        );
      }
    }

    if (resumo.criacoesSimuladas) {
      resumo.alerta = liberada
        ? `Modo SIMULACAO: ${resumo.criacoesSimuladas} familia(s) foram montadas e NAO enviadas.`
        : `${resumo.criacoesSimuladas} categoria(s) locais nao existem no ERP. Ligue "${CHAVE_CRIAR_FAMILIA}" = SIM para que sejam criadas.`;
    }
  }

  if (resumo.familiasAusentes && !resumo.alerta) {
    resumo.alerta = `${resumo.familiasAusentes} familia(s) sumiram do ERP. As categorias locais foram mantidas -- reveja o agrupamento no ERP.`;
  }

  return resumo;
}

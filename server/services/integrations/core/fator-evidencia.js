import { interpretarFator } from "./fator-conversao.js";

// Regras de derivacao do fator de conversao a partir de evidencia documental de compra.
//
// Generico de proposito: recebe pares "quantidade no documento do fornecedor" x "quantidade
// que entrou no estoque" ja normalizados, e nao sabe de que ERP vieram. Quem fala com a API
// e o provider; aqui mora so a regra de o que vale como evidencia e o que vira sugestao.
//
// Regra inegociavel: SO evidencia documental gera sugestao. Nada de semelhanca de nome, de
// conhecimento de mercado ou de analogia com outro produto da mesma familia.
//
// Regra igualmente inegociavel: NADA aqui e conclusao. Toda saida desta funcao e uma sugestao
// que ainda precisa de confirmacao humana -- inclusive a de fator 1.

export const SITUACAO = {
  // Nenhum documento de compra encontrado para o produto. Fica pendente, sem sugestao.
  SEM_EVIDENCIA: "SEM_EVIDENCIA",
  // Todas as notas mostram compra avulsa.
  //
  // Isso NAO prova fator 1: o almoxarifado pode fracionar internamente uma embalagem que
  // nunca aparece em nota nenhuma, e nesse caso o PDV pede por uma embalagem que a evidencia
  // documental desconhece. Vira sugestao de fator 1 com confianca alta -- nunca fato.
  SO_AVULSO: "SO_AVULSO",
  // Exatamente um fator maior que 1 em toda a evidencia
  SUGERIDO: "SUGERIDO",
  // Mais de um fator, com cadastro coerente: o produto e comprado em formatos diferentes de
  // embalagem e os dois estao certos (caixa de 6 e display de 4). Quem escolhe qual e a
  // embalagem padrao de pedido do PDV e uma pessoa, olhando as opcoes.
  CONFLITO_EMBALAGEM: "CONFLITO_EMBALAGEM",
  // Dispersao alta e sem padrao: um mesmo codigo servindo produtos diferentes a cada compra.
  // Isso nao e conflito de fator, e cadastro errado -- forcar um fator aqui so carimba o
  // problema. Vai para a fila de correcao de cadastro e NAO recebe sugestao de fator.
  CADASTRO_GENERICO: "CADASTRO_GENERICO"
};

export const CONFIANCA = {
  // Notas de compra e planilha de fardos concordando: duas fontes independentes
  MAXIMA: "MAXIMA",
  ALTA: "ALTA",
  MEDIA: "MEDIA",
  UNICA: "UNICA"
};

// A partir de quantas notas concordando a sugestao e considerada de confianca alta
const NOTAS_PARA_CONFIANCA_ALTA = 4;

// A partir de quantos fatores distintos a dispersao deixa de ser "duas embalagens legitimas"
// e passa a ser suspeita de cadastro guarda-chuva. Dois formatos de compra e rotina; tres ou
// mais numeros diferentes para o mesmo codigo quase sempre e produto diferente na mesma linha.
const FATORES_DISTINTOS_ATE_CONFLITO = 2;

// Le a razao entre o que o fornecedor faturou e o que entrou no estoque.
//
// Devolve null quando a razao nao serve como fator. Reaproveita interpretarFator para nao
// existirem duas definicoes de "fator valido" no sistema -- a regra continua sendo inteiro
// puro e positivo, a mesma aplicada ao conteudo da caracteristica do ERP.
export function interpretarRazao(quantidadeDocumento, quantidadeEstoque) {
  const doDocumento = Number(quantidadeDocumento);
  const doEstoque = Number(quantidadeEstoque);
  if (!Number.isFinite(doDocumento) || !Number.isFinite(doEstoque)) return null;
  if (doDocumento <= 0 || doEstoque <= 0) return null;

  // As DUAS quantidades tem de ser inteiras, nao so a razao.
  //
  // Medido: "0,5 PCT -> 500 UND" produzia fator 1000, porque 500/0,5 e inteiro. Meia
  // embalagem e erro de lancamento, nao tamanho de fardo -- e um fator de 1000 multiplicaria
  // o pedido inteiro em silencio. Fracao no lado do estoque (4,448 KG) e igualmente ruido.
  if (!Number.isInteger(doDocumento) || !Number.isInteger(doEstoque)) return null;

  const razao = doEstoque / doDocumento;
  if (!Number.isInteger(razao)) return null;

  const leitura = interpretarFator(String(razao));
  return leitura.fator && leitura.fator >= 1 ? leitura.fator : null;
}

// O rotulo de unidade do documento nao e confiavel: medido no historico real, ha nota de
// "1 UN -> 12 UN" em que quem digitou usou UN para o display. A razao continua valendo, e a
// evidencia NUNCA e descartada por causa do texto -- o sinal so viaja junto para a tela.
export function unidadeSuspeita(unidadeDocumento, unidadeEstoque) {
  const normal = (v) => String(v || "").trim().toUpperCase();
  const a = normal(unidadeDocumento);
  const b = normal(unidadeEstoque);
  return Boolean(a && b && a === b);
}

// Classifica a forca da evidencia pelo numero de notas que concordam
export function classificarConfianca(vezes) {
  const n = Number(vezes) || 0;
  if (n >= NOTAS_PARA_CONFIANCA_ALTA) return CONFIANCA.ALTA;
  if (n >= 2) return CONFIANCA.MEDIA;
  return CONFIANCA.UNICA;
}

// Normaliza descricao de produto para comparacao entre notas
function normalizarDescricao(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toUpperCase();
}

// Descricoes diferentes nas notas do mesmo codigo PODEM indicar cadastro servindo produtos
// distintos ("CHOC LACTA DP12X28G LAKA" e "CHOC LACTA LAKA BCO 336GR" no mesmo codigo).
//
// Mas NAO serve para classificar: medido contra o historico real, cada fornecedor escreve o
// nome do mesmo produto de um jeito, e usar isso como criterio jogou COCA COLA ZERO, H2OH,
// TODDYNHO e ate a BATATA INGLESA na fila errada -- 42 produtos, varios deles com um unico
// fator observado. Vira aviso na tela, para quem confere olhar; a classificacao sai da
// dispersao dos fatores, que e o sinal que de fato distingue embalagem de cadastro torto.
export function descricoesDivergem(evidencias) {
  const distintas = new Set(
    evidencias
      .map((e) => normalizarDescricao(e?.documento?.descricao))
      .filter((d) => d.length > 0)
  );
  return distintas.size > 1;
}

// Fator herdado do cadastro gemeo.
//
// O mesmo item fisico as vezes existe duas vezes na OMIE -- um cadastro pelo codigo interno e
// outro pelo EAN -- e os duplicados nao podem ser excluidos, so inativados. O elo entre eles
// NAO e semelhanca de nome: e o `ean` de um sendo literalmente o SKU do outro, um fato que ja
// esta no cadastro.
//
// Um fardo do item fisico tem a mesma quantidade nos dois registros, entao o fator vale para
// os dois. Continua sendo sugestao: quem confirma e uma pessoa, e a tela diz de onde veio.
export function derivarDoGemeo(gemeo) {
  if (!gemeo || !gemeo.fator || gemeo.fator <= 1) return null;
  return {
    situacao: SITUACAO.SUGERIDO,
    fator: gemeo.fator,
    vezes: 0,
    // Sem rotulo de confianca: a evidencia e do gemeo, nao deste cadastro
    confianca: null,
    exigeConfirmacao: true,
    opcoes: [],
    herdadoDe: { sku: gemeo.sku, nome: gemeo.nome, fator: gemeo.fator },
    motivo: `Mesmo item fisico do cadastro "${gemeo.nome}" (${gemeo.sku}), que tem fator ${gemeo.fator}. Um fardo tem a mesma quantidade nos dois cadastros.`
  };
}

// Reune as tres fontes num objeto so, para a tela mostrar de onde veio cada numero
function montarFontes(fatorDasNotas, planilha, descricao) {
  return {
    notas: fatorDasNotas ? { fator: fatorDasNotas.fator, vezes: fatorDasNotas.vezes } : null,
    planilha: planilha
      ? {
          nome_operacao: planilha.nome_operacao,
          fator: planilha.fator,
          divergente: Boolean(planilha.divergente),
          valores_por_aba: planilha.valores_por_aba || null
        }
      : null,
    descricao: descricao ? { fator: descricao.fator, trecho: descricao.trecho } : null
  };
}

// Sobe a confianca para MAXIMA quando notas e planilha dizem o mesmo numero.
//
// Duas fontes independentes concordando e o padrao mais forte que este sistema alcanca: uma
// vem do documento fiscal, a outra da contagem fisica do almoxarifado. A descricao do produto
// e a terceira fonte, mas NAO promove sozinha -- e texto livre digitado no cadastro.
function combinarConfianca(confiancaDasNotas, fator, planilha) {
  if (planilha && planilha.fator && !planilha.divergente && planilha.fator === fator) {
    return CONFIANCA.MAXIMA;
  }
  return confiancaDasNotas;
}

// Transforma toda a evidencia de um produto numa situacao e, quando cabivel, numa sugestao.
//
// Espera linhas { fator, vezes, documento }. Nunca escolhe entre fatores concorrentes:
// havendo mais de um fator maior que 1, o resultado nunca e uma sugestao unica, ainda que um
// deles apareca em trinta notas e o outro em uma. Frequencia nao prova que o outro formato
// de embalagem deixou de existir -- e o de menos notas pode ser justamente o atual.
// Fator 1 nao precisa de configuracao nenhuma.
//
// Decisao do usuario, e ela bate com o comportamento do sistema: produto sem a caracteristica
// no ERP ja e tratado como UNITARIO, e o PDV pede em unidade de qualquer jeito. Confirmar e
// gravar "1" na OMIE seria trabalho humano e ruido no cadastro para nao mudar nada.
//
// A classificacao continua visivel (SO_AVULSO segue dizendo o que as notas mostram) -- o que
// muda e so a fila de conferencia deixar de cobrar decisao sobre esses.
export function derivarSugestao(evidencias, corroboracao = {}) {
  const resultado = derivarBruto(evidencias, corroboracao);

  // Sem fonte nenhuma nao ha o que decidir: e pendencia, nao conferencia. Cobrar uma decisao
  // sobre um produto do qual nao se sabe nada so encheria a fila de linhas mudas.
  if (resultado.situacao === SITUACAO.SEM_EVIDENCIA) {
    return { ...resultado, exigeConfirmacao: false };
  }

  if (resultado.fator === 1) {
    return {
      ...resultado,
      exigeConfirmacao: false,
      nadaAConfigurar: true,
      motivo: `${resultado.motivo} Nada a configurar: o PDV pede em unidade.`
    };
  }
  return resultado;
}

function derivarBruto(evidencias, corroboracao = {}) {
  const { planilha = null, descricao = null } = corroboracao;
  const linhas = (Array.isArray(evidencias) ? evidencias : [])
    .map((e) => ({ fator: Number(e.fator), vezes: Number(e.vezes) || 0, documento: e.documento }))
    .filter((e) => Number.isInteger(e.fator) && e.fator >= 1);

  if (!linhas.length) {
    // Sem nota, mas com a planilha vinculada: ela sozinha sugere, como evidencia unica.
    // Continua exigindo confirmacao -- uma fonte so nunca fecha questao.
    if (planilha && planilha.fator && !planilha.divergente) {
      return {
        situacao: SITUACAO.SUGERIDO,
        fator: planilha.fator,
        vezes: 0,
        confianca: CONFIANCA.UNICA,
        exigeConfirmacao: true,
        opcoes: [],
        fontes: montarFontes(null, planilha, descricao),
        motivo: `Sem nota de compra no periodo. A planilha de fardos diz ${planilha.fator} para "${planilha.nome_operacao}".`
      };
    }
    return {
      situacao: SITUACAO.SEM_EVIDENCIA,
      fator: null,
      vezes: 0,
      confianca: null,
      exigeConfirmacao: true,
      opcoes: [],
      fontes: montarFontes(null, planilha, descricao),
      motivo:
        planilha && planilha.divergente
          ? "Sem nota de compra, e a planilha se contradiz entre as abas. Confira a embalagem real."
          : "Nenhuma nota de compra encontrada para este produto no periodo varrido."
    };
  }

  const acimaDeUm = linhas.filter((e) => e.fator > 1).sort((a, b) => b.vezes - a.vezes);
  const avulso = linhas.find((e) => e.fator === 1);

  // Só compra avulsa: sugere 1, mas nao afirma 1
  if (!acimaDeUm.length) {
    const notas = avulso ? avulso.vezes : 0;
    return {
      situacao: SITUACAO.SO_AVULSO,
      fator: 1,
      vezes: notas,
      // Confianca deliberadamente NULA, por mais notas que existam.
      //
      // Medido no produto de referencia 7894900531008 (AGUA COM GAS): 18 notas registram
      // "10 CX -> 10 UNID" porque quem lancou o recebimento nao converteu -- e o fator real,
      // conferido a mao no ERP, e 15. Ou seja, o numero de notas aqui mede quantas vezes
      // ninguem converteu, nao o quanto se sabe. Chamar isso de "confianca alta" daria
      // seguranca a uma sugestao comprovadamente errada.
      confianca: null,
      exigeConfirmacao: true,
      opcoes: [],
      fontes: montarFontes({ fator: 1, vezes: notas }, planilha, descricao),
      // A planilha vence a leitura de "avulso": ela vem da contagem fisica, e a nota 1:1 pode
      // significar apenas que ninguem converteu no lancamento -- foi exatamente o que
      // aconteceu com a agua com gas ate 2025.
      ...(planilha && planilha.fator > 1 && !planilha.divergente
        ? {
            fator: planilha.fator,
            motivo: `As ${notas} nota(s) registram 1:1, mas a planilha de fardos diz ${planilha.fator} para "${planilha.nome_operacao}". Nota 1:1 costuma significar que quem lancou nao converteu, e a planilha vem da contagem fisica. Confira antes de confirmar.`
          }
        : {
            motivo: `${notas} nota(s) mostram compra avulsa, mas isso NAO prova fator 1: quando quem lanca o recebimento nao converte, a nota registra a mesma quantidade dos dois lados. Confira a embalagem real antes de confirmar.`
          })
    };
  }

  const opcoes = acimaDeUm.map((e) => ({
    fator: e.fator,
    vezes: e.vezes,
    confianca: classificarConfianca(e.vezes),
    documento: e.documento || null
  }));

  const nomesDivergem = descricoesDivergem(linhas);

  // A planilha prevalece sobre as notas -- inclusive quando as notas se contradizem.
  //
  // Decisao do usuario: a planilha e a contagem fisica do almoxarifado e esta correta. Caso
  // real: FANTA LARANJA tem notas com x1, x6 e x12 (formatos diferentes ao longo do tempo), e
  // a planilha diz 6. Sem esta regra o produto ficava travado em CONFLITO_EMBALAGEM esperando
  // uma escolha que a planilha ja responde.
  //
  // Duas excecoes deliberadas:
  //   - cadastro generico (dispersao alta) NAO e resolvido pela planilha: ali o problema e um
  //     codigo servindo produtos diferentes, e carimbar um fator so esconderia isso;
  //   - planilha que se contradiz entre as proprias abas nao tem numero para prevalecer.
  const planilhaDecide =
    planilha && planilha.fator && !planilha.divergente && acimaDeUm.length <= FATORES_DISTINTOS_ATE_CONFLITO;

  // Nome divergente entre notas NAO bloqueia a planilha: ja foi medido que cada fornecedor
  // escreve o mesmo produto de um jeito, e isso derrubaria justamente casos como a FANTA.
  if (planilhaDecide) {
    const fatorDasNotas = acimaDeUm[0];
    const concordam = planilha.fator === fatorDasNotas.fator;
    return {
      situacao: SITUACAO.SUGERIDO,
      fator: planilha.fator,
      vezes: concordam ? fatorDasNotas.vezes : 0,
      confianca: concordam ? CONFIANCA.MAXIMA : CONFIANCA.ALTA,
      exigeConfirmacao: true,
      opcoes: concordam
        ? opcoes
        : [{ fator: planilha.fator, vezes: 0, confianca: null, origem: "PLANILHA", documento: null }, ...opcoes],
      fontes: montarFontes(fatorDasNotas, planilha, descricao),
      ...(concordam ? {} : { divergeDasNotas: fatorDasNotas.fator }),
      tambemAvulso: avulso ? avulso.vezes : 0,
      motivo: concordam
        ? `${fatorDasNotas.vezes} nota(s) e a planilha de fardos concordam que a embalagem tem ${planilha.fator}.`
        : `A planilha de fardos diz ${planilha.fator} para "${planilha.nome_operacao}" e prevalece. As notas registram ${acimaDeUm.map((o) => `${o.fator} (${o.vezes}x)`).join(" e ")} -- outros formatos de embalagem, ou conversao nao feita no lancamento.`
    };
  }

  if (acimaDeUm.length > FATORES_DISTINTOS_ATE_CONFLITO) {
    return {
      situacao: SITUACAO.CADASTRO_GENERICO,
      fator: null,
      vezes: 0,
      confianca: null,
      exigeConfirmacao: false,
      opcoes,
      nomesDivergem,
      motivo: `Foram observados ${acimaDeUm.length} fatores diferentes sem padrao. Isso indica um cadastro generico usado para produtos distintos, nao uma embalagem. Corrigir no cadastro do ERP.`
    };
  }

  if (acimaDeUm.length > 1) {
    return {
      situacao: SITUACAO.CONFLITO_EMBALAGEM,
      fator: null,
      vezes: 0,
      confianca: null,
      exigeConfirmacao: true,
      opcoes,
      nomesDivergem,
      motivo: nomesDivergem
        ? "O produto foi comprado em dois formatos, e as notas descrevem produtos com nomes diferentes -- pode ser embalagem distinta ou cadastro compartilhado. Confira a nota antes de escolher."
        : "O produto foi comprado em mais de um formato de embalagem, e as duas notas estao certas. Escolha qual e a embalagem padrao de pedido do PDV."
    };
  }

  const fatorDasNotas = acimaDeUm[0];
  const fontes = montarFontes(fatorDasNotas, planilha, descricao);

  // Planilha com numero diferente do das notas: A PLANILHA PREVALECE.
  //
  // Decisao do usuario, que conhece a operacao: a planilha e a contagem fisica do
  // almoxarifado, e a nota reflete como o fornecedor faturou e como quem lancou o
  // recebimento digitou -- os dois podem estar certos sobre coisas diferentes, e o numero
  // que interessa ao PDV e o da contagem. Caso real: FANTA LARANJA, 43 notas dizendo 12
  // (caixa) contra a planilha dizendo 6 (fardo).
  //
  // Isso NAO vale quando a planilha se contradiz entre as proprias abas: ali ela nao tem um
  // numero para prevalecer, e a decisao volta a ser humana.
  if (planilha && planilha.fator && !planilha.divergente && planilha.fator !== fatorDasNotas.fator) {
    return {
      situacao: SITUACAO.SUGERIDO,
      fator: planilha.fator,
      vezes: 0,
      confianca: CONFIANCA.ALTA,
      exigeConfirmacao: true,
      opcoes: [
        { fator: planilha.fator, vezes: 0, confianca: null, origem: "PLANILHA", documento: null },
        ...opcoes
      ],
      fontes,
      divergeDasNotas: fatorDasNotas.fator,
      motivo: `A planilha de fardos diz ${planilha.fator} para "${planilha.nome_operacao}" e prevalece. As ${fatorDasNotas.vezes} nota(s) registram ${fatorDasNotas.fator} -- provavelmente outro formato de embalagem, ou conversao nao feita no lancamento.`
    };
  }

  return {
    situacao: SITUACAO.SUGERIDO,
    fator: fatorDasNotas.fator,
    vezes: fatorDasNotas.vezes,
    confianca: combinarConfianca(classificarConfianca(fatorDasNotas.vezes), fatorDasNotas.fator, planilha),
    exigeConfirmacao: true,
    fontes,
    // Produto tambem comprado avulso nao invalida a sugestao: a leitura certa e "quando vem
    // em embalagem, a embalagem tem N". A tela mostra as duas linhas para quem for conferir.
    tambemAvulso: avulso ? avulso.vezes : 0,
    opcoes,
    motivo:
      planilha && planilha.fator === fatorDasNotas.fator
        ? `${fatorDasNotas.vezes} nota(s) e a planilha de fardos concordam que a embalagem tem ${fatorDasNotas.fator}.`
        : `${fatorDasNotas.vezes} nota(s) concordam que a embalagem tem ${fatorDasNotas.fator}.`
  };
}

// Situacoes que pertencem a fila de correcao de cadastro, nao a de conferencia de fator
export function ehPendenciaDeCadastro(situacao) {
  return situacao === SITUACAO.CADASTRO_GENERICO;
}

// Frase curta para a tela de revisao explicar de onde saiu a sugestao
export function descreverEvidencia(documento) {
  if (!documento) return "";
  const { quantidade_documento, unidade_documento, quantidade_estoque, unidade_estoque } = documento;
  const doc = `${quantidade_documento} ${unidade_documento || ""}`.trim();
  const estoque = `${quantidade_estoque} ${unidade_estoque || ""}`.trim();
  return `${doc} → ${estoque}`;
}

import { interpretarFator, STATUS_FATOR } from "./fator-conversao.js";

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

// Reune as fontes num objeto so, para a tela mostrar de onde veio cada numero
function montarFontes(fatorDasNotas, descricao) {
  return {
    notas: fatorDasNotas ? { fator: fatorDasNotas.fator, vezes: fatorDasNotas.vezes } : null,
    descricao: descricao ? { fator: descricao.fator, trecho: descricao.trecho } : null
  };
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
  const { descricao = null } = corroboracao;
  const linhas = (Array.isArray(evidencias) ? evidencias : [])
    .map((e) => ({ fator: Number(e.fator), vezes: Number(e.vezes) || 0, documento: e.documento }))
    .filter((e) => Number.isInteger(e.fator) && e.fator >= 1);

  if (!linhas.length) {
    return {
      situacao: SITUACAO.SEM_EVIDENCIA,
      fator: null,
      vezes: 0,
      confianca: null,
      exigeConfirmacao: true,
      opcoes: [],
      fontes: montarFontes(null, descricao),
      motivo: "Nenhuma nota de compra encontrada para este produto no periodo varrido."
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
      fontes: montarFontes({ fator: 1, vezes: notas }, descricao),
      motivo: `${notas} nota(s) mostram compra avulsa, mas isso NAO prova fator 1: quando quem lanca o recebimento nao converte, a nota registra a mesma quantidade dos dois lados. Confira a embalagem real antes de confirmar.`
    };
  }

  const opcoes = acimaDeUm.map((e) => ({
    fator: e.fator,
    vezes: e.vezes,
    confianca: classificarConfianca(e.vezes),
    documento: e.documento || null
  }));

  const nomesDivergem = descricoesDivergem(linhas);

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
  const fontes = montarFontes(fatorDasNotas, descricao);

  return {
    situacao: SITUACAO.SUGERIDO,
    fator: fatorDasNotas.fator,
    vezes: fatorDasNotas.vezes,
    confianca: classificarConfianca(fatorDasNotas.vezes),
    exigeConfirmacao: true,
    fontes,
    // Produto tambem comprado avulso nao invalida a sugestao: a leitura certa e "quando vem
    // em embalagem, a embalagem tem N". A tela mostra as duas linhas para quem for conferir.
    tambemAvulso: avulso ? avulso.vezes : 0,
    opcoes,
    motivo: `${fatorDasNotas.vezes} nota(s) concordam que a embalagem tem ${fatorDasNotas.fator}.`
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

// Le um fator escrito na propria descricao do produto ("CX C/12", "FD 15", "PCT C/ 6").
//
// Terceira fonte, a mais fraca das duas restantes: e texto livre digitado no cadastro. Nunca
// vale sozinha contra a evidencia de nota -- entra so como confirmacao adicional na tela.
const PADROES_DESCRICAO = [
  // "CX C/12", "PCT C/ 6", "FD C/24"
  /\b(?:CX|CAIXA|FD|FARDO|PCT|PACOTE|DP|DISPLAY)\s*C\/?\s*(\d{1,4})\b/i,
  // "FD 15", "CX 12"
  /\b(?:CX|CAIXA|FD|FARDO|PCT|PACOTE|DP|DISPLAY)\s+(\d{1,4})\b/i,
  // "DP12X28G", "CX6X1250" -- sigla colada no numero, sem espaco nenhum
  /\b(?:CX|CAIXA|FD|FARDO|PCT|PACOTE|DP|DISPLAY)\s*(\d{1,4})\s*X\s*\d+/i,
  // "6X290ML", "12X28G" -- o primeiro numero e a contagem da embalagem
  /\b(\d{1,4})\s*X\s*\d+\s*(?:ML|G|L|KG)\b/i,
  // "C/12"
  /\bC\/\s*(\d{1,4})\b/i
];

export function lerFatorDaDescricao(descricao) {
  const texto = String(descricao || "");
  for (const padrao of PADROES_DESCRICAO) {
    const achado = texto.match(padrao);
    if (!achado) continue;
    const leitura = interpretarFator(achado[1]);
    if (leitura.status === STATUS_FATOR.DEFINIDO && leitura.fator > 1) {
      return { fator: leitura.fator, trecho: achado[0].trim() };
    }
  }
  return null;
}

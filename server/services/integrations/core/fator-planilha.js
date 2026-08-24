import { interpretarFator, STATUS_FATOR } from "./fator-conversao.js";

// Leitura da planilha de controle de fardos: fonte de CORROBORACAO do fator, ao lado das
// notas de compra.
//
// Generico de proposito -- recebe linhas ja extraidas (nome na coluna A, valor na coluna B) e
// nao sabe de que arquivo nem de que ERP vieram. O parse do arquivo acontece no navegador,
// como ja acontece na importacao de produtos.
//
// A planilha NAO grava fator sozinha. Ela e chaveada por nome de operacao, nao por SKU, e o
// casamento com o cadastro e textual e aproximado -- vira sugestao de vinculo para uma pessoa
// confirmar, nunca vinculo automatico.

// Valor da coluna B que nao e fator: e cabecalho de secao ou unidade de controle
const ROTULOS_DE_SECAO = new Set(["UND", "UN", "LT", "L", "FRD", "FD", "CX", "PCT", "KG"]);

// Le uma celula da coluna B. Devolve o fator, ou null quando a linha nao carrega fator.
//
// So numero inteiro positivo vale. "UND", "LT", "FRD" e "cx" sao cabecalho de secao ou item
// controlado por unidade, e nao geram fator -- mesmo criterio estrito do resto do sistema.
export function lerValorDaPlanilha(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "number") {
    return Number.isInteger(valor) && valor >= 1 ? valor : null;
  }
  const texto = String(valor).trim();
  if (!texto) return null;
  if (ROTULOS_DE_SECAO.has(texto.toUpperCase())) return null;
  const leitura = interpretarFator(texto);
  return leitura.status === STATUS_FATOR.DEFINIDO ? leitura.fator : null;
}

// Normaliza nome para comparacao: sem acento, sem pontuacao, caixa alta, espaco unico
export function normalizarNome(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toUpperCase();
}

// Junta as abas numa linha por nome de operacao.
//
// Regra de divergencia, deliberadamente mais fina que "as abas tem de bater":
//   - aba sem numero (celula vazia, cabecalho, ou "UND"/"FRD") NAO conta como discordancia,
//     porque significa apenas que aquela aba nao foi preenchida naquele periodo;
//   - dois numeros DIFERENTES sim: aí a planilha se contradiz e vira conflito, nunca media.
//
// Medido na planilha real: as duas abas discordam em 22 produtos, e quase todos sao "1 numa
// aba e 24 na outra" (cervejas de 600ml) ou "1 e 6" (energeticos) -- a aba de junho preencheu
// o tamanho do fardo onde a de abril contava por unidade. Tratar isso como media inventaria
// um numero que nenhuma das duas afirma.
export function reconciliarAbas(linhasPorAba) {
  const porNome = new Map();

  for (const [aba, linhas] of Object.entries(linhasPorAba || {})) {
    let secaoAtual = null;
    for (const linha of linhas || []) {
      const nome = String(linha?.nome || "").trim();
      if (!nome) continue;
      const fator = lerValorDaPlanilha(linha?.valor);

      // Linha sem fator cujo valor e rotulo de secao passa a ser o contexto das seguintes
      if (fator === null) {
        const bruto = String(linha?.valor ?? "").trim().toUpperCase();
        if (ROTULOS_DE_SECAO.has(bruto)) secaoAtual = nome;
      }

      const chave = normalizarNome(nome);
      if (!chave) continue;
      if (!porNome.has(chave)) {
        porNome.set(chave, { nome_operacao: nome, secao: secaoAtual, valores_por_aba: {} });
      }
      const registro = porNome.get(chave);
      registro.valores_por_aba[aba] = fator;
      if (!registro.secao && secaoAtual) registro.secao = secaoAtual;
    }
  }

  const saida = [];
  for (const registro of porNome.values()) {
    const numeros = Object.values(registro.valores_por_aba).filter((v) => v !== null && v !== undefined);
    const distintos = [...new Set(numeros)];

    saida.push({
      ...registro,
      // Sem numero em aba nenhuma: linha de cabecalho ou item controlado por unidade
      fator: distintos.length === 1 ? distintos[0] : null,
      divergente: distintos.length > 1,
      valores_distintos: distintos
    });
  }
  return saida;
}

// Modificadores que INVERTEM o sentido do nome. Se um lado tem e o outro nao, os produtos
// quase sempre sao diferentes, por mais palavras que dividam.
//
// Medido: "AGUA MINERAL GASOSA 500ML" divide tres palavras com "AGUA MINERAL SEM GAS 500ML"
// (o produto oposto) e so uma com "AGUA COM GAS" (o certo). Sem esta regra o comparador
// entrega o oposto como melhor candidato.
const MODIFICADORES_OPOSTOS = [
  ["SEM", "COM"],
  ["ZERO", null],
  ["DIET", null],
  ["LIGHT", null],
  ["S ALCOOL", "SEM ALCOOL"],
  ["TROPICAL", null],
  ["MELANCIA", null],
  ["MORANGO", null],
  ["MARACUJA", null],
  ["UVA", null],
  ["PESSEGO", null]
];

// Detecta se os dois nomes se contradizem num modificador
function seContradizem(tokensA, tokensB) {
  for (const [marca] of MODIFICADORES_OPOSTOS) {
    const partes = marca.split(" ");
    const temA = partes.every((t) => tokensA.has(t));
    const temB = partes.every((t) => tokensB.has(t));
    if (temA !== temB) return true;
  }
  return false;
}

// Quanto dois nomes se parecem, de 0 a 1.
//
// Compara conjuntos de palavras em vez de texto corrido: "AGUA MINERAL GASOSA 500ML" e
// "AGUA COM GAS" nao casam por prefixo nem por substring, mas dividem palavras.
//
// Tokens de duas letras CONTAM. Descarta-los fazia "COCA COLA LT" (lata) casar 100% com
// "COCA COLA 1.5L" (garrafa), porque os dois reduziam a {COCA, COLA} -- e "LT" era exatamente
// o que os distinguia. O certo era "COCA COLA 310ML", que ficava em segundo.
//
// O resultado e SEMPRE sugestao para uma pessoa confirmar -- nunca aplicado sozinho.
export function semelhanca(a, b) {
  const palavras = (t) => new Set(normalizarNome(t).split(" ").filter((p) => p.length >= 2));
  const x = palavras(a);
  const y = palavras(b);
  if (!x.size || !y.size) return 0;

  let comuns = 0;
  for (const p of x) if (y.has(p)) comuns += 1;
  const base = comuns / Math.max(x.size, y.size);

  // Contradicao de modificador derruba o candidato em vez de apenas descontar: "com gas" e
  // "sem gas" nao sao parecidos, sao opostos.
  return seContradizem(x, y) ? base * 0.35 : base;
}

// Confianca minima para a linha aparecer como sugestao de vinculo. Abaixo disso o ruido supera
// a ajuda -- e a linha vai para a fila de vinculo sem candidato, para busca manual.
const SEMELHANCA_MINIMA = 0.34;

// Sugere ate tres produtos para uma linha da planilha, ordenados por semelhanca.
//
// Nunca devolve "o" produto: devolve candidatos. Quem vincula e uma pessoa.
export function sugerirVinculos(nomeOperacao, produtos, limite = 3) {
  return (produtos || [])
    .map((produto) => ({
      external_product_id: produto.external_product_id,
      sku: produto.sku_produto,
      nome: produto.nome,
      semelhanca: Math.max(semelhanca(nomeOperacao, produto.nome), semelhanca(nomeOperacao, produto.sku_produto))
    }))
    .filter((c) => c.semelhanca >= SEMELHANCA_MINIMA)
    .sort((a, b) => b.semelhanca - a.semelhanca)
    .slice(0, limite);
}

// Le um fator escrito na propria descricao do produto ("CX C/12", "FD 15", "PCT C/ 6").
//
// Terceira fonte, a mais fraca das tres: e texto livre digitado no cadastro. Nunca vale
// sozinha contra as outras duas -- entra so como confirmacao adicional.
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

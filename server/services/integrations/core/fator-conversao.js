// Fator de conversao: quantas unidades tem a embalagem em que o PDV pede.
//
// Regra base do sistema, nao negociavel: o estoque e SEMPRE guardado na menor unidade.
// A embalagem e so a forma de pedir. Motivo: a baixa de venda que o sistema de vendas lanca
// no local do PDV e em unidade; guardar saldo em embalagem faria o saldo lido do ERP nunca
// fechar, e liberacao parcial produziria fracao.
//
// Este arquivo e generico: nenhum provider especifico aparece aqui. Quem sabe de onde o
// conteudo veio (caracteristica, campo proprio, planilha) e o provider.

export const STATUS_FATOR = Object.freeze({
  // Produto sem a caracteristica: vendido por unidade, fator 1
  UNITARIO: "UNITARIO",
  // Conteudo lido e valido
  DEFINIDO: "DEFINIDO",
  // Conteudo existe mas nao e inteiro puro -- entra na lista de pendencias de cadastro
  INVALIDO: "INVALIDO"
});

// Fator de quem nao tem embalagem declarada
export const FATOR_UNITARIO = 1;

// Interpreta o conteudo da caracteristica.
//
// SO inteiro puro e positivo e aceito. "15 un", "15,0", "fd c/ 15", "1.5", "15/UN" sao
// recusados de proposito: o campo e texto livre no ERP e adivinhar o numero certo a partir
// de texto ambiguo multiplicaria o pedido inteiro por um fator errado. Um produto com fator
// desconhecido e um problema visivel numa lista de pendencias; um produto com fator adivinhado
// errado e um problema invisivel que so aparece quando o estoque nao fecha.
export function interpretarFator(conteudoBruto) {
  const texto = String(conteudoBruto ?? "").trim();

  // Sem caracteristica = produto vendido por unidade
  if (!texto) {
    return { status: STATUS_FATOR.UNITARIO, fator: FATOR_UNITARIO, conteudo: "" };
  }

  // Inteiro puro: so digitos, sem sinal, sem separador, sem sufixo
  if (!/^\d+$/.test(texto)) {
    return {
      status: STATUS_FATOR.INVALIDO,
      fator: null,
      conteudo: texto,
      motivo: `Conteudo "${texto}" nao e um numero inteiro. Corrija no cadastro do produto para conter apenas o numero (ex: 15).`
    };
  }

  const fator = Number(texto);

  // Zero nao e embalagem; multiplicar por zero zeraria o pedido em silencio
  if (!Number.isSafeInteger(fator) || fator < 1) {
    return {
      status: STATUS_FATOR.INVALIDO,
      fator: null,
      conteudo: texto,
      motivo: `Conteudo "${texto}" precisa ser um numero inteiro maior que zero.`
    };
  }

  return { status: STATUS_FATOR.DEFINIDO, fator, conteudo: texto };
}

// Converte quantidade em embalagem para quantidade em unidade.
//
// Sempre inteiro: embalagem inteira x fator inteiro da inteiro. Se algum dos dois vier
// fracionado, a conta e recusada em vez de arredondar -- arredondar aqui significaria
// entregar quantidade diferente da pedida sem ninguem perceber.
export function converterParaUnidades(quantidadeEmbalagem, fator) {
  const embalagens = Number(quantidadeEmbalagem);
  const porEmbalagem = Number(fator);

  if (!Number.isFinite(embalagens) || embalagens <= 0) {
    throw new Error("Informe uma quantidade maior que zero.");
  }
  if (!Number.isSafeInteger(embalagens)) {
    throw new Error("A quantidade de embalagens precisa ser um numero inteiro.");
  }
  if (!Number.isSafeInteger(porEmbalagem) || porEmbalagem < 1) {
    throw new Error(
      "Este produto esta sem fator de conversao valido. Corrija o cadastro antes de pedir por embalagem."
    );
  }

  const unidades = embalagens * porEmbalagem;
  if (!Number.isSafeInteger(unidades)) {
    throw new Error("A conversao para unidades ultrapassou o limite seguro de numero inteiro.");
  }
  return unidades;
}

// Texto de apoio para a tela: "2 fardos = 30 un" ou "2 embalagens com 15 un = 30 un".
// Nunca inventa o nome da embalagem -- sem ele, fala genericamente.
export function descreverConversao({ quantidadeEmbalagem, fator, embalagem }) {
  const unidades = converterParaUnidades(quantidadeEmbalagem, fator);
  const nome = String(embalagem || "").trim();
  if (nome) {
    const plural = quantidadeEmbalagem > 1 ? `${nome}s` : nome;
    return `${quantidadeEmbalagem} ${plural.toLowerCase()} = ${unidades} un`;
  }
  return `${quantidadeEmbalagem} embalagem(ns) com ${fator} un = ${unidades} un`;
}

// Quantas embalagens completas cabem numa quantidade em unidade, e quanto sobra.
// Serve para a tela do almoxarifado mostrar "8 un (0 fardos + 8)" ao liberar parcial.
export function descreverEmEmbalagens(unidades, fator) {
  const total = Number(unidades) || 0;
  const porEmbalagem = Number(fator);
  if (!Number.isSafeInteger(porEmbalagem) || porEmbalagem < 2) return `${total} un`;

  const completas = Math.floor(total / porEmbalagem);
  const resto = total % porEmbalagem;
  if (!completas) return `${total} un`;
  if (!resto) return `${total} un (${completas} x ${porEmbalagem})`;
  return `${total} un (${completas} x ${porEmbalagem} + ${resto})`;
}

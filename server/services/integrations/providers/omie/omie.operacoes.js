// Operacoes de ESCRITA na OMIE (ACPARK -> OMIE).
//
// ATENCAO: nada aqui esta ligado ao sistema hoje. Este modulo guarda, em funcoes puras, o
// formato de payload e a regra de idempotencia que ja tinham sido levantados contra a API
// real de ajuste de estoque. A arquitetura anterior tinha uma fila propria para isso
// (tabela omie_jobs) que nunca foi chamada por lugar nenhum em producao.
//
// Quando a baixa de avaria no OMIE for ativada, ela entra como uma capacidade normal do
// provider (com direcao de escrita), usando a mesma fila integration_jobs das leituras.
// Enquanto isso nao acontece, este arquivo e so conhecimento preservado — nao ha caminho
// de codigo que envie escrita para a OMIE.

export const TIPOS_MOVIMENTO = Object.freeze({
  AVARIA_PERDA: "BAIXA_AVARIA",
  AVARIA_VENCIMENTO: "BAIXA_VENCIMENTO",
  AVARIA_DANIFICADO: "BAIXA_DANIFICADO",
  AVARIA_ESTRAGADO: "BAIXA_ESTRAGADO",
  AVARIA_ESTORNO: "ESTORNO_AVARIA",
  AVARIA_COMPLEMENTO: "COMPLEMENTO_AVARIA",
  LIBERACAO_PDV: "LIBERACAO_PDV"
});

// Traduz o motivo da avaria escolhido na tela para o tipo de movimento correspondente
export function tipoMovimentoPorMotivo(motivo = "") {
  if (motivo === "Produto vencido") return TIPOS_MOVIMENTO.AVARIA_VENCIMENTO;
  if (["Produto danificado", "Embalagem violada", "Quebra"].includes(motivo)) return TIPOS_MOVIMENTO.AVARIA_DANIFICADO;
  if (["Produto estragado", "Contaminacao", "Contaminação", "Problema de armazenamento"].includes(motivo)) {
    return TIPOS_MOVIMENTO.AVARIA_ESTRAGADO;
  }
  return TIPOS_MOVIMENTO.AVARIA_PERDA;
}

// Chave idempotente do ajuste. A versao entra na chave de proposito: um estorno ou
// complemento da mesma avaria precisa ser uma operacao nova, nao uma repeticao bloqueada.
export function chaveDeOperacao({ devolucaoId, itemId, sku, tipoMovimento, versao }) {
  return `AVARIA-${devolucaoId}-ITEM-${itemId || sku}-${tipoMovimento}-V${versao}`;
}

function doisDigitos(valor) {
  return String(valor).padStart(2, "0");
}

// Data no formato dd/mm/aaaa exigido pela OMIE
export function formatarData(valor = new Date()) {
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) return formatarData(new Date());
  return `${doisDigitos(data.getDate())}/${doisDigitos(data.getMonth() + 1)}/${data.getFullYear()}`;
}

// A OMIE espera quantidade com virgula decimal. Quantidade invalida falha aqui, antes de
// virar requisicao — mandar zero ou negativo para um ajuste de estoque seria destrutivo.
export function normalizarQuantidade(valor) {
  const quantidade = Number(String(valor || 0).replace(",", "."));
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    throw new Error("Quantidade invalida para ajuste de estoque na OMIE.");
  }
  return String(quantidade).replace(".", ",");
}

// Monta o payload de IncluirAjusteEstoque
export function montarAjusteEstoque({
  chaveOperacao,
  idExternoProduto,
  sku,
  codigoLocal,
  quantidade,
  data = new Date(),
  observacao,
  tipoMovimento = "SAI",
  origem = "AJU",
  motivo = "PER",
  valor = 0,
  lotes = []
}) {
  const payload = {
    cod_int_ajuste: String(chaveOperacao || "").slice(0, 60),
    data: formatarData(data),
    quan: normalizarQuantidade(quantidade),
    obs: String(observacao || "Baixa registrada pelo MyEstoque.").slice(0, 500),
    origem,
    tipo: tipoMovimento,
    motivo,
    valor: Number.isFinite(Number(valor)) ? Number(valor) : 0
  };
  if (codigoLocal) payload.codigo_local_estoque = Number(codigoLocal);
  if (idExternoProduto) payload.id_prod = Number(idExternoProduto);
  else if (sku) payload.cod_int = String(sku).slice(0, 20);
  if (Array.isArray(lotes) && lotes.length) payload.lote_validade = lotes;
  return payload;
}

// Monta o payload de TRANSFERENCIA entre locais (IncluirAjusteEstoque com tipo "TRF").
//
// A OMIE resolve a transferencia em UM lancamento: tipo "TRF" com codigo_local_estoque como
// origem e codigo_local_estoque_destino como destino. Confirmado na documentacao do servico
// AjusteEstoque. Preferido a dois lancamentos (SAI no almoxarifado + ENT no PDV) porque dois
// lancamentos podem ficar pela metade -- se o segundo falhasse, o estoque teria sumido da
// origem sem aparecer no destino, e ninguem saberia sem conferir os dois locais.
//
// Esta e a UNICA escrita que o MyEstoque faz na OMIE. Venda, devolucao, compra, inventario e
// ajuste de saldo absoluto sao de outros sistemas -- ver a matriz de responsabilidade em
// docs/INTEGRACOES.md.
export function montarTransferenciaEstoque({
  chaveOperacao,
  idExternoProduto,
  sku,
  codigoLocalOrigem,
  codigoLocalDestino,
  quantidade,
  data = new Date(),
  observacao
}) {
  if (!codigoLocalOrigem || !codigoLocalDestino) {
    throw new Error("Transferencia exige local de origem e local de destino.");
  }
  if (String(codigoLocalOrigem) === String(codigoLocalDestino)) {
    throw new Error("Transferencia com origem e destino iguais nao move estoque.");
  }

  const payload = {
    cod_int_ajuste: String(chaveOperacao || "").slice(0, 60),
    data: formatarData(data),
    quan: normalizarQuantidade(quantidade),
    obs: String(observacao || "Transferencia registrada pelo MyEstoque.").slice(0, 500),
    origem: "AJU",
    tipo: "TRF",
    motivo: "TRF",
    valor: 0,
    codigo_local_estoque: Number(codigoLocalOrigem),
    codigo_local_estoque_destino: Number(codigoLocalDestino)
  };

  // id_prod e o caminho normal; cod_int so entra quando o produto ainda nao tem vinculo
  if (idExternoProduto) payload.id_prod = Number(idExternoProduto);
  else if (sku) payload.cod_int = String(sku).slice(0, 20);
  else throw new Error("Transferencia exige o produto (id externo ou SKU).");

  return payload;
}

// Compensacao de uma transferencia ja enviada: mesma quantidade, locais invertidos.
// Reabrir um pedido finalizado devolve o estoque ao almoxarifado no MyEstoque; sem este
// lancamento a OMIE ficaria achando que a mercadoria continua no PDV.
export function montarCompensacaoTransferencia(dados) {
  // A compensacao precisa da chave DELA, nunca a do lancamento original: a OMIE usa
  // cod_int_ajuste para deduplicar, entao repetir a chave faria o estorno ser recusado
  // como repetido e o estoque ficaria errado nos dois sistemas.
  if (!dados.chaveOperacao) throw new Error("Compensacao exige chave de operacao propria.");
  if (dados.chaveOperacaoOriginal && dados.chaveOperacao === dados.chaveOperacaoOriginal) {
    throw new Error("Compensacao nao pode reusar a chave do lancamento original.");
  }

  return montarTransferenciaEstoque({
    ...dados,
    codigoLocalOrigem: dados.codigoLocalDestino,
    codigoLocalDestino: dados.codigoLocalOrigem,
    observacao: dados.observacao || "Estorno de transferencia por reabertura de pedido no MyEstoque."
  });
}

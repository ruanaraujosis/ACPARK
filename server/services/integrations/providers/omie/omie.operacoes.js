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

// Quantidade do AJUSTE POR INVENTARIO, onde zero e valor legitimo.
//
// Deliberadamente separada de normalizarQuantidade(): la o zero e recusado porque um
// movimento (TRF/SAI) de zero nao move nada e mascara erro de calculo. No inventario zero e o
// resultado esperado de "ninguem contou este produto" -- e e justamente ele que zera o saldo.
// Afrouxar a funcao compartilhada tiraria a protecao da transferencia junto.
export function normalizarQuantidadeInventario(valor) {
  const quantidade = Number(String(valor ?? 0).replace(",", "."));
  if (!Number.isFinite(quantidade) || quantidade < 0) {
    throw new Error("Quantidade invalida para ajuste de inventario na OMIE.");
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
  valorUnitario,
  data = new Date(),
  observacao
}) {
  if (!codigoLocalOrigem || !codigoLocalDestino) {
    throw new Error("Transferencia exige local de origem e local de destino.");
  }
  if (String(codigoLocalOrigem) === String(codigoLocalDestino)) {
    throw new Error("Transferencia com origem e destino iguais nao move estoque.");
  }

  // "Valor do Movimento" e obrigatorio na API e NAO pode ser zero -- a OMIE recusa com
  // «O "Valor" informado deve ser diferente de zero». Isso so apareceu no primeiro envio
  // real: em simulacao o payload estava bem formado e passava.
  //
  // Falhar aqui, antes da requisicao, e melhor do que descobrir produto a produto na fila.
  const valor = Number(valorUnitario);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error(
      `Transferencia de ${sku || idExternoProduto} sem valor unitario conhecido. A OMIE exige valor diferente de zero no ajuste.`
    );
  }

  const payload = {
    cod_int_ajuste: String(chaveOperacao || "").slice(0, 60),
    data: formatarData(data),
    quan: normalizarQuantidade(quantidade),
    obs: String(observacao || "Transferencia registrada pelo MyEstoque.").slice(0, 500),
    origem: "AJU",
    tipo: "TRF",
    motivo: "TRF",
    valor,
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

// Monta o payload do AJUSTE POR INVENTARIO (IncluirAjusteEstoque com tipo "SLD").
//
// EXCECAO DELIBERADA a regra "movimento, nunca saldo absoluto".
//
// O resto do sistema so envia TRF (transferencia), e o tipo SLD esta travado por teste no
// caminho da transferencia justamente porque escrever saldo apagaria os lancamentos do
// sistema de vendas. O inventario e o unico caso em que escrever saldo e o comportamento
// desejado: a contagem fisica passa a ser a verdade, por decisao do usuario (28/08/2026).
//
// Codigos confirmados pelo usuario a partir da tela e do suporte da OMIE:
//   tipo   "SLD" -> "Ajustar o saldo de estoque do dia"
//   motivo "INV" -> "Ajuste por Inventario"
//
// O risco que essa escolha carrega esta documentado em docs/INTEGRACOES.md: entre a contagem
// e o envio o PDV continua vendendo, e o saldo gravado nao reflete essas vendas. Por isso a
// tela avisa a idade da contagem antes de o Almoxarifado confirmar.
export function montarAjusteInventario({
  chaveOperacao,
  idExternoProduto,
  sku,
  codigoLocal,
  quantidade,
  valorUnitario,
  data = new Date(),
  observacao
}) {
  if (!codigoLocal) {
    throw new Error("Ajuste de inventario exige o local de estoque do PDV que contou.");
  }

  const payload = {
    cod_int_ajuste: String(chaveOperacao || "").slice(0, 60),
    data: formatarData(data),
    // Zero e valor legitimo aqui: e o que zera o produto que ninguem contou
    quan: normalizarQuantidadeInventario(quantidade),
    obs: String(observacao || "Ajuste por inventario registrado pelo MyEstoque.").slice(0, 500),
    origem: "AJU",
    tipo: "SLD",
    motivo: "INV",
    codigo_local_estoque: Number(codigoLocal)
  };

  // A transferencia so descobriu no primeiro envio real que a OMIE recusa valor zero
  // («O "Valor" informado deve ser diferente de zero»). Nao sabemos ainda se o SLD exige o
  // mesmo, entao o valor vai quando existir e fica de fora quando nao houver -- a conferencia
  // do primeiro lancamento real dira se precisa ser obrigatorio aqui tambem.
  const valor = Number(valorUnitario);
  if (Number.isFinite(valor) && valor > 0) payload.valor = valor;

  if (idExternoProduto) payload.id_prod = Number(idExternoProduto);
  else if (sku) payload.cod_int = String(sku).slice(0, 20);
  else throw new Error("Ajuste de inventario exige o produto (id externo ou SKU).");

  return payload;
}

// ===== Saida por consumo administrativo =====

// Motivo da saida por consumo interno (PDV Administrativo). CONFIRMADO PELO USUARIO em
// 01/09/2026.
//
// O dominio de `motivo` para tipo "SAI" na OMIE tem exatamente quatro valores, conferidos na
// documentacao da propria conta (app.omie.com.br/api/v1/estoque/ajuste/?WSDL=&readable=):
//   INV - Ajuste por Inventario     (descartado: ja usado pelo inventario, usar aqui poluiria
//                                    a contagem)
//   PER - Baixa por Perda ou Quebra (descartado: perda e consumo legitimo sao coisas distintas
//                                    para relatorio fiscal e gerencial)
//   OPS - Integracao com Ordem de Producao - Saida  (descartado: nao ha ordem de producao)
//   PDV - Integracao com PDV        (ESCOLHIDO -- nominalmente marcaria o movimento como vindo
//                                    de um PDV de venda, o que nao e literalmente o caso aqui,
//                                    mas a categorizacao fiscal/contabil e decisao do usuario,
//                                    nao tecnica, e ele optou por este mesmo assim)
//
// Nao existe um motivo "consumo interno" dedicado no dominio da API -- PDV foi o escolhido
// entre as quatro opcoes existentes. A observacao de cada lancamento (ver tarefas/
// consumo-administrativo.js) deixa explicito no proprio registro da OMIE que a saida e de
// consumo administrativo, nao de venda, compensando o motivo nao ser literal.
export const MOTIVO_CONSUMO_ADMINISTRATIVO = "PDV";

// Monta o payload de SAIDA por consumo administrativo (IncluirAjusteEstoque, tipo "SAI").
//
// NUNCA "TRF": transferencia diria que a mercadoria continua na empresa, so que em outro
// local. O PDV Administrativo consome -- a mercadoria sai do estoque e nao volta.
export function montarSaidaConsumoAdministrativo({
  chaveOperacao,
  idExternoProduto,
  sku,
  codigoLocalOrigem,
  quantidade,
  valorUnitario,
  data = new Date(),
  observacao,
  motivo = MOTIVO_CONSUMO_ADMINISTRATIVO
}) {
  if (!codigoLocalOrigem) {
    throw new Error("Saida por consumo administrativo exige o local de origem (almoxarifado).");
  }

  // Mesma exigencia da transferencia: a OMIE recusa ajuste com valor zero. Descobrir isso
  // aqui e melhor do que produto a produto na fila.
  const valor = Number(valorUnitario);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error(
      `Saida de ${sku || idExternoProduto} sem valor unitario conhecido. A OMIE exige valor diferente de zero no ajuste.`
    );
  }

  const payload = {
    cod_int_ajuste: String(chaveOperacao || "").slice(0, 60),
    data: formatarData(data),
    quan: normalizarQuantidade(quantidade),
    obs: String(observacao || "Consumo interno registrado pelo MyEstoque.").slice(0, 500),
    origem: "AJU",
    tipo: "SAI",
    motivo,
    valor,
    codigo_local_estoque: Number(codigoLocalOrigem)
  };

  if (idExternoProduto) payload.id_prod = Number(idExternoProduto);
  else if (sku) payload.cod_int = String(sku).slice(0, 20);
  else throw new Error("Saida por consumo administrativo exige o produto (id externo ou SKU).");

  return payload;
}

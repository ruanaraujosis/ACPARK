// Traducao dos payloads da OMIE para o formato interno do MyEstoque.
// Funcoes puras: nao tocam banco nem rede, entao dao para testar direto.

// Converte data brasileira dd/mm/aaaa (com hora opcional) para timestamp SQL
export function converterData(valor, hora = "") {
  const texto = String(valor || "").trim();
  const partes = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!partes) return null;
  const horario = String(hora || "").match(/^(\d{2}):(\d{2})(:(\d{2}))?$/);
  const tempo = horario ? `${horario[1]}:${horario[2]}:${horario[4] || "00"}` : "00:00:00";
  return `${partes[3]}-${partes[2]}-${partes[1]} ${tempo}`;
}

// A OMIE manda numero ora com ponto, ora com virgula decimal
export function converterNumero(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : 0;
  const numero = Number(
    String(valor ?? 0)
      .replace(/\./g, "")
      .replace(",", ".")
  );
  return Number.isFinite(numero) ? numero : Number(String(valor ?? 0).replace(",", ".")) || 0;
}

// A OMIE devolve a descricao com entidades HTML escapadas: uma polegada vem como
// 'DISCO DE LIXA 6&QUOT;' em vez de 'DISCO DE LIXA 6"'. Sem desfazer isso, o nome do produto
// chega torto na tela, na planilha e na impressao do pedido.
const ENTIDADES_HTML = {
  QUOT: '"',
  APOS: "'",
  AMP: "&",
  LT: "<",
  GT: ">",
  NBSP: " "
};

export function decodificarEntidades(valor) {
  return String(valor || "")
    .replace(/&(quot|apos|amp|lt|gt|nbsp);/gi, (_, nome) => ENTIDADES_HTML[nome.toUpperCase()] ?? _)
    .replace(/&#(\d+);/g, (_, codigo) => {
      const numero = Number(codigo);
      return Number.isFinite(numero) && numero > 0 && numero < 0x110000 ? String.fromCodePoint(numero) : _;
    });
}

export function normalizarSku(valor) {
  return decodificarEntidades(valor).trim().slice(0, 60);
}

export function normalizarNome(valor) {
  return decodificarEntidades(valor).trim().toUpperCase().slice(0, 160);
}

// Produto do cadastro da OMIE (ListarProdutos)
export function mapearProduto(produto = {}) {
  return {
    idExterno: String(produto.codigo_produto || produto.id_prod || ""),
    sku: normalizarSku(produto.codigo || produto.cod_int || produto.codigo_produto),
    nome: normalizarNome(produto.descricao || produto.nome),
    unidade: produto.unidade || produto.codigo_unidade || "UN",
    codigoIntegracao: String(produto.codigo_produto_integracao || produto.cod_int || ""),
    familia: produto.descricao_familia || produto.familia || "",
    tipo: produto.tipoItem || produto.tipo_item || "",
    ean: String(produto.ean || ""),
    ncm: String(produto.ncm || ""),
    preco: converterNumero(produto.valor_unitario ?? produto.preco ?? 0),
    controleEstoque: produto.bloqueado === "S" ? "BLOQUEADO" : "",
    ativo: produto.inativo !== "S",
    saldo: converterNumero(produto.quantidade_estoque ?? 0),
    atualizadoEm: converterData(produto.info?.dAlt || produto.data_alteracao, produto.info?.hAlt),
    bruto: produto
  };
}

// Local de estoque (ListarLocaisEstoque)
export function mapearLocal(local = {}) {
  return {
    // codigo_local_estoque e o id numerico; "codigo" e o rotulo em texto ("Local de Estoque
    // Padrao"). Inverter os dois grava o rotulo como identificador e o vinculo com o PDV
    // deixa de casar com o que a consulta de estoque espera.
    idExterno: String(local.codigo_local_estoque || local.nCodLocal || ""),
    codigo: String(local.codigo || local.cCodInt || local.codigo_integracao || ""),
    nome: String(local.descricao || local.cDescr || local.nome || "")
      .trim()
      .slice(0, 160),
    descricao: String(local.observacao || local.cObs || "").slice(0, 500),
    ativo: local.inativo !== "S" && local.cInativo !== "S",
    bruto: local
  };
}

// Saldo por produto/local (ListarPosEstoque)
export function mapearSaldo(saldo = {}) {
  return {
    idExternoProduto: String(saldo.nCodProd || saldo.codigo_produto || saldo.id_prod || ""),
    // cCodigo e o campo que o ListarPosEstoque realmente usa para o codigo do produto;
    // cCodInt costuma vir vazio nesta conta, entao ele sozinho nao serve de fallback
    skuExterno: normalizarSku(saldo.cCodigo || saldo.cCodInt || saldo.codigo || saldo.cod_int),
    idExternoLocal: String(saldo.nCodLocal || saldo.codigo_local_estoque || saldo.local_estoque || ""),
    quantidade: converterNumero(saldo.nSaldo ?? saldo.saldo ?? saldo.quantidade ?? saldo.qtd ?? 0),
    fisico: converterNumero(saldo.nEstoqueFisico ?? saldo.estoque_fisico ?? 0),
    reservado: converterNumero(saldo.nReservado ?? saldo.reservado ?? 0),
    bruto: saldo
  };
}

// Origem do movimento a partir do codOrigem, que e o campo que a OMIE realmente preenche.
// Valores vistos na conta desta instalacao: COM (Compra de Produto), RRE (Nota de Entrada
// de Produto) e AJU (Movimento Manual de Estoque).
const ORIGEM_POR_CODIGO = {
  COM: "COMPRA",
  RRE: "NOTA_ENTRADA",
  AJU: "AJUSTE_MANUAL",
  VEN: "VENDA",
  PRO: "PRODUCAO",
  TRA: "TRANSFERENCIA"
};

// Classifica a origem do movimento. Exige evidencia explicita: sem ela fica
// ORIGEM_NAO_IDENTIFICADA, para nao inventar que uma baixa foi venda do Orion.
export function classificarOrigem(movimento = {}) {
  const texto = [movimento.desOrigem, movimento.descricao, movimento.numDoc, movimento.numPedido, movimento.cObs]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  // Cancelamento e devolucao vem como flag propria, entao nao dependem do texto
  if (movimento.cancelamento === "S" || /CANCEL/.test(texto)) return "ORION_CANCELAMENTO";
  if (movimento.devolucao === "S" || /DEVOL/.test(texto)) return "ORION_DEVOLUCAO";
  if (/ORION/.test(texto)) return "ORION_VENDA";
  if (/AVARIA|PERDA|QUEBRA/.test(texto)) return "ACPARK_AVARIA";

  const porCodigo = ORIGEM_POR_CODIGO[String(movimento.codOrigem || "").toUpperCase()];
  if (porCodigo) return porCodigo;

  return "ORIGEM_NAO_IDENTIFICADA";
}

// Movimento de estoque (ListarMovimentoEstoque)
// Movimento de estoque (ListarMovimentoEstoque).
//
// Os nomes de campo aqui foram conferidos contra a resposta real da API: a lista vem em
// movProdutoListar e cada item usa idMov / idProd / dtMov / qtde / tipo. Os nomes no estilo
// hungaro (nCodMovimento, nQtde, dData...) que a documentacao sugere NAO aparecem nesta
// chamada -- mantidos so como plano B. Sem isso, todo movimento entrava com id, produto,
// data e quantidade nulos.
export function mapearMovimento(movimento = {}) {
  const tipo = String(movimento.tipo || movimento.cTipo || movimento.tipo_movimento || "").toUpperCase();
  const saida = tipo.startsWith("S");
  return {
    idExterno: String(movimento.idMov ?? movimento.nCodMovimento ?? movimento.codigo_movimento ?? ""),
    idExternoProduto: String(movimento.idProd ?? movimento.nCodProd ?? movimento.codigo_produto ?? ""),
    idExternoLocal: String(movimento.codigo_local_estoque ?? movimento.nCodLocal ?? ""),
    data: converterData(movimento.dtMov || movimento.dData || movimento.data, movimento.cHora),
    quantidade: converterNumero(movimento.qtde ?? movimento.nQtde ?? movimento.quantidade ?? 0),
    // Saldo do produto naquele local depois do movimento; util para conferir sem nova consulta
    saldoApos: converterNumero(movimento.saldo ?? 0),
    tipoOperacao: saida ? "SAIDA" : "ENTRADA",
    origem: classificarOrigem(movimento),
    referencia: String(movimento.descricao || movimento.numDoc || movimento.cObs || "").slice(0, 255),
    bruto: movimento
  };
}

// Chave determinista para deduplicar movimento quando a OMIE nao devolve identificador
// proprio. Sem isso, a sobreposicao temporal da leitura incremental reimportaria o mesmo
// movimento a cada ciclo.
export function chaveDeduplicacao(integrationId, movimento) {
  if (movimento.idExterno) return `OMIE-${integrationId}-MOV-${movimento.idExterno}`;
  return [
    "OMIE",
    integrationId,
    movimento.idExternoProduto || "SEMPROD",
    movimento.idExternoLocal || "SEMLOCAL",
    movimento.data || "SEMDATA",
    movimento.tipoOperacao,
    movimento.quantidade
  ].join("-");
}

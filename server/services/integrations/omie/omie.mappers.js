// Converte data no formato brasileiro dd/mm/aaaa da OMIE para timestamp SQL
function parseBrazilianDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]} 00:00:00`;
}

// Converte quantidade numerica da OMIE (que usa virgula decimal) para Number
function parseQuantity(value) {
  const number = Number(String(value ?? 0).replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

// Mapeia o produto retornado pela OMIE para o formato interno usado pelo MyEstoque
export function mapOmieProduct(product = {}) {
  return {
    externalId: String(product.codigo_produto || product.id_prod || ""),
    sku: String(product.codigo || product.cod_int || product.codigo_produto || ""),
    name: product.descricao || product.nome || "",
    unit: product.unidade || product.codigo_unidade || "UN",
    integrationCode: String(product.codigo_produto_integracao || product.cod_int || ""),
    family: product.descricao_familia || product.familia || "",
    productType: product.tipoItem || product.tipo_item || "",
    ean: String(product.ean || ""),
    ncm: String(product.ncm || ""),
    price: parseQuantity(product.valor_unitario || product.preco || 0),
    stockControl: product.bloqueado === "S" ? "BLOQUEADO" : "",
    active: product.inativo !== "S",
    stockQuantity: parseQuantity(product.quantidade_estoque || 0),
    updatedAt: parseBrazilianDate(product.info?.dAlt || product.data_alteracao),
    raw: product
  };
}

// Mapeia o saldo de estoque por local retornado pela OMIE
export function mapOmieStock(stock = {}) {
  return {
    productExternalId: String(stock.codigo_produto || stock.id_prod || ""),
    locationExternalId: String(stock.codigo_local_estoque || stock.local_estoque || ""),
    quantity: parseQuantity(stock.saldo ?? stock.quantidade ?? stock.qtd),
    raw: stock
  };
}

// Classifica a origem do movimento (ACPARK/ORION venda, cancelamento, devolucao ou OMIE)
// com base em texto de referencia/operacao; exige evidencia explicita, senao fica nao identificado
export function classifyOrigin(movement = {}) {
  const text = `${movement.referencia || ""} ${movement.origem || ""} ${movement.operacao || ""}`.toUpperCase();
  if (movement.cancelamento === "S" || text.includes("CANCEL")) return "ORION_CANCELAMENTO";
  if (movement.devolucao === "S" || text.includes("DEVOL")) return "ORION_DEVOLUCAO";
  if (text.includes("ORION") || String(movement.operacao || "") === "12") return "ORION_VENDA";
  if (text.includes("OMIE")) return "OMIE";
  return "ORIGEM_NAO_IDENTIFICADA";
}

// Mapeia um movimento de estoque da OMIE, classificando entrada/saida e origem
export function mapOmieMovement(movement = {}) {
  const type = String(movement.tipo_movimento || movement.tipo || "").toUpperCase();
  return {
    productExternalId: String(movement.id_prod || movement.codigo_produto || ""),
    date: parseBrazilianDate(movement.data || movement.data_movimento),
    quantity: parseQuantity(movement.quantidade || movement.quan),
    operationType: type.startsWith("S") || type === "SAI" ? "SAIDA" : "ENTRADA",
    origin: classifyOrigin(movement),
    raw: movement
  };
}

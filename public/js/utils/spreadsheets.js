// Faz o parse de um texto CSV/TSV genérico, detectando o delimitador (tab, ; ou ,)
// e respeitando aspas (inclusive aspas duplicadas dentro de campo)
function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delimiter = text.includes("\t") ? "\t" : semicolons > commas ? ";" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => String(value).trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim())) rows.push(row);
  return rows;
}

// Normaliza um cabe\u00e7alho de coluna para compara\u00e7\u00e3o: remove acentos, min\u00fasculas, s\u00f3 a-z0-9
function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Interpreta valores de planilha como booleano (ex: "sim", "ativo", "1")
function truthySheetValue(value) {
  return ["sim", "s", "true", "1", "ativo", "yes"].includes(String(value || "").trim().toLowerCase());
}

// Envolve o texto em f\u00f3rmula ="..." para for\u00e7ar o Excel/Sheets a tratar como texto (preserva zeros \u00e0 esquerda em SKUs)
export function spreadsheetText(value) {
  const text = String(value ?? "").trim();
  return text ? `="${text.replace(/"/g, '""')}"` : "";
}

// Reverte o formato ="..." gerado por spreadsheetText ao importar uma planilha de volta
function normalizeImportedSku(value) {
  const text = String(value ?? "").trim();
  const formulaMatch = text.match(/^="(.*)"$/);
  return formulaMatch ? formulaMatch[1].replace(/""/g, '"') : text;
}

// Converte linhas brutas da planilha de produtos em objetos, identificando colunas pelo nome do cabe\u00e7alho
function parseProductsRows(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const find = (...names) => headers.findIndex((header) => names.includes(header));
  const skuIndex = find("sku", "codigo", "codigoproduto");
  const nameIndex = find("produto", "nome", "nomeproduto", "descricao");
  const stockIndex = find("estoquecentral", "qtdtotal", "quantidade", "estoque");
  const activeIndex = find("ativo", "status");
  const categoryIndex = find("categoria", "categoriaproduto", "grupo");
  const originIndex = find("origem", "fonte", "integracao");
  if (skuIndex < 0 || nameIndex < 0) throw new Error("A planilha precisa ter as colunas SKU/Código e Produto.");

  return rows.slice(1).map((row) => ({
    sku: normalizeImportedSku(row[skuIndex]),
    nome: String(row[nameIndex] || "").trim(),
    qtd_total: Number.parseInt(String(row[stockIndex] || "0").replace(",", "."), 10) || 0,
    ativo: activeIndex >= 0 ? truthySheetValue(row[activeIndex]) : true,
    categoria: categoryIndex >= 0 ? String(row[categoryIndex] || "").trim() : "",
    origem: originIndex >= 0 ? String(row[originIndex] || "").trim().toLowerCase() : "manual"
  })).filter((item) => item.sku && item.nome);
}

// Faz o parse de um arquivo texto (CSV/TSV) de produtos
function parseProductsSheet(text) {
  return parseProductsRows(parseDelimited(text));
}

// Lê um arquivo de produtos (CSV/TSV ou XLSX via biblioteca SheetJS) e devolve os itens normalizados
export async function parseProductsFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["xlsx", "xls"].includes(extension)) {
    if (!window.XLSX) throw new Error("Leitor de Excel indisponível. Recarregue a página e tente novamente.");
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array", cellDates: false, raw: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    return parseProductsRows(rows);
  }
  return parseProductsSheet(await file.text());
}



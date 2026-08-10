// Escapa caracteres HTML para evitar inje\u00E7\u00E3o ao montar strings de template
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

// Monta o badge visual de status (ex: pendente, liberado) a partir do texto
export function statusPill(status) {
  return `<span class="status ${esc(status).replace(/\s+/g, "-")}">${esc(status)}</span>`;
}

// Gera o HTML de uma tabela simples, com mensagem padr\u00E3o quando n\u00E3o h\u00E1 linhas
export function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}">Nenhum registro encontrado.</td></tr>`}</tbody></table></div>`;
}

// Escapa um valor para uso seguro em c\u00E9lula CSV (aspas, ponto e v\u00EDrgula, quebras de linha)
function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Gera e dispara o download de um arquivo CSV (com BOM para acentua\u00E7\u00E3o no Excel)
export function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvEscape).join(";")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

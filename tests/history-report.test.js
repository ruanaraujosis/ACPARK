import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync("public/app.js", "utf8");
const styles = fs.readFileSync("public/styles.css", "utf8");

const historyBlock = app.slice(
  app.indexOf("async function viewHistory"),
  app.indexOf("async function viewConfig")
);

test("history report groups orders by point and date", () => {
  assert.match(historyBlock, /groupHistoryByPointAndDate/);
  assert.match(historyBlock, /history-point-group/);
  assert.match(historyBlock, /history-date-group/);
  assert.match(historyBlock, /point\.dates\.map/);
  assert.match(styles, /\.history-point-group/);
  assert.match(styles, /\.history-date-group/);
});

test("history print does not include withdrawal signature image", () => {
  assert.doesNotMatch(historyBlock, /history-signature-proof/);
  assert.doesNotMatch(historyBlock, /Assinatura da retirada/);
  assert.doesNotMatch(historyBlock, /retirada_assinatura/);
});

test("history report can export current point or all points to spreadsheet", () => {
  assert.match(historyBlock, /export-history-current/);
  assert.match(historyBlock, /export-history-all/);
  assert.match(historyBlock, /export-history-grouped/);
  assert.match(historyBlock, /history-actions-toggle/);
  assert.match(historyBlock, /downloadWorkbook/);
  assert.match(historyBlock, /window\.XLSX/);
  assert.match(historyBlock, /Histórico Geral/);
  assert.match(historyBlock, /Agrupado por PDV/);
  assert.match(historyBlock, /Resumo/);
  assert.match(historyBlock, /historico_todos_os_pontos\.xlsx/);
  assert.match(historyBlock, /historico_\$\{slugFileName\(selectedPointLabel\)\}\.xlsx/);
  assert.match(historyBlock, /historico_agrupado_por_pdv\.xlsx/);
});

test("history print uses one continuous table per point and date", () => {
  assert.match(historyBlock, /renderHistoryPrintReport/);
  assert.match(historyBlock, /historico-pedidos-print/);
  assert.match(historyBlock, /history-print-date-row/);
  assert.match(historyBlock, /pedido-header-row/);
  assert.match(historyBlock, /pedido-product-row/);
  assert.match(historyBlock, /historyOrderPrintRows/);
  assert.match(styles, /body\.printing-history \.history-screen-groups[\s\S]*display: none !important/);
  assert.match(styles, /\.historico-pedidos-print thead[\s\S]*display: table-header-group !important/);
  assert.match(styles, /\.history-print-date-row[\s\S]*page-break-after: avoid !important/);
  assert.match(styles, /\.pedido-header-row[\s\S]*page-break-after: avoid !important/);
  assert.match(styles, /\.pedido-product-row[\s\S]*page-break-inside: avoid !important/);
});

test("history report can print products grouped by PDV", () => {
  assert.match(historyBlock, /print-history-grouped/);
  assert.match(historyBlock, /renderHistoryGroupedPrintReport/);
  assert.match(historyBlock, /groupHistoryProductsByPdv/);
  assert.match(historyBlock, /Quantidade solicitada total/);
  assert.match(historyBlock, /product\.quantidadeSolicitada \+= Number\(row\.quantidade_solicitada \|\| 0\)/);
  assert.match(styles, /body\.printing-history\.printing-history-grouped \.history-print-report[\s\S]*display: none !important/);
  assert.match(styles, /body\.printing-history\.printing-history-grouped \.history-grouped-print-report[\s\S]*display: block !important/);
});

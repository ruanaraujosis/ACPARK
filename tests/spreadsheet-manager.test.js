import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync("public/app.js", "utf8");
const styles = fs.readFileSync("public/styles.css", "utf8");

const productsBlock = app.slice(
  app.indexOf("async function viewProductsV2"),
  app.indexOf("function renderCategoryManager")
);

test("central stock spreadsheet menu has manageable filters", () => {
  assert.match(productsBlock, /sheet-manager-backdrop/);
  assert.match(productsBlock, /sheet-manager-menu/);
  assert.match(productsBlock, /role="dialog"/);
  assert.match(productsBlock, /aria-modal="true"/);
  assert.match(productsBlock, /sheet-manager-title/);
  assert.match(productsBlock, /sheet-product-search/);
  assert.match(productsBlock, /sheet-product-status/);
  assert.match(productsBlock, /sheet-product-origin/);
  assert.match(productsBlock, /sheet-product-category/);
  assert.match(productsBlock, /sheetFilteredProducts/);
  assert.match(productsBlock, /export-products-filtered/);
  assert.match(productsBlock, /produtos_filtrados_google_sheets\.csv/);
});

test("spreadsheet manager keeps import and export all actions", () => {
  assert.match(productsBlock, /export-products-all/);
  assert.match(productsBlock, /import-products/);
  assert.match(productsBlock, /parseProductsFile/);
  assert.match(productsBlock, /produtos_google_sheets\.csv/);
});

test("spreadsheet manager has responsive panel styles", () => {
  assert.match(styles, /\.sheet-manager-backdrop/);
  assert.match(styles, /body\.sheet-manager-open/);
  assert.match(styles, /\.sheet-manager-menu/);
  assert.match(styles, /position:\s*fixed/);
  assert.match(styles, /transform:\s*translate\(-50%, -50%\)/);
  assert.match(styles, /\.sheet-manager-grid/);
  assert.match(styles, /\.sheet-manager-summary/);
});

test("central stock filters only run when the user searches", () => {
  assert.match(productsBlock, /id="search-product-filter"/);
  assert.match(productsBlock, /const executeCentralProductSearch = \(\) =>/);
  assert.match(productsBlock, /centralProductSearchButton\?\.addEventListener\("click", executeCentralProductSearch\)/);
  assert.match(productsBlock, /event\.key === "Enter"/);
  assert.match(productsBlock, /centralProductSearchButton\.textContent = "Buscando\.\.\."/);
  assert.match(productsBlock, /centralFilterVersion/);
  assert.match(productsBlock, /cancelAnimationFrame\(centralFilterFrame\)/);
  assert.match(productsBlock, /requestAnimationFrame/);
  assert.match(productsBlock, /centralProductRowsByPanel/);
  assert.match(productsBlock, /centralPanelSortState/);
  assert.match(styles, /\.product-filter-card\.is-filtering/);
  assert.doesNotMatch(productsBlock, /centralProductSearch\?\.addEventListener\("input"/);
  assert.doesNotMatch(productsBlock, /centralProductStatus\?\.addEventListener\("change"/);
  assert.doesNotMatch(productsBlock, /centralProductStockSort\?\.addEventListener\("change"/);
});

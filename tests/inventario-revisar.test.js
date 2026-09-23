import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../server/modules/inventarios/inventarios.routes.js", import.meta.url), "utf8");

const rota = routes.slice(routes.indexOf('"/api/admin/inventario/revisar"'), routes.indexOf("// ===== Assinatura do PDV e aplicação do ajuste"));

test("revisar: só admin, só 'Aguardando assinatura', outros estados dão 409", () => {
  assert.match(rota, /requireUser\(req, res, "admin"\)/);
  assert.match(rota, /await tx\(/);
  assert.match(rota, /travarInventario\(client, corpo\?\.codigo_inventario\)/);
  assert.match(rota, /inventario\.status !== STATUS_INVENTARIO\.AGUARDANDO_ASSINATURA/);
  assert.match(rota, /erro\.statusCode = 409/);
});

test("revisar: volta para Enviado, limpa confirmado_* e não toca em assinatura, ajuste nem itens", () => {
  assert.match(rota, /SET status = \$2, confirmado_em = NULL, confirmado_por = NULL/);
  assert.match(rota, /STATUS_INVENTARIO\.ENVIADO\]/);
  assert.doesNotMatch(rota, /assinado_|assinatura_imagem|ajuste_aplicado_em|inventario_itens|estoque_pdv|enfileirarAjusteNaOmie|aplicarAjusteLocal/);
});

test("revisar: grava auditoria e avisa Almoxarifado e PDV (cancela o pedido de assinatura)", () => {
  assert.match(rota, /acao: "inventario_revisao"/);
  assert.match(rota, /valorAnterior: STATUS_INVENTARIO\.AGUARDANDO_ASSINATURA/);
  assert.match(rota, /valorNovo: STATUS_INVENTARIO\.ENVIADO/);
  assert.match(rota, /publishOrderAlert\("INVENTARIO_STATUS_CHANGED"/);
  assert.match(rota, /publicarEventoDoPdv\("INVENTARIO_ASSINATURA_CANCELADA", resultado\.pdv_id/);
  assert.match(app, /addEventListener\("INVENTARIO_ASSINATURA_CANCELADA"/);
});

test("a assinatura do PDV é recusada depois da revisão (mesma trava FOR UPDATE, corrida serializada)", () => {
  const assinatura = routes.slice(routes.indexOf("Assinar duas vezes não pode ajustar duas vezes") - 600, routes.indexOf("Assinar duas vezes não pode ajustar duas vezes") + 500);
  assert.match(assinatura, /FOR UPDATE/);
  assert.match(assinatura, /inventario\.status !== STATUS_INVENTARIO\.AGUARDANDO_ASSINATURA/);
  assert.match(assinatura, /ainda não foi confirmado pelo Almoxarifado/);
});

test("lista sempre 'Abrir'; detalhe tem Revisar só em 'Aguardando assinatura'", () => {
  assert.match(app, /data-codigo="\$\{esc\(inv\.codigo_inventario\)\}">Abrir<\/button>/);
  assert.doesNotMatch(app, /\? "Revisar" : "Abrir"/);
  assert.equal((app.match(/inventario-revisar/g) || []).length, 2, "um botão e um bind");
  assert.match(app, /inventario\.status === "Aguardando assinatura" \? `\s*<div class="order-card-actions no-print">\s*<button class="btn secondary inventario-revisar"/);
  assert.match(app, /Aguardando a assinatura do PDV\. Use Revisar para voltar à conferência e corrigir a contagem\./);
  assert.match(app, /O PDV deixará de ver o pedido de assinatura\. Deseja voltar para a conferência\?/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const routes = fs.readFileSync(new URL("../server/modules/pedidos/pedidos.routes.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const alertaPdv = fs.readFileSync(new URL("../public/js/services/pdv-order-alerts.js", import.meta.url), "utf8");
const alertaAdmin = fs.readFileSync(new URL("../public/js/services/order-alerts.js", import.meta.url), "utf8");
const eventosPdv = fs.readFileSync(new URL("../server/services/inventarios/inventario.events.js", import.meta.url), "utf8");

test("o evento vai só pelo canal do PDV dono, nunca pelo canal do Almoxarifado", () => {
  const helper = routes.slice(routes.indexOf("async function avisarPdvPedidoAguardandoRetirada"), routes.indexOf("async function avisarPdvPedidoAguardandoRetirada") + 900);
  assert.match(helper, /SELECT DISTINCT pdv_id FROM pedidos WHERE codigo_pedido = \$1/);
  assert.match(helper, /publicarEventoDoPdv\("PEDIDO_AGUARDANDO_RETIRADA", pdvId,/);
  assert.doesNotMatch(helper, /publishOrderAlert/, "o canal do Almoxarifado transmite a todos");
  // O canal por PDV só escreve para a conexão do mesmo pdvId, e não envia nada sem pdvId
  assert.match(eventosPdv, /if \(conexao\.pdvId !== alvo\) continue;/);
  assert.match(eventosPdv, /if \(pdvId === null \|\| pdvId === undefined\) return null;/);
});

test("os dois caminhos de entrada em Aguardando Retirada avisam o PDV, só na transição", () => {
  assert.match(routes, /if \(nextStatus === "Aguardando Retirada" && expectedStatus !== "Aguardando Retirada"\) \{\s*await avisarPdvPedidoAguardandoRetirada\(orderCode\);/);
  assert.match(routes, /if \(nextStatus === "Aguardando Retirada" && currentStatusFilter !== "Aguardando Retirada"\) \{\s*await avisarPdvPedidoAguardandoRetirada\(orderCode \|\| items\[0\]\?\.codigo_pedido\);/);
  assert.equal((routes.match(/await avisarPdvPedidoAguardandoRetirada\(/g) || []).length, 2);
});

test("a migração de legado não dispara o alerta (muda o status direto no SQL)", () => {
  const legado = routes.slice(routes.indexOf("// Corrige pedidos presos em status legados"), routes.indexOf("// Corrige pedidos presos em status legados") + 800);
  assert.doesNotMatch(legado, /avisarPdvPedidoAguardandoRetirada|publicarEventoDoPdv/);
});

test("o PDV mostra o cartão 'Pedido pronto para retirada' com Visualizar, Silenciar e som", () => {
  assert.match(app, /eventosDoPdv\.addEventListener\("PEDIDO_AGUARDANDO_RETIRADA"/);
  assert.match(alertaPdv, /Pedido pronto para retirada/);
  assert.match(alertaPdv, /data-pdv-alert-view>Visualizar/);
  assert.match(alertaPdv, /data-pdv-alert-silence>Silenciar alerta/);
  assert.match(alertaPdv, /soundId: "repetitive-alert"/);
  assert.match(alertaPdv, /enqueueOrderAlert\(\{/);
  assert.match(alertaAdmin, /state\.user\?\.role === "pdv"/, "o botão de ativar som aparece para o PDV");
});

test("o Almoxarifado não recebe este alerta (o listener só existe no canal do PDV)", () => {
  assert.doesNotMatch(alertaAdmin, /PEDIDO_AGUARDANDO_RETIRADA/);
  const conectar = app.slice(app.indexOf("function conectarEventosDoPdv"), app.indexOf("function desconectarEventosDoPdv"));
  assert.match(conectar, /if \(state\.user\?\.role !== "pdv"/);
});

test("comportamento: com dois PDVs conectados, só o dono do pedido recebe o evento", async () => {
  const { handleEventosDoPdv, publicarEventoDoPdv } = await import("../server/services/inventarios/inventario.events.js");
  const conexao = () => {
    const escrito = [];
    const fechar = [];
    const res = { writeHead() {}, write: (t) => escrito.push(t), on() {} };
    const req = { on: (ev, fn) => { if (ev === "close") fechar.push(fn); } };
    return { req, res, escrito, fechar: () => fechar.forEach((f) => f()) };
  };
  const dono = conexao();
  const outro = conexao();
  handleEventosDoPdv(dono.req, dono.res, 5);
  handleEventosDoPdv(outro.req, outro.res, 3);
  publicarEventoDoPdv("PEDIDO_AGUARDANDO_RETIRADA", 5, { codigoPedido: "PED-X" });
  assert.ok(dono.escrito.some((t) => t.includes("PEDIDO_AGUARDANDO_RETIRADA") && t.includes("PED-X")));
  assert.ok(!outro.escrito.some((t) => t.includes("PEDIDO_AGUARDANDO_RETIRADA")), "outro PDV não pode receber");
  dono.fechar();
  outro.fechar();
});

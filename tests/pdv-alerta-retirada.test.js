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

test("PDV Administrativo: mesma sessão 'pdv', mesmo canal e sem filtro que o exclua", () => {
  const index = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  // O login de PDV não distingue o administrativo: todos entram como role "pdv" com o próprio pdvId
  assert.match(index, /jwt\.sign\(\{ role: "pdv", pdvId: rows\[0\]\.id, name: rows\[0\]\.nome \}/);
  const helper = routes.slice(routes.indexOf("export async function avisarPdvPedidoAguardandoRetirada"), routes.indexOf("export async function avisarPdvPedidoAguardandoRetirada") + 900);
  assert.doesNotMatch(helper, /administrativo/, "nenhum filtro pode cortar o PDV Administrativo");
  // "Visualizar" leva a Meus pedidos, que existe também no menu do administrativo
  assert.match(app, /\["painel", "Painel do setor"\], \["order", "Novo pedido"\], \["mine", "Meus pedidos"\]/);
  assert.match(app, /mostrarPedidoProntoParaRetirada\(dados, \{ abrirMeusPedidos: \(\) => route\("mine"\) \}\)/);
});

test("trocar de tela não apaga o cartão nem para o som do PDV", () => {
  // stopOrderAlerts() remove #order-alert-root e para o som; rodava em toda troca de tela do PDV.
  // O ramo do PDV não chama mais; o logout continua chamando.
  const ramoPdv = app.slice(app.indexOf("await views[view]();"), app.indexOf("conectarEventosDoPdv();", app.indexOf("await views[view]();")));
  assert.doesNotMatch(ramoPdv.slice(ramoPdv.indexOf("} else {")), /^\s*stopOrderAlerts\(\);/m);
  const logout = app.slice(app.indexOf('document.querySelector("#logout")'), app.indexOf('document.querySelector("#logout")') + 300);
  assert.match(logout, /stopOrderAlerts\(\);/);
  // Módulos importados pelo app.js não têm ?v= e ficam 1h em cache: um export NOVO em
  // order-alerts.js deixava a tela em branco para quem tinha a versão antiga (visto em 24/09/2026)
  assert.doesNotMatch(alertaAdmin, /alertasDoAlmoxarifadoAtivos/);
  assert.match(alertaPdv, /root\.id = "pdv-order-alert-root";/, "container próprio, fora do que stopOrderAlerts remove");
  // No logout os cartões do PDV que saiu são limpos
  assert.match(app, /function desconectarEventosDoPdv\(\) \{\s*eventosDoPdv\?\.close\(\);\s*eventosDoPdv = null;\s*limparAlertasDoPdv\(\);/);
});

test("comportamento: PDV Administrativo e PDV comum conectados, cada um recebe só o seu", async () => {
  const { handleEventosDoPdv, publicarEventoDoPdv } = await import("../server/services/inventarios/inventario.events.js");
  const conexao = (pdvId) => {
    const escrito = [];
    const fechar = [];
    handleEventosDoPdv({ on: (ev, fn) => ev === "close" && fechar.push(fn) }, { writeHead() {}, write: (t) => escrito.push(t), on() {} }, pdvId);
    return { escrito, fechar: () => fechar.forEach((f) => f()) };
  };
  const administrativo = conexao(23);
  const comum = conexao(7);
  publicarEventoDoPdv("PEDIDO_AGUARDANDO_RETIRADA", 23, { codigoPedido: "PED-ADM" });
  publicarEventoDoPdv("PEDIDO_AGUARDANDO_RETIRADA", 7, { codigoPedido: "PED-COMUM" });
  const tem = (c, codigo) => c.escrito.some((t) => t.includes(codigo));
  assert.ok(tem(administrativo, "PED-ADM"));
  assert.ok(!tem(administrativo, "PED-COMUM"));
  assert.ok(tem(comum, "PED-COMUM"));
  assert.ok(!tem(comum, "PED-ADM"));
  administrativo.fechar();
  comum.fechar();
});

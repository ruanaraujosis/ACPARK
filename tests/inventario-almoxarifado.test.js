import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const rotas = fs.readFileSync("server/modules/inventarios/inventarios.routes.js", "utf8").split("\r\n").join("\n");
const app = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");

// Corpo das rotas do Almoxarifado, para as asserções não dependerem de tamanho fixo de fatia.
// Termina onde começa o bloco de assinatura: aquelas rotas moram no mesmo arquivo e são do
// PDV, então incluí-las aqui faria a checagem de papel encontrar "pdv" e falhar sem motivo.
const admin = rotas.slice(
  rotas.indexOf("async function rotasDoAlmoxarifado"),
  rotas.indexOf("// ===== Assinatura do PDV e aplicação do ajuste =====")
);

// ===== Servidor =====

test("toda rota do Almoxarifado exige papel admin", () => {
  const guardas = [...admin.matchAll(/requireUser\(req, res, "(\w+)"\)/g)].map((m) => m[1]);
  assert.ok(guardas.length >= 6, `esperava uma guarda por rota, achei ${guardas.length}`);
  assert.ok(guardas.every((p) => p === "admin"), `todas precisam exigir admin: ${guardas.join(", ")}`);
});

test("o Almoxarifado só edita contagem já enviada", () => {
  // Mexer enquanto o PDV conta faria a tela dele perder o que digitou; mexer depois de
  // confirmada alteraria uma contagem que já está esperando assinatura ou virou ajuste.
  // A função é declarada antes do bloco de rotas, então procura no arquivo inteiro
  assert.match(rotas, /function exigirEditavelPeloAlmoxarifado/);
  assert.match(rotas, /inventario\.status !== STATUS_INVENTARIO\.ENVIADO/);
  assert.match(rotas, /O PDV ainda está contando/);
  assert.match(rotas, /Para corrigir, abra um novo inventário/);
  // Mas o uso precisa estar dentro das rotas do Almoxarifado
  assert.match(admin, /exigirEditavelPeloAlmoxarifado\(inventario\)/);
});

test("a checagem de estado roda antes de qualquer escrita nos itens", () => {
  const inicio = admin.indexOf('"/api/admin/inventario/itens"');
  const trecho = admin.slice(inicio);
  const posGuarda = trecho.indexOf("exigirEditavelPeloAlmoxarifado");
  const posUpdate = trecho.indexOf("UPDATE inventario_itens");
  const posDelete = trecho.indexOf("DELETE FROM inventario_itens");
  const posInsert = trecho.indexOf("INSERT INTO inventario_itens");
  assert.ok(posGuarda > -1);
  for (const [nome, pos] of [["UPDATE", posUpdate], ["DELETE", posDelete], ["INSERT", posInsert]]) {
    assert.ok(posGuarda < pos, `a guarda precisa vir antes do ${nome}`);
  }
});

test("toda alteração guarda valor anterior e valor novo", () => {
  for (const acao of ["quantidade_corrigida", "item_adicionado", "item_removido"]) {
    assert.match(admin, new RegExp(`acao: "${acao}"`), `falta auditar ${acao}`);
  }
  // A correção precisa registrar de onde veio o número, não só para onde foi
  const bloco = admin.slice(admin.indexOf('acao: "quantidade_corrigida"') - 400, admin.indexOf('acao: "quantidade_corrigida"') + 300);
  assert.match(bloco, /valorAnterior: linha\.quantidade_contada/);
  assert.match(bloco, /valorNovo: nova/);
});

test("reenviar o mesmo número não polui a trilha de auditoria", () => {
  assert.match(admin, /const igual = String\(linha\.quantidade_contada \?\? ""\) === String\(nova \?\? ""\)/);
  assert.match(admin, /if \(igual\) continue;/);
});

test("produto fora do cadastro não entra na contagem", () => {
  assert.match(admin, /SELECT 1 FROM produtos WHERE sku = \$1/);
  assert.match(admin, /não existe no cadastro/);
});

test("a exclusão exige justificativa e preserva a trilha", () => {
  assert.match(admin, /Informe o motivo da exclusão do inventário/);
  // A auditoria da exclusão grava o código (não o id), senão a trilha morreria com a linha
  const bloco = admin.slice(admin.indexOf('acao: "inventario_excluido"') - 300, admin.indexOf('acao: "inventario_excluido"') + 400);
  assert.match(bloco, /inventarioId: null/);
  assert.match(bloco, /codigoInventario: inventario\.codigo_inventario/);
  assert.match(bloco, /observacao: motivo/);
});

test("inventário confirmado não pode ser excluído", () => {
  // O ajuste já foi aplicado: apagar o registro deixaria o estoque sem explicação.
  assert.match(admin, /Inventário confirmado não pode ser excluído/);
});

test("CONFIRMAR não ajusta estoque nenhum", () => {
  // O ajuste só acontece depois da assinatura do PDV. Esta rota apenas muda o estado.
  const inicio = admin.indexOf('"/api/admin/inventario/confirmar"');
  const trecho = admin.slice(inicio);
  assert.doesNotMatch(trecho.slice(0, 2500), /UPDATE estoque_pdv|INSERT INTO integration_stock_launches/,
    "confirmar não pode tocar em estoque nem enfileirar lançamento");
  assert.match(trecho, /STATUS_INVENTARIO\.AGUARDANDO_ASSINATURA/);
});

test("confirmar exige contagem enviada e com ao menos um produto", () => {
  const inicio = admin.indexOf('"/api/admin/inventario/confirmar"');
  const trecho = admin.slice(inicio);
  assert.match(trecho, /inventario\.status !== STATUS_INVENTARIO\.ENVIADO/);
  assert.match(trecho, /Esta contagem não tem nenhum produto contado/);
});

test("a mudança de estado é publicada em tempo real", () => {
  assert.match(admin, /publishOrderAlert\("INVENTARIO_STATUS_CHANGED"/);
});

test("mexer no alternador não apaga o agendamento", () => {
  // Um PUT que gravasse as duas chaves sempre zeraria a data ao alternar o bloqueio.
  assert.match(admin, /if \(corpo\?\.bloqueado !== undefined\)/);
  assert.match(admin, /if \(corpo\?\.agendado_para !== undefined\)/);
});

test("data de agendamento inválida é recusada", () => {
  assert.match(admin, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(admin, /Data de agendamento inválida/);
});

test("mudanças da janela ficam auditadas com antes e depois", () => {
  assert.match(admin, /acao: "janela_alterada"/);
  assert.match(admin, /valorAnterior: `bloqueio=\$\{anterior\.bloqueioManual\}/);
});

// ===== Tela =====

test("a aba Inventários é do Almoxarifado e está no roteador", () => {
  assert.match(app, /\["inventarios", "Inventários"\]/);
  assert.match(app, /inventarios: viewInventarios,/);
});

test("produto não contado não mostra baixa — ele mantém o valor", () => {
  // Esta coluna já disse as duas coisas. Em 29/08 a regra virou "sem contagem zera" e a tela
  // passou a mostrar a baixa inteira. Em 30/08 a regra foi invertida de novo, e mostrar a
  // baixa aqui anunciaria um estrago que não vai acontecer — o produto não é tocado.
  const inicio = app.indexOf("async function abrirDetalheInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /const diferenca = temContagem \? Number\(contado\) - Number\(item\.saldo_atual \|\| 0\) : null;/);
  assert.match(corpo, /não contado — mantém/, "precisa dizer que o valor é mantido");
  assert.doesNotMatch(corpo, /inventario-sera-zerado/, "a marca de zeramento saiu");
});

test("o alternador da tela é o inverso da chave de bloqueio", () => {
  // A chave gravada é "bloqueado"; o alternador mostra "liberado". Trocar o sinal aqui
  // faria o Almoxarifado travar a contagem achando que estava liberando.
  assert.match(app, /await salvarJanelaContagem\(\{ bloqueado: !e\.currentTarget\.checked \}\)/);
  assert.match(app, /id="inventario-bloqueio" \$\{janela\.bloqueioManual \? "" : "checked"\}/);
});

test("a exclusão pela tela pede o motivo antes de chamar o servidor", () => {
  const inicio = app.indexOf("async function excluirInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  const posMotivo = corpo.indexOf("pedirMotivoExclusaoInventario");
  const posRequest = corpo.indexOf("request(");
  assert.ok(posMotivo > -1 && posMotivo < posRequest, "o motivo precisa ser pedido antes da chamada");
  assert.match(corpo, /if \(!motivo\) return;/);
});

test("a remoção de item só é aplicada ao salvar", () => {
  const inicio = app.indexOf("function bindDetalheInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /linha\.dataset\.remover = marcado \? "false" : "true"/);
  assert.match(corpo, /is-marked-remove/);
});

test("o aviso de contagem antiga explica o risco de venda no período", () => {
  assert.match(app, /O PDV continuou vendendo desde então/);
  assert.match(rotas, /const DIAS_CONTAGEM_ANTIGA = 2;/);
});

test("o histórico do inventário reaproveita o modal do relatório de edição do pedido", () => {
  // Padrão já existente no painel de pedidos; criar um segundo formato seria divergir.
  const inicio = app.indexOf("function abrirHistoricoInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /photo-viewer order-timeline-modal/);
  assert.match(corpo, /order-panel-timeline-list/);
});

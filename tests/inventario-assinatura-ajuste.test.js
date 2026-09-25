import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { montarAjusteInventario, normalizarQuantidade, normalizarQuantidadeInventario } from "../server/services/integrations/providers/omie/omie.operacoes.js";
import { chaveAjusteInventario, EVENTO_AJUSTE_INVENTARIO } from "../server/services/inventarios/ajuste-inventario.service.js";

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");
const ajuste = ler("server/services/inventarios/ajuste-inventario.service.js");
const eventos = ler("server/services/inventarios/inventario.events.js");
const rotas = ler("server/modules/inventarios/inventarios.routes.js");
const app = ler("public/app.js");

// ===== Ajuste no estoque local =====

test("o ajuste SUBSTITUI o saldo, nunca soma", () => {
  // Somar transformaria contagem física em entrada de mercadoria.
  assert.match(ajuste, /UPDATE estoque_pdv\s*\n\s*SET quantidade = \$3,/);
  assert.doesNotMatch(ajuste, /SET quantidade = quantidade [+-]/, "não pode somar nem subtrair");
});

test("produto sem contagem é PRESERVADO, não zerado", () => {
  // Regra invertida em 30/08/2026, depois de a anterior causar dano real em produção: no
  // INV-20260829184051-862E alguém contou 4 de 338 produtos e concluiu; 9 com saldo real
  // foram a zero e 8 chegaram à OMIE. É o ponto que decide o inventário inteiro.
  assert.match(ajuste, /if \(semContagem\) \{/);
  assert.match(ajuste, /preservados\.push\(\{ sku: item\.sku_produto, saldoPreservado: anterior \}\)/);
  // O atalho da regra antiga (ausência vira zero) não pode voltar
  assert.doesNotMatch(ajuste, /quantidade_contada === undefined\s*\n?\s*\? 0/);
});

test("zero DIGITADO continua zerando — ausência e zero não são a mesma coisa", () => {
  // "Em branco" é "não conferi"; "0" é "conferi e não há nenhum". Só o segundo zera.
  const rotasSrc = ler("server/modules/inventarios/inventarios.routes.js");
  assert.match(rotasSrc, /if \(quantidade === null \|\| quantidade === undefined \|\| quantidade === ""\) return null;/,
    "ausência precisa continuar virando NULL, distinta de 0");
  // E o ajuste só pula quando é NULL, nunca quando é 0
  assert.match(ajuste, /const semContagem = item\.quantidade_contada === null \|\| item\.quantidade_contada === undefined;/);
});

test("o saldo anterior é guardado antes de ser sobrescrito", () => {
  // Sem isto não há como auditar depois de onde o estoque veio.
  assert.match(ajuste, /UPDATE inventario_itens SET quantidade_anterior = \$2 WHERE id = \$1/);
  const posGuarda = ajuste.indexOf("quantidade_anterior = $2");
  const posEscrita = ajuste.indexOf("UPDATE estoque_pdv");
  assert.ok(posGuarda < posEscrita, "o saldo anterior precisa ser guardado antes do UPDATE do estoque");
});

test("inventário do Almoxarifado não mexe em estoque_pdv", () => {
  // pdv_id nulo é o Almoxarifado, cujo saldo é o estoque central vindo da OMIE.
  assert.match(ajuste, /if \(inventario\.pdv_id !== null && inventario\.pdv_id !== undefined\)/);
});

test("o local do lançamento vem do vínculo do PDV, nunca é adivinhado", () => {
  assert.match(ajuste, /FROM pdv_stock_location_mappings/);
  assert.match(ajuste, /configuracao\?\.local_almoxarifado/);
});

test("falhar ao enfileirar não derruba a assinatura", () => {
  // A contagem já foi assinada e o estoque já mudou: perder a fila é recuperável,
  // perder a assinatura não.
  const corpo = ajuste.slice(ajuste.indexOf("export async function enfileirarAjusteNaOmie"));
  assert.match(corpo, /catch \(erro\) \{/);
  assert.match(corpo, /return \{ enfileirados: 0, erro: erro\.message \}/);
});

test("a chave de idempotência é por inventário + produto", () => {
  const chave = chaveAjusteInventario({ codigoInventario: "INV-1", sku: "ABC" });
  assert.equal(chave, "INVENTARIO-INV-1-SKU-ABC-AJUSTE");
  // Não pode colidir com as chaves de pedido, que começam com PEDIDO-
  assert.ok(!chave.startsWith("PEDIDO-"));
  assert.equal(EVENTO_AJUSTE_INVENTARIO, "INVENTARIO_AJUSTE");
});

// ===== Payload da OMIE =====

test("o ajuste de inventário usa tipo SLD e motivo INV", () => {
  const payload = montarAjusteInventario({
    chaveOperacao: "K", sku: "ABC", codigoLocal: "2001", quantidade: 12
  });
  assert.equal(payload.tipo, "SLD");
  assert.equal(payload.motivo, "INV");
  assert.equal(payload.origem, "AJU");
  assert.equal(payload.codigo_local_estoque, 2001);
  // Ajuste de saldo não tem destino: não é transferência
  assert.ok(!("codigo_local_estoque_destino" in payload));
});

test("quantidade zero é válida no inventário e inválida no movimento", () => {
  // Zero é o que o usuário DIGITA para zerar um produto conferido. Num movimento (TRF/SAI)
  // zero não move nada e mascara erro de cálculo — por isso as duas funções são separadas.
  assert.equal(normalizarQuantidadeInventario(0), "0");
  assert.throws(() => normalizarQuantidade(0), /Quantidade invalida/);
  assert.throws(() => normalizarQuantidadeInventario(-1), /Quantidade invalida/);
});

test("o ajuste de inventário exige o local de estoque", () => {
  assert.throws(() => montarAjusteInventario({ sku: "ABC", quantidade: 1 }), /local de estoque/);
});

test("SLD segue proibido no caminho da transferência", () => {
  // A exceção é só do inventário. A trava original continua valendo para transferências.
  const transferencias = ler("server/services/integrations/providers/omie/tarefas/transferencias.js");
  assert.doesNotMatch(transferencias, /"SLD"/);
});

// ===== Canal de tempo real do PDV =====

test("o evento só vai para o PDV dono da contagem", () => {
  // Abrir o canal do Almoxarifado ao PDV entregaria a cada ponto as contagens dos outros.
  assert.match(eventos, /if \(conexao\.pdvId !== alvo\) continue;/);
});

test("evento sem pdvId não é publicado para ninguém", () => {
  // Melhor o PDV descobrir pelo polling do que um evento vazar por um campo esquecido.
  assert.match(eventos, /if \(pdvId === null \|\| pdvId === undefined\) return null;/);
});

test("a rota do canal exige papel de PDV e usa o pdvId da sessão", () => {
  const trecho = rotas.slice(rotas.indexOf('"/api/pdv/inventario/eventos"'));
  assert.match(trecho.slice(0, 400), /requireUser\(req, res, "pdv"\)/);
  assert.match(trecho.slice(0, 400), /handleEventosDoPdv\(req, res, user\.pdvId\)/);
});

test("o SSE não passa por compressão nem buffer", () => {
  assert.match(eventos, /"X-Accel-Buffering": "no"/);
  assert.match(eventos, /res\.writeHead\(200, \{/, "escreve o cabeçalho direto, sem o send() que comprime");
});

test("a conexão do PDV é fechada no logout", () => {
  // Sem isto a conexão sobreviveria ao logout, ainda ligada ao PDV anterior.
  const corpo = app.slice(app.indexOf('document.querySelector("#logout")'), app.indexOf('document.querySelector("#logout")') + 600);
  assert.match(corpo, /desconectarEventosDoPdv\(\)/);
});

// ===== Assinatura =====

test("a assinatura exige PNG e recusa quadro em branco", () => {
  const corpo = rotas.slice(rotas.indexOf("export function validarAssinatura"));
  assert.match(corpo, /startsWith\(PREFIXO_PNG\)/);
  assert.match(corpo, /Assinatura em branco/);
  assert.match(corpo, /LIMITE_ASSINATURA/, "precisa de teto de tamanho");
});

test("só 'Aguardando assinatura' pode ser assinado", () => {
  // Assinar duas vezes não pode ajustar o estoque duas vezes.
  const corpo = rotas.slice(rotas.indexOf("async function rotaAssinaturaDoPdv"));
  assert.match(corpo, /inventario\.status !== STATUS_INVENTARIO\.AGUARDANDO_ASSINATURA/);
  assert.match(corpo, /Este inventário já foi assinado/);
});

test("a assinatura é do dono: a busca filtra pelo pdv_id da sessão", () => {
  const corpo = rotas.slice(rotas.indexOf("async function rotaAssinaturaDoPdv"));
  assert.match(corpo, /WHERE codigo_inventario = \$1 AND pdv_id = \$2/);
  assert.match(corpo, /FOR UPDATE/);
});

test("o ajuste roda antes de marcar como confirmado, na mesma transação", () => {
  const corpo = rotas.slice(rotas.indexOf("async function rotaAssinaturaDoPdv"));
  const posAjuste = corpo.indexOf("aplicarAjusteLocal(client, inventario)");
  const posStatus = corpo.indexOf("STATUS_INVENTARIO.CONFIRMADO, assinatura");
  assert.ok(posAjuste > -1 && posAjuste < posStatus, "o ajuste precisa vir antes da mudança de estado");
});

test("a auditoria da assinatura guarda cada ajuste aplicado", () => {
  assert.match(rotas, /acao: "inventario_assinado"/);
  assert.match(rotas, /preservados_sem_contagem: preservados.length/);
  assert.match(rotas, /ajustes: aplicados\.map\(\(i\) => \(\{ sku: i\.sku, de: i\.anterior, para: i\.contado \}\)\)/);
});

// ===== Tela de assinatura =====

test("o quadro de assinatura é o mesmo núcleo da devolução de avaria", () => {
  // Antes o desenho existia só dentro do formulário de avaria; o inventário teria de copiar.
  // Desde a Fase 2 do MyControl o núcleo mora em js/ui/assinatura.js (compartilhado com o
  // MyControl) e o app.js importa de lá: avaria e os dois inventários seguem usando o mesmo.
  const nucleo = fs.readFileSync("public/js/ui/assinatura.js", "utf8");
  assert.match(nucleo, /export function ligarQuadroDeAssinatura\(canvas, \{ aoDesenhar \} = \{\}\)/);
  assert.match(app, /import \{ ligarQuadroDeAssinatura \} from "\.\/js\/ui\/assinatura\.js\?v=/);
  assert.doesNotMatch(app, /function ligarQuadroDeAssinatura/, "a definição não pode voltar duplicada no app.js");
  const usos = [...app.matchAll(/ligarQuadroDeAssinatura\(/g)].length;
  assert.ok(usos >= 3, `esperava os três usos (avaria e os dois inventários), achei ${usos}`);
});

test("a assinatura pendente tem prioridade sobre a tela de contagem", () => {
  // É o único passo em que o inventário está parado esperando o PDV.
  const corpo = app.slice(app.indexOf("async function viewInventario"));
  const posPendente = corpo.indexOf("/api/pdv/inventario/assinatura");
  const posContagem = corpo.indexOf('request("/api/pdv/inventario"');
  assert.ok(posPendente > -1 && posPendente < posContagem, "a checagem de assinatura vem primeiro");
});

test("a tela de assinatura mostra com o que cada produto vai ficar", () => {
  const corpo = app.slice(app.indexOf("function blocoAssinaturaInventario"), app.indexOf("\n}\n", app.indexOf("function blocoAssinaturaInventario")));
  assert.match(corpo, /Ficará com/);
  assert.match(corpo, /inventario-preservado/);
  assert.match(corpo, /mantêm o valor atual/);
  assert.doesNotMatch(corpo, /serão zerados/, "a promessa antiga não pode sobreviver na tela");
});

test("assinar pede confirmação marcada como ação de risco", () => {
  const corpo = app.slice(app.indexOf("function bindAssinaturaInventario"));
  assert.match(corpo, /danger: true/);
  assert.match(corpo, /só um novo inventário corrige/);
  assert.match(corpo, /Informe o nome de quem está assinando/);
});

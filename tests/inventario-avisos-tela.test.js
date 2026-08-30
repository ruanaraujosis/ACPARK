import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");
const semComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const app = ler("public/app.js");
const css = ler("public/styles.css");
const rotas = ler("server/modules/inventarios/inventarios.routes.js");
const html = ler("public/index.html");

// ===== Formulário de aviso manual =====

test("o formulário de aviso fica na aba onde o Almoxarifado controla a contagem", () => {
  // Requisito: no mesmo lugar do bloqueio e do agendamento.
  const view = app.slice(app.indexOf("async function viewInventarios"), app.indexOf("\n}\n", app.indexOf("async function viewInventarios")));
  assert.match(view, /blocoJanelaContagem\(janela\)/);
  assert.match(view, /blocoEmissaoDeAviso\(avisosAtivos\)/);
  assert.match(view, /bindEmissaoDeAviso\(\)/);
});

test("o formulário usa a rota já existente e testada", () => {
  const bloco = app.slice(app.indexOf("function bindEmissaoDeAviso"));
  assert.match(bloco, /request\("\/api\/admin\/avisos", \{\s*\n?\s*method: "POST"/);
  assert.match(bloco, /body: JSON\.stringify\(\{ mensagem, expira_em: expira \}\)/);
});

test("mensagem vazia nem chega ao servidor", () => {
  const bloco = app.slice(app.indexOf("function bindEmissaoDeAviso"));
  const posGuarda = bloco.indexOf("Escreva a mensagem do aviso");
  const posRequest = bloco.indexOf("request(");
  assert.ok(posGuarda > -1 && posGuarda < posRequest, "a validação precisa vir antes da chamada");
});

test("os avisos no ar são listados, com opção de encerrar antes da hora", () => {
  const bloco = app.slice(app.indexOf("function blocoEmissaoDeAviso"), app.indexOf("\n}\n", app.indexOf("function blocoEmissaoDeAviso")));
  assert.match(bloco, /avisos\.filter\(\(aviso\) => aviso\.tipo === "MANUAL"\)/);
  assert.match(bloco, /aviso-encerrar/);
  const bind = app.slice(app.indexOf("function bindEmissaoDeAviso"));
  assert.match(bind, /method: "DELETE"/);
  assert.match(bind, /confirmSystem\(/, "encerrar um aviso pede confirmação");
});

test("o aviso de agendamento aparece com a nota de como encerrá-lo", () => {
  // Ele não tem botão de encerrar: sai limpando a data, que é o controle que o criou.
  const bloco = app.slice(app.indexOf("function blocoEmissaoDeAviso"), app.indexOf("\n}\n", app.indexOf("function blocoEmissaoDeAviso")));
  assert.match(bloco, /is-agendamento/);
  assert.match(bloco, /limpe a data acima/);
});

// ===== Banner só para o PDV =====

test("o banner é do PDV; o Almoxarifado vê os avisos na lista da aba", () => {
  // Descoberto na verificação visual: o banner cobria o alternador de contagem, que fica no
  // mesmo canto. Para quem emite o aviso, o banner também não informa nada.
  const bloco = app.slice(app.indexOf("async function carregarAvisos"), app.indexOf("\n}\n", app.indexOf("async function carregarAvisos")));
  assert.match(bloco, /if \(state\.user\?\.role !== "pdv"\) return;/);
});

// ===== Simulação visível, não só no comentário =====

test("concluir em simulação devolve o aviso e grava no histórico", () => {
  const concluir = rotas.slice(rotas.indexOf('"/api/admin/inventario/proprio/concluir"'));
  assert.match(concluir, /acao: "ajuste_em_simulacao"/);
  assert.match(concluir, /a próxima sincronização vai sobrescrever o estoque central/);
  assert.match(concluir, /simulacao\n?\s*\};/, "a resposta precisa dizer se foi simulação");
});

test("o aviso da simulação vem do histórico, não do modo atual da integração", () => {
  // Ligar a integração para REAL depois não desfaz a sobrescrita que já aconteceu: o que
  // importa é como estava QUANDO o ajuste foi aplicado.
  assert.match(rotas, /ajustado_em_simulacao: historico\.some\(\(linha\) => linha\.acao === "ajuste_em_simulacao"\)/);
});

test("o aviso aparece na conclusão e continua no detalhe depois", () => {
  const bind = app.slice(app.indexOf("function bindContagemDoAlmoxarifado"));
  assert.match(bind, /if \(r\.simulacao\)/, "avisa no momento da conclusão");
  assert.match(bind, /Ajuste registrado só no MyEstoque/);
  // E o detalhe mostra sempre que aquele inventário foi ajustado em simulação
  const detalhe = app.slice(app.indexOf("async function abrirDetalheInventario"));
  assert.match(detalhe, /dados\.ajustado_em_simulacao \? `<div class="release-alert card inventario-aviso-simulacao">/);
  assert.match(detalhe, /Este ajuste ficou só no MyEstoque/);
  assert.match(app, /ajuste_em_simulacao: "Ajuste não enviado \(modo simulação\)"/, "o histórico tem rótulo próprio");
});

// ===== Tela de contagem do Almoxarifado =====

test("a contagem do Almoxarifado é em unidade, sem seletor de embalagem", () => {
  // Decisão do usuário (commit 4da04af): "Sem seletor embalagem-unidade, os PDV devem contar
  // apenas por UNIDADE". Vale para as duas telas de contagem.
  const bloco = app.slice(app.indexOf("function blocoContagemDoAlmoxarifado"), app.indexOf("\n}\n", app.indexOf("function blocoContagemDoAlmoxarifado")));
  assert.match(bloco, /"Contagem \(un\)"/);
  assert.doesNotMatch(semComentarios(bloco), /EMBALAGEM/i, "nenhuma menção a embalagem na contagem");
  const itens = app.slice(app.indexOf("function itensDaTelaAlmox"), app.indexOf("\n}\n", app.indexOf("function itensDaTelaAlmox")));
  assert.match(itens, /unidade_medida: "UNIDADE"/);
});

test("a tela do Almoxarifado reusa o núcleo de assinatura e a regra branco != zero", () => {
  const bind = app.slice(app.indexOf("function bindContagemDoAlmoxarifado"));
  assert.match(bind, /ligarQuadroDeAssinatura\(canvas\)/);
  const itens = app.slice(app.indexOf("function itensDaTelaAlmox"), app.indexOf("\n}\n", app.indexOf("function itensDaTelaAlmox")));
  assert.match(itens, /contagemDigitada\(/, "mesma leitura de campo da contagem do PDV");
  assert.doesNotMatch(itens, /\.filter\(/, "as linhas em branco também precisam ser enviadas");
});

test("concluir diz que os não contados mantêm o valor, e segue sendo ação de risco", () => {
  // A confirmação continua marcada como risco porque o inventário substitui saldo — mas o
  // texto deixou de anunciar zeramento por omissão, que é o que a regra nova proíbe.
  const bind = app.slice(app.indexOf("function bindContagemDoAlmoxarifado"));
  assert.match(bind, /mantêm o valor atual/);
  assert.doesNotMatch(bind, /ZERADOS/, "o aviso de zeramento por omissão saiu");
  assert.match(bind, /danger: true/);
  // Salva antes de concluir, para não perder o que foi digitado
  const posSalvar = bind.indexOf("await salvar();");
  const posConcluir = bind.indexOf("/api/admin/inventario/proprio/concluir");
  assert.ok(posSalvar > -1 && posSalvar < posConcluir);
});

// ===== Cache =====

test("o cache-bust acompanhou a última mudança do app.js", () => {
  // Verificado na prova visual: com o mesmo ?v=, o navegador serviu a versão antiga e a
  // correção parecia não ter sido aplicada.
  const versao = html.match(/app\.js\?v=([^"]+)/)?.[1];
  assert.equal(versao, "20260824-inventario-preserva-01");
  assert.match(html, new RegExp(`styles\\.css\\?v=${versao}`), "css e js compartilham a versão");
});

test("o CSS do formulário e do aviso de simulação existe", () => {
  assert.match(css, /\.aviso-emissao-form \{[\s\S]{0,200}?display: grid/);
  assert.match(css, /\.aviso-ativo \{/);
  assert.match(css, /\.inventario-aviso-simulacao \{/);
});

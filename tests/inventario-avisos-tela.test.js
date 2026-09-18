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
  // Requisito: no mesmo lugar do bloqueio e do agendamento. Em 31/08 o bloqueio e o
  // agendamento deixaram de ficar sempre visíveis (viraram o botão "Agendar", que abre
  // blocoJanelaContagem num painel à parte) -- o requisito continua valendo: ainda é a mesma
  // aba, só que agora acessado por um botão em vez de estar sempre exposto.
  const view = app.slice(app.indexOf("async function viewInventarios"), app.indexOf("\n}\n", app.indexOf("async function viewInventarios")));
  assert.match(view, /id="inventario-agendar-abrir"/, "o botão que abre o agendamento mora na mesma view");
  assert.match(view, /blocoEmissaoDeAviso\(avisosAtivos\)/);
  assert.match(view, /bindEmissaoDeAviso\(\)/);
  assert.match(app, /function abrirAgendamentoContagem\(janela\)/);
  assert.match(
    app.slice(app.indexOf("function abrirAgendamentoContagem")),
    /\$\{blocoJanelaContagem\(janela\)\}/,
    "o conteúdo do bloqueio/agendamento continua sendo o mesmo, só que dentro do painel"
  );
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
  // Em 30/08 (layout) blocoContagemDoAlmoxarifado virou renderContagemPropria, que monta o
  // conteúdo do painel de tela cheia em vez de um card colado no fim da página.
  const bloco = app.slice(app.indexOf("function renderContagemPropria"), app.indexOf("\n}\n", app.indexOf("function renderContagemPropria")));
  assert.match(bloco, /"Contagem \(un\)"/);
  assert.doesNotMatch(semComentarios(bloco), /EMBALAGEM/i, "nenhuma menção a embalagem na contagem");
  const itens = app.slice(app.indexOf("function itensDaTelaAlmox"), app.indexOf("\n}\n", app.indexOf("function itensDaTelaAlmox")));
  assert.match(itens, /unidade_medida: "UNIDADE"/);
});

test("a contagem do Almoxarifado assina num painel próprio, fora da lista de produtos", () => {
  // Em 30/08 o quadro de assinatura (canvas de 220px) foi removido do rodapé do painel
  // principal -- sozinho ele já impedia a lista de milhares de produtos de aparecer. Um dia
  // depois, o próprio painel principal virou tela cheia e o nome + assinatura passaram a
  // viver num painel de confirmação à parte (pedirAssinaturaContagemPropria), que só abre ao
  // clicar em "Assinar e confirmar" -- não há mais nada disso dentro da tela da lista.
  const bind = app.slice(app.indexOf("function bindContagemDoAlmoxarifado"));
  assert.doesNotMatch(bind, /ligarQuadroDeAssinatura/, "o quadro de desenho não pertence mais a este bind");
  assert.match(bind, /pedirAssinaturaContagemPropria\(semContagem\)/);
  assert.doesNotMatch(bind, /"#almox-assinante"/, "o nome não é mais lido do painel principal");
  const assinatura = app.slice(app.indexOf("function pedirAssinaturaContagemPropria"), app.indexOf("\n}\n", app.indexOf("function pedirAssinaturaContagemPropria")));
  assert.match(assinatura, /ligarQuadroDeAssinatura\(/, "o painel de confirmação reusa o núcleo de assinatura");
  assert.match(assinatura, /temTinta\(\)/, "exige o traço, já que aqui o quadro tem espaço de sobra");
  const itens = app.slice(app.indexOf("function itensDaTelaAlmox"), app.indexOf("\n}\n", app.indexOf("function itensDaTelaAlmox")));
  assert.match(itens, /contagemDigitada\(/, "mesma leitura de campo da contagem do PDV");
  assert.doesNotMatch(itens, /\.filter\(/, "as linhas em branco também precisam ser enviadas");
});

test("o painel da contagem do Almoxarifado ocupa a página inteira e pode ser minimizado", () => {
  assert.match(css, /\.contagem-propria-overlay \.order-panel[\s\S]{0,20}width: 100vw;/);
  assert.match(app, /overlayClass: "contagem-propria-overlay",\s*\n\s*minimizable: true/);
  assert.match(app, /function minimizeDetailOverlay/);
  assert.match(app, /function restaurarDetailOverlay/);
  assert.match(css, /\.minimized-panel-chip \{/);
});

test("os ícones do cabeçalho do painel ficam agrupados, não espalhados", () => {
  // Antes, histórico/resumo + minimizar + fechar eram filhos soltos do cabeçalho, e o
  // space-between do .order-panel-head espalhava cada um numa posição diferente ao longo da
  // largura inteira. Agrupá-los num só bloco à direita faz eles ficarem lado a lado.
  const shell = app.slice(app.indexOf("function orderPanelShell"), app.indexOf("\n}\n", app.indexOf("function orderPanelShell")));
  assert.match(shell, /<div class="order-panel-head-actions">/);
  const posAbreGrupo = shell.indexOf('<div class="order-panel-head-actions">');
  const posHeadExtra = shell.indexOf("${headExtra}");
  const posMinimizar = shell.indexOf("${minimizeButton}");
  const posClose = shell.indexOf('class="order-panel-close"');
  assert.ok(posAbreGrupo < posHeadExtra && posHeadExtra < posMinimizar && posMinimizar < posClose,
    "histórico/resumo, minimizar e fechar precisam estar dentro do mesmo agrupamento, nesta ordem");
  assert.match(css, /\.order-panel-head-actions \{/);
});

test("o filtro de estado fica no canto esquerdo, abaixo do título", () => {
  // Em 31/08: o bloqueio/agendamento saiu da mesma linha do filtro (virou o botão "Agendar",
  // ao lado do título) e o filtro passou a ocupar sozinho a linha de baixo, à esquerda --
  // não mais dividindo espaço com o bloco de janela.
  const view = app.slice(app.indexOf("async function viewInventarios"), app.indexOf("async function viewInventarios") + 2000);
  const posTopo = view.indexOf('<div class="inventario-topo">');
  const posFimTopo = view.indexOf("</div>\n      </div>") + "</div>\n      </div>".length;
  const topo = view.slice(posTopo, posFimTopo);
  const depoisDoTopo = view.slice(posFimTopo);
  assert.doesNotMatch(topo, /inventario-status-filtro/, "o filtro não mora mais dentro do .inventario-topo");
  assert.match(topo, /id="inventario-agendar-abrir"/, "o botão de agendar fica na mesma linha do título");
  const posSelect = depoisDoTopo.indexOf('<select id="inventarios-status" class="inventario-status-filtro"');
  assert.ok(posSelect > -1 && posSelect < 200, "o filtro é o próximo elemento logo abaixo do .inventario-topo");
  assert.doesNotMatch(view, /<div class="inventario-filtros">/, "não sobrou uma segunda linha vazia para o filtro");
  assert.match(css, /\.inventario-status-filtro \{/);
});

test("concluir diz que os não contados mantêm o valor, e segue sendo ação de risco", () => {
  // A confirmação continua marcada como risco porque o inventário substitui saldo — mas o
  // texto deixou de anunciar zeramento por omissão, que é o que a regra nova proíbe.
  // Em 31/08 o aviso saiu do confirmSystem() e foi para dentro do próprio painel de
  // assinatura (pedirAssinaturaContagemPropria): assinar já é a confirmação, então não há
  // mais um confirmSystem({danger:true}) separado -- o risco vem do botão "btn danger".
  const assinatura = app.slice(
    app.indexOf("function pedirAssinaturaContagemPropria"),
    app.indexOf("\n}\n", app.indexOf("function pedirAssinaturaContagemPropria"))
  );
  assert.match(assinatura, /mantêm o valor atual/);
  assert.doesNotMatch(assinatura, /ZERADOS/, "o aviso de zeramento por omissão saiu");
  assert.match(assinatura, /btn danger assinatura-contagem-ok/, "o botão que finaliza é de risco");
  // Salva antes de concluir, para não perder o que foi digitado
  const bind = app.slice(app.indexOf("function bindContagemDoAlmoxarifado"));
  const posSalvar = bind.indexOf("await salvar();");
  const posConcluir = bind.indexOf("/api/admin/inventario/proprio/concluir");
  assert.ok(posSalvar > -1 && posSalvar < posConcluir);
});

// ===== Cache =====

test("o cache-bust acompanhou a última mudança do app.js", () => {
  // Verificado na prova visual: com o mesmo ?v=, o navegador serviu a versão antiga e a
  // correção parecia não ter sido aplicada.
  const versao = html.match(/app\.js\?v=([^"]+)/)?.[1];
  assert.equal(versao, "20260918-categorias-fix-sync-e-bulk");
  assert.match(html, new RegExp(`styles\\.css\\?v=${versao}`), "css e js compartilham a versão");
});

test("o CSS do formulário e do aviso de simulação existe", () => {
  assert.match(css, /\.aviso-emissao-form \{[\s\S]{0,200}?display: grid/);
  assert.match(css, /\.aviso-ativo \{/);
  assert.match(css, /\.inventario-aviso-simulacao \{/);
});

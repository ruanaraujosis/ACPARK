import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");

// Remove comentários antes de asserções do tipo "não pode conter X". O comentário que explica
// POR QUE algo não é usado cita justamente o termo proibido — sem isto, a documentação derruba
// o teste. Mesmo recorte que tests/integrations-architecture.test.js já usa.
const semComentarios = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rotas = ler("server/modules/inventarios/inventarios.routes.js");
const ajuste = ler("server/services/inventarios/ajuste-inventario.service.js");
const app = ler("public/app.js");

const proprio = rotas.slice(rotas.indexOf("// ===== Inventário do próprio Almoxarifado ====="), rotas.indexOf("// ===== Avisos aos PDVs ====="));
const avisos = rotas.slice(rotas.indexOf("// ===== Avisos aos PDVs ====="));

// ===== O zeramento vale para o catálogo, não só para as linhas =====

test("o ajuste percorre o catálogo, não as linhas já gravadas", () => {
  // Bug real: percorrendo só inventario_itens, um produto que ninguém abriu na tela não tem
  // linha e sobreviveria calado — contar 2 de 500 e concluir deixaria 498 intactos, ao
  // contrário da regra "sem contagem é zerado".
  for (const [nome, fonte] of [["PDV", ajuste], ["Almoxarifado", proprio]]) {
    assert.match(fonte, /WITH catalogo AS \(/, `o ajuste do ${nome} precisa partir do catálogo`);
    assert.match(fonte, /LEFT JOIN inventario_itens it ON it\.inventario_id = \$1/, `${nome}: itens entram por LEFT JOIN`);
    assert.match(fonte, /UNION\s*\n\s*SELECT sku_produto FROM inventario_itens/, `${nome}: o UNION traz o que o Almoxarifado acrescentou`);
  }
});

test("produto zerado sem linha ganha uma, para o zeramento ficar registrado", () => {
  for (const [nome, fonte] of [["PDV", ajuste], ["Almoxarifado", proprio]]) {
    assert.match(fonte, /if \(item\.id\) \{/, `${nome}: precisa distinguir item com e sem linha`);
    assert.match(fonte, /INSERT INTO inventario_itens[\s\S]{0,200}quantidade_anterior/, `${nome}: cria a linha do produto zerado`);
  }
});

test("o catálogo do Almoxarifado é o cadastro ativo inteiro", () => {
  // Ele guarda tudo: não há pdv_categorias limitando o que o Almoxarifado tem.
  assert.match(proprio, /SELECT sku AS sku_produto FROM produtos WHERE ativo = TRUE/);
  assert.doesNotMatch(semComentarios(proprio), /pdv_categorias/, "o catalogo do Almoxarifado nao filtra por categoria de PDV");
});

// ===== Fluxo curto do Almoxarifado =====

test("o Almoxarifado conta e assina num passo, sem repasse", () => {
  // Não há segunda parte: ele não passa por "Enviado" nem por "Aguardando assinatura".
  const concluir = proprio.slice(proprio.indexOf('"/api/admin/inventario/proprio/concluir"'));
  assert.match(concluir, /inventario\.status !== STATUS_INVENTARIO\.EM_CONTAGEM/);
  assert.match(concluir, /STATUS_INVENTARIO\.CONFIRMADO, assinadoPor, assinatura/);
  assert.doesNotMatch(concluir.slice(0, 2000), /AGUARDANDO_ASSINATURA|STATUS_INVENTARIO\.ENVIADO/,
    "o fluxo do Almoxarifado não passa pelos estados de repasse");
});

test("concluir exige assinatura de verdade", () => {
  const concluir = proprio.slice(proprio.indexOf('"/api/admin/inventario/proprio/concluir"'));
  assert.match(concluir, /validarAssinatura\(corpo\?\.assinatura\)/);
  // A assinatura é validada antes de qualquer escrita no estoque
  const posAssinatura = concluir.indexOf("validarAssinatura");
  const posAjuste = concluir.indexOf("aplicarAjusteDoAlmoxarifado");
  assert.ok(posAssinatura < posAjuste, "a assinatura precisa ser validada antes de ajustar o estoque");
});

test("todas as rotas do inventário próprio exigem admin", () => {
  const guardas = [...proprio.matchAll(/requireUser\(req, res, "(\w+)"\)/g)].map((m) => m[1]);
  assert.ok(guardas.length >= 4, `esperava uma guarda por rota, achei ${guardas.length}`);
  assert.ok(guardas.every((p) => p === "admin"), `todas precisam exigir admin: ${guardas.join(", ")}`);
});

test("a rota do inventário próprio recusa um inventário de PDV", () => {
  // Sem isso, mandar o código de um PDV nesta rota aplicaria o ajuste do Almoxarifado
  // sobre a contagem dele.
  assert.match(proprio, /if \(inventario\.pdv_id !== null\)/);
  assert.match(proprio, /Esta rota é só do inventário do Almoxarifado/);
});

test("a janela dos PDVs não trava o Almoxarifado", () => {
  // Aquele bloqueio existe para o Almoxarifado controlar quando os PDVs contam; travar a
  // si mesmo com o próprio controle seria um nó.
  assert.doesNotMatch(proprio, /estadoDaJanela/);
});

test("o inventário do Almoxarifado mexe no estoque central, não em estoque_pdv", () => {
  assert.match(proprio, /UPDATE produtos SET qtd_total = \$2 WHERE sku = \$1/);
  assert.doesNotMatch(proprio, /UPDATE estoque_pdv/);
  // E o serviço do PDV, por sua vez, pula estoque_pdv quando pdv_id é nulo
  assert.match(ajuste, /if \(inventario\.pdv_id !== null && inventario\.pdv_id !== undefined\)/);
});

// ===== Avisos =====

test("o aviso de agendamento é único: reagendar substitui em vez de empilhar", () => {
  assert.match(avisos, /UPDATE avisos SET ativo = FALSE WHERE tipo = \$1 AND ativo = TRUE/);
  assert.match(rotas, /registrarAvisoDeAgendamento\(client, \{ data, usuario \}\)/);
});

test("o aviso de agendamento expira sozinho quando a data passa", () => {
  // Um aviso dizendo "inventário dia 15" ainda visível no dia 20 é ruído que ninguém limpa.
  assert.match(avisos, /expira_em IS NULL OR expira_em >= CURRENT_TIMESTAMP/);
  assert.match(avisos, /\(\$5::date \+ INTERVAL '1 day'\)/);
});

test("qualquer sessão lê os avisos, mas só o admin cria", () => {
  const leitura = avisos.slice(avisos.indexOf('"/api/avisos"'), avisos.indexOf('"/api/admin/avisos"'));
  assert.match(leitura, /requireUser\(req, res\)/, "a leitura não pode exigir papel: é o PDV que precisa ver");
  const escrita = avisos.slice(avisos.indexOf('url.pathname === "/api/admin/avisos" && method === "POST"'));
  assert.match(escrita.slice(0, 300), /requireUser\(req, res, "admin"\)/);
});

test("aviso sem mensagem é recusado", () => {
  assert.match(avisos, /Escreva a mensagem do aviso/);
});

test("desligar um aviso não apaga o registro", () => {
  assert.match(avisos, /UPDATE avisos SET ativo = FALSE WHERE id = \$1/);
  assert.doesNotMatch(avisos, /DELETE FROM avisos/, "o registro de que o aviso existiu tem valor");
});

// ===== Tela dos avisos =====

test("o fechamento do aviso vale só para a sessão", () => {
  // Requisito: o aviso reaparece a cada novo login, mesmo já tendo sido fechado antes.
  // localStorage faria o fechamento durar para sempre; sessionStorage sobreviveria à troca
  // de usuário na mesma aba.
  const bloco = app.slice(app.indexOf("// ===== Avisos (sino ao lado do menu + banner) ====="));
  assert.match(bloco, /let avisosFechados = new Set\(\)/);
  assert.doesNotMatch(semComentarios(bloco), /localStorage|sessionStorage/, "o fechamento nao pode ser persistido");
  assert.match(bloco, /function reiniciarAvisosDaSessao/);
  // E o logout limpa, para quem entrar depois ver tudo de novo
  const logout = app.slice(app.indexOf('document.querySelector("#logout")'), app.indexOf('document.querySelector("#logout")') + 700);
  assert.match(logout, /reiniciarAvisosDaSessao\(\)/);
});

test("o sino fica ao lado do menu de três barras", () => {
  const bloco = app.slice(app.indexOf("// ===== Avisos (sino ao lado do menu + banner) ====="));
  assert.match(bloco, /wrap\.insertBefore\(sino, wrap\.firstChild\)/);
  assert.match(bloco, /querySelector\("\.menu-wrap"\)/);
});

test("vários avisos empilham em vez de se sobrepor", () => {
  const bloco = app.slice(app.indexOf("// ===== Avisos (sino ao lado do menu + banner) ====="));
  assert.match(bloco, /visiveis\s*\n?\s*\.map\(/, "um cartão por aviso");
  const css = ler("public/styles.css");
  assert.match(css, /\.aviso-banners \{[\s\S]{0,260}?display: grid/);
  assert.match(css, /\.aviso-banners \{[\s\S]{0,300}?overflow-y: auto/, "com muitos avisos, a pilha rola");
});

test("falhar ao buscar avisos não atrapalha a tela", () => {
  const bloco = app.slice(app.indexOf("async function carregarAvisos"), app.indexOf("\n}\n", app.indexOf("async function carregarAvisos")));
  assert.match(bloco, /catch \{/);
  assert.match(bloco, /silentLoading: true/);
});

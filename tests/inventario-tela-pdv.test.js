import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync("public/app.js", "utf8").split("\r\n").join("\n");
const css = fs.readFileSync("public/styles.css", "utf8").split("\r\n").join("\n");

test("cada perfil vê a sua aba de inventário, nunca a do outro", () => {
  // São duas telas diferentes: "inventario" (o PDV contando) e "inventarios" (o
  // Almoxarifado conferindo). Trocá-las de menu daria ao PDV a conferência de todos os
  // PDVs, e ao Almoxarifado um formulário de contagem que ele não usa.
  assert.match(app, /\["inventario", "Inventário"\]/);
  assert.match(app, /inventario: viewInventario,/);

  const menus = app.slice(app.indexOf('const items = role === "admin"'), app.indexOf("app.innerHTML"));
  const separador = menus.indexOf("\n    : [");
  const menuAdmin = menus.slice(0, separador);
  const menuPdv = menus.slice(separador);

  assert.match(menuAdmin, /"inventarios"/, "o Almoxarifado tem a aba de conferência");
  assert.doesNotMatch(menuAdmin, /"inventario"(?!s)/, "a tela de contagem do PDV não é do Almoxarifado");
  assert.match(menuPdv, /"inventario"(?!s)/, "o PDV tem a tela de contagem");
  assert.doesNotMatch(menuPdv, /"inventarios"/, "o PDV não pode ver a conferência de todos os PDVs");
});

test("não existe seletor de unidade na contagem", () => {
  // Decisão do usuário: o PDV conta sempre em unidade. Um seletor aqui reabriria a
  // possibilidade de digitar fardo e gravar unidade.
  const inicio = app.indexOf("function linhaContagemInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.doesNotMatch(corpo, /<select/, "a linha de contagem não pode ter seletor");
  assert.doesNotMatch(corpo, /EMBALAGEM/i);
});

test("a tela sempre declara UNIDADE ao enviar", () => {
  const inicio = app.indexOf("function itensDaTelaInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /unidade_medida: "UNIDADE"/);
});

test("campo em branco vira null, e zero continua sendo zero", () => {
  // O bug clássico aqui é usar teste de veracidade: 0 é falsy e viraria "não contado",
  // fazendo o produto zerado nunca ser zerado na OMIE.
  const inicio = app.indexOf("function contagemDigitada");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /if \(!texto\) return null;/, "só o texto vazio vira null");
  assert.match(corpo, /numero >= 0/, "zero precisa ser aceito");
  assert.doesNotMatch(corpo, /if \(!numero\)/, "não pode testar veracidade do número");
});

test("a tela manda também os campos em branco", () => {
  // Sem isso, apagar uma contagem já salva deixaria o valor antigo no banco.
  const inicio = app.indexOf("function itensDaTelaInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /querySelectorAll\("\.inventario-linha"\)/);
  assert.doesNotMatch(corpo, /\.filter\(/, "não pode filtrar as linhas não contadas antes de enviar");
});

test("o envio salva antes, para não perder o que foi digitado", () => {
  const inicio = app.indexOf("async function enviarContagemInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  const posPatch = corpo.indexOf('method: "PATCH"');
  const posEnviar = corpo.indexOf("/api/pdv/inventario/enviar");
  assert.ok(posPatch > -1 && posPatch < posEnviar, "o salvamento precisa vir antes do envio");
});

test("o envio avisa que os não contados MANTÊM o valor atual", () => {
  // Esta frase já mudou duas vezes e cada versão precisou casar com o que o código faz.
  // Em 29/08 a regra virou "sem contagem zera" e a mensagem passou a avisar o zeramento.
  // Em 30/08 a regra foi invertida de novo — depois de zerar 9 produtos de verdade — e
  // agora a tela precisa dizer o oposto: quem não foi contado não é tocado.
  const inicio = app.indexOf("async function enviarContagemInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /confirmSystem\(/);
  assert.match(corpo, /MANTÊM o valor atual do estoque/);
  assert.doesNotMatch(corpo, /ZERADOS/, "a promessa de zeramento não pode sobreviver");
  assert.match(corpo, /só o Almoxarifado pode alterar esta contagem/);
});

test("a tela de contagem explica a diferença entre branco e zero", () => {
  // A distinção é a regra inteira: em branco é "não conferi" (não muda nada); 0 é
  // "conferi e não há nenhum" (zera). Quem lê a tela precisa saber disso antes de digitar.
  const inicio = app.indexOf("async function viewInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /em branco.*mantém o valor atual/i);
  assert.match(corpo, /digite <strong>0<\/strong>/);
  assert.doesNotMatch(corpo, /será zerado/, "o aviso de zeramento por omissão saiu");
});

test("contagem bloqueada mostra o motivo, nunca um formulário mudo", () => {
  const inicio = app.indexOf("async function viewInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /janela\.liberado/);
  assert.match(corpo, /esc\(janela\.motivo\)/);
});

test("depois de enviado os campos ficam desabilitados e as ações somem", () => {
  const inicio = app.indexOf("async function viewInventario");
  const corpo = app.slice(inicio, app.indexOf("\n}\n", inicio));
  assert.match(corpo, /const somenteLeitura = Boolean\(inventario\) && inventario\.status !== "Em contagem"/);
  assert.match(corpo, /somenteLeitura \? "" : `/, "os botões de salvar/enviar só existem em contagem");
  assert.match(app, /somenteLeitura \? " disabled" : ""/);
});

test("a tabela rola com o cabeçalho fixo, sem esconder resumo e ações", () => {
  // A lista tem centenas de produtos: sem cabeçalho fixo, some a referência da coluna.
  assert.match(css, /\.inventario-tabela \{[\s\S]{0,160}?overflow-y: auto/);
  assert.match(css, /\.inventario-tabela thead th \{[\s\S]{0,120}?position: sticky/);
});

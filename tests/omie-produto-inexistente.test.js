import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ehProdutoInexistente, ehSemRegistros } from "../server/services/integrations/providers/omie/omie.api.js";

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");

// Incidente de 29/08/2026: a leitura de fatores estava parada havia dias em "0 produtos",
// e a causa só apareceu quando o catch parou de descartar a mensagem:
//   "ERROR: Produto não cadastrado para o ID [11072266739] !"
// Um único produto morto no ERP travava os 2.346 seguintes, porque o laço fazia break na
// primeira falha e aquela mensagem não era reconhecida como "produto sumiu".

test("reconhece o produto que não existe mais no ERP", () => {
  assert.equal(ehProdutoInexistente({ message: "ERROR: Produto não cadastrado para o ID [11072266739] !" }), true);
  // Sem acento também: a OMIE nem sempre é consistente
  assert.equal(ehProdutoInexistente({ message: "Produto nao cadastrado para o ID [1] !" }), true);
});

test("não confunde com outros erros", () => {
  assert.equal(ehProdutoInexistente({ message: "ERROR: API bloqueada por consumo indevido." }), false);
  assert.equal(ehProdutoInexistente({ message: "O saldo de estoque poderá ficar negativo" }), false);
  assert.equal(ehProdutoInexistente({}), false);
  assert.equal(ehProdutoInexistente(null), false);
});

test("é um predicado SEPARADO de ehSemRegistros, não uma ampliação dele", () => {
  // Os dois significam coisas diferentes: ehSemRegistros é "fim da paginação" em movimentos,
  // saldos e evidência de compra. Ampliá-lo faria um produto inexistente ser lido como fim de
  // lista naqueles laços, truncando a leitura em silêncio.
  assert.equal(ehSemRegistros({ message: "ERROR: Produto não cadastrado para o ID [1] !" }), false,
    "ehSemRegistros NÃO pode passar a reconhecer produto inexistente");
  assert.equal(ehProdutoInexistente({ message: "Nao existem registros" }), false,
    "e o novo predicado não pode invadir o significado do outro");
});

test("os laços de paginação continuam usando só ehSemRegistros", () => {
  // Se algum deles passar a aceitar produto inexistente, a paginação para cedo demais.
  for (const arquivo of ["movimentos.js", "saldos.js", "evidencia-compra.js"]) {
    const src = ler(`server/services/integrations/providers/omie/tarefas/${arquivo}`);
    assert.doesNotMatch(src, /ehProdutoInexistente/,
      `${arquivo} pagina resultados: produto inexistente não pode virar fim de lista`);
  }
});

test("a leitura de fatores segue para o próximo produto em vez de travar", () => {
  const src = ler("server/services/integrations/providers/omie/tarefas/fatores.js");
  assert.match(src, /if \(ehSemRegistros\(erro\) \|\| ehProdutoInexistente\(erro\)\) \{/);
  // O ramo marca como unitário e continua — não incrementa falhas nem faz break
  const bloco = src.slice(src.indexOf("if (ehSemRegistros(erro) || ehProdutoInexistente(erro))"));
  const posContinue = bloco.indexOf("continue;");
  const posBreak = bloco.indexOf("break;");
  assert.ok(posContinue > -1 && posContinue < posBreak, "o produto morto precisa cair no continue, não no break");
  assert.match(bloco.slice(0, posContinue), /STATUS_FATOR\.UNITARIO/);
});

test("a escrita de fator trata o mesmo caso", () => {
  // Mesma consulta por produto, mesmo risco latente.
  const src = ler("server/services/integrations/providers/omie/tarefas/escrita-fator.js");
  assert.match(src, /if \(ehSemRegistros\(erro\) \|\| ehProdutoInexistente\(erro\)\) return null;/);
});

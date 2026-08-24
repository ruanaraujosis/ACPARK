import test from "node:test";
import assert from "node:assert/strict";

import {
  lerFatorDaDescricao,
  lerValorDaPlanilha,
  normalizarNome,
  reconciliarAbas,
  semelhanca,
  sugerirVinculos
} from "../server/services/integrations/core/fator-planilha.js";
import {
  CONFIANCA,
  derivarDoGemeo,
  derivarSugestao,
  SITUACAO
} from "../server/services/integrations/core/fator-evidencia.js";

// Testes da planilha de controle de fardos como fonte de corroboracao.
//
// Regra central: a planilha CORROBORA, nunca decide. Ela e chaveada por nome de operacao, o
// casamento com o cadastro e textual, e nenhum vinculo pode ser feito sem uma pessoa.

test("so numero inteiro positivo na coluna B vira fator", () => {
  assert.equal(lerValorDaPlanilha(12), 12);
  assert.equal(lerValorDaPlanilha("12"), 12);
  assert.equal(lerValorDaPlanilha(1), 1);

  // Cabecalho de secao e unidade de controle nao geram fator
  for (const rotulo of ["UND", "UN", "LT", "L", "FRD", "FD", "cx", "CX", "PCT", "KG"]) {
    assert.equal(lerValorDaPlanilha(rotulo), null, `${rotulo} nao pode virar fator`);
  }

  // Mesmo criterio estrito do resto do sistema
  assert.equal(lerValorDaPlanilha("15 un"), null);
  assert.equal(lerValorDaPlanilha(1.5), null);
  assert.equal(lerValorDaPlanilha(0), null);
  assert.equal(lerValorDaPlanilha(-3), null);
  assert.equal(lerValorDaPlanilha(""), null);
  assert.equal(lerValorDaPlanilha(null), null);
});

test("aba nao preenchida nao conta como divergencia; dois numeros diferentes contam", () => {
  const linhas = reconciliarAbas({
    abril: [
      { nome: "ÁGUAS", valor: "UND" },
      { nome: "ÁGUA MINERAL GÁSOSA 500ML", valor: 15 },
      { nome: "GUARANÁ LT", valor: "LT" },
      { nome: "CERV. AMSTEL", valor: 1 }
    ],
    junho: [
      { nome: "ÁGUAS", valor: "UND" },
      { nome: "ÁGUA MINERAL GÁSOSA 500ML", valor: 15 },
      { nome: "GUARANÁ LT", valor: 12 },
      { nome: "CERV. AMSTEL", valor: 24 }
    ]
  });
  const achar = (nome) => linhas.find((l) => normalizarNome(l.nome_operacao) === normalizarNome(nome));

  // As duas abas concordam
  assert.equal(achar("ÁGUA MINERAL GÁSOSA 500ML").fator, 15);
  assert.equal(achar("ÁGUA MINERAL GÁSOSA 500ML").divergente, false);

  // Caso real: em abril "GUARANÁ LT" era cabecalho de secao ("LT"), em junho virou linha com
  // 12. Aba nao preenchida nao contradiz nada -- o numero vale.
  assert.equal(achar("GUARANÁ LT").fator, 12);
  assert.equal(achar("GUARANÁ LT").divergente, false);

  // Caso real: 1 em abril e 24 em junho. Dois numeros diferentes e contradicao de verdade,
  // e a media (12,5) seria um numero que nenhuma das abas afirma.
  assert.equal(achar("CERV. AMSTEL").divergente, true);
  assert.equal(achar("CERV. AMSTEL").fator, null);
  assert.deepEqual(achar("CERV. AMSTEL").valores_distintos, [1, 24]);
});

test("notas e planilha concordando produzem confianca maxima", () => {
  // Caso real: agua com gas, 9 notas com 10 CX -> 150 UN e planilha dizendo 15
  const resultado = derivarSugestao(
    [
      { fator: 15, vezes: 9, documento: { descricao: "AGUA COM GAS" } },
      { fator: 1, vezes: 21, documento: { descricao: "AGUA CRYSTAL C/G 500ML" } }
    ],
    { planilha: { fator: 15, nome_operacao: "ÁGUA MINERAL GÁSOSA 500ML", divergente: false } }
  );
  assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
  assert.equal(resultado.fator, 15);
  assert.equal(resultado.confianca, CONFIANCA.MAXIMA);
  assert.equal(resultado.fontes.notas.fator, 15);
  assert.equal(resultado.fontes.planilha.fator, 15);
});

test("notas e planilha discordando: a PLANILHA prevalece", () => {
  // Decisao do usuario, que conhece a operacao: a planilha e a contagem fisica do
  // almoxarifado. Caso real: FANTA LARANJA, 43 notas dizendo 12 e a planilha dizendo 6.
  const resultado = derivarSugestao([{ fator: 12, vezes: 43, documento: {} }], {
    planilha: { fator: 6, nome_operacao: "FANTA LT", divergente: false }
  });
  assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
  assert.equal(resultado.fator, 6, "o numero da planilha e o que vale");
  assert.equal(resultado.divergeDasNotas, 12, "mas o numero da nota continua visivel");
  assert.equal(resultado.exigeConfirmacao, true, "prevalecer nao dispensa a confirmacao");
  // As duas opcoes seguem na tela, com a planilha na frente
  assert.deepEqual(resultado.opcoes.map((o) => o.fator), [6, 12]);
});

test("planilha que se contradiz entre abas NAO prevalece", () => {
  // "A planilha esta certa" nao resolve qual das duas abas vale quando elas discordam entre
  // si -- ali nao existe um numero para prevalecer, e a decisao volta a ser humana.
  const resultado = derivarSugestao([{ fator: 12, vezes: 43, documento: {} }], {
    planilha: { fator: null, nome_operacao: "CERV. AMSTEL", divergente: true }
  });
  assert.equal(resultado.fator, 12, "sem numero na planilha, vale a nota");
  assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
});

test("planilha sozinha sugere, mas so como evidencia unica", () => {
  const resultado = derivarSugestao([], {
    planilha: { fator: 8, nome_operacao: "CERV. HEINEKEN LT", divergente: false }
  });
  assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
  assert.equal(resultado.fator, 8);
  assert.equal(resultado.confianca, CONFIANCA.UNICA);
  assert.equal(resultado.exigeConfirmacao, true);
});

test("planilha divergente entre abas nunca vira sugestao", () => {
  const resultado = derivarSugestao([], {
    planilha: { fator: null, nome_operacao: "CERV. AMSTEL", divergente: true }
  });
  assert.equal(resultado.fator, null);
  assert.match(resultado.motivo, /contradiz/i);
});

test("nota 1:1 com planilha dizendo mais NAO fica em fator 1", () => {
  // Foi o que aconteceu com a agua com gas ate 2025: quem lancava o recebimento nao convertia.
  // A planilha vem da contagem fisica, entao ela e que carrega o numero -- ainda a confirmar.
  const resultado = derivarSugestao([{ fator: 1, vezes: 20, documento: {} }], {
    planilha: { fator: 12, nome_operacao: "H2O", divergente: false }
  });
  assert.equal(resultado.situacao, SITUACAO.SO_AVULSO);
  assert.equal(resultado.fator, 12, "a planilha carrega o numero quando a nota so tem 1:1");
  assert.equal(resultado.confianca, null, "e continua sem rotulo de confianca");
  assert.equal(resultado.exigeConfirmacao, true);
});

test("mesma marca com fatores diferentes nunca se contamina", () => {
  // A planilha prova por que inferir por nome e proibido: COCA COLA LT = 15 e COCA COLA ZERO
  // LT = 6; CERV. ANTARTICA = 15, AMSTEL = 12, HEINEKEN = 8. Cada produto le a SUA linha.
  const comum = [{ fator: 15, vezes: 5, documento: {} }];
  const coca = derivarSugestao(comum, { planilha: { fator: 15, nome_operacao: "COCA COLA LT", divergente: false } });
  const zero = derivarSugestao([{ fator: 6, vezes: 5, documento: {} }], {
    planilha: { fator: 6, nome_operacao: "COCA COLA ZERO LT", divergente: false }
  });
  assert.equal(coca.fator, 15);
  assert.equal(zero.fator, 6);
  assert.equal(coca.confianca, CONFIANCA.MAXIMA);
  assert.equal(zero.confianca, CONFIANCA.MAXIMA);
});

test("modificador oposto derruba o candidato: com gas nao casa com sem gas", () => {
  // Medido: por contagem de palavras, "ÁGUA MINERAL GÁSOSA 500ML" parecia MAIS com
  // "AGUA MINERAL SEM GAS 500ML" (o produto OPOSTO, 3 palavras em comum) do que com
  // "AGUA COM GAS", que e o certo (1 palavra). "SEM" contra "COM" nao e diferenca de grau:
  // sao produtos distintos, e a contradicao derruba o candidato.
  const comGas = { external_product_id: "1", sku_produto: "7894900531008", nome: "AGUA COM GAS" };
  const semGas = { external_product_id: "3", sku_produto: "999", nome: "AGUA MINERAL SEM GAS 500ML" };

  assert.ok(
    semelhanca("ÁGUA MINERAL GÁSOSA 500ML", semGas.nome) < semelhanca("ÁGUA MINERAL GÁSOSA 500ML", comGas.nome),
    "o produto oposto nao pode pontuar mais que o certo"
  );

  // Mesmo corrigido, o casamento continua sendo SUGESTAO: nenhum vinculo e criado sozinho.
  const candidatos = sugerirVinculos("ÁGUA MINERAL GÁSOSA 500ML", [comGas, semGas]);
  assert.notEqual(candidatos[0]?.nome, semGas.nome);
});

test("token de duas letras conta: LATA nao pode casar com garrafa", () => {
  // Medido: descartando tokens curtos, "COCA COLA LT" (lata) e "COCA COLA 1.5L" (garrafa)
  // reduziam os dois a {COCA, COLA} e casavam 100% -- e "LT" era exatamente o que os
  // distinguia. O certo, "COCA COLA 310ML", ficava em segundo.
  const garrafa = semelhanca("COCA COLA LT", "COCA COLA 1.5L");
  assert.ok(garrafa < 1, "a garrafa nao pode dar casamento perfeito para uma linha de lata");
});

test("nome identico ainda casa em cheio", () => {
  assert.equal(semelhanca("GUARANÁ LT", "GUARANÁ LT"), 1);
});

test("nome sem nada em comum nao gera candidato", () => {
  const candidatos = sugerirVinculos("XEQUE MATE", [
    { external_product_id: "1", sku_produto: "106.1", nome: "COCA COLA 310ML" }
  ]);
  assert.equal(candidatos.length, 0, "melhor nenhum candidato do que um errado");
  assert.equal(semelhanca("XEQUE MATE", "COCA COLA 310ML"), 0);
});

test("fator escrito na descricao e lido, mas so como terceira fonte", () => {
  assert.deepEqual(lerFatorDaDescricao("REFRIGERANTE CX C/12"), { fator: 12, trecho: "CX C/12" });
  assert.equal(lerFatorDaDescricao("DEL VAL PESS LT 6X290ML").fator, 6);
  assert.equal(lerFatorDaDescricao("CHOC LACTA DP12X28G LAKA").fator, 12);
  assert.equal(lerFatorDaDescricao("PAPEL HIG SMART CX 6X1250").fator, 6);

  // Descricao sem padrao nenhum nao inventa numero
  assert.equal(lerFatorDaDescricao("AGUA COM GAS"), null);
  assert.equal(lerFatorDaDescricao("COCA COLA 310ML"), null, "310ML e volume, nao contagem");
  assert.equal(lerFatorDaDescricao(""), null);
});

test("a descricao sozinha nao promove a confianca", () => {
  // Terceira fonte e texto livre digitado no cadastro: confirma, nunca decide.
  const resultado = derivarSugestao([{ fator: 6, vezes: 5, documento: {} }], {
    descricao: { fator: 6, trecho: "6X290ML" }
  });
  assert.equal(resultado.confianca, CONFIANCA.ALTA, "sem planilha, continua ALTA e nao MAXIMA");
  assert.equal(resultado.fontes.descricao.fator, 6);
});

test("cadastro duplicado herda o fator do gemeo, e so ele", () => {
  // A OMIE guarda o mesmo item fisico duas vezes -- um cadastro pelo codigo interno e outro
  // pelo EAN -- e duplicado nao pode ser excluido, so inativado. Um fardo tem a mesma
  // quantidade nos dois registros, entao o fator vale para os dois.
  const gemeo = { fator: 45, sku: "7854", nome: "PICOLE BATON 45G" };
  const herdado = derivarDoGemeo(gemeo);
  assert.equal(herdado.situacao, SITUACAO.SUGERIDO);
  assert.equal(herdado.fator, 45);
  assert.equal(herdado.exigeConfirmacao, true);
  // Sem rotulo de confianca: a evidencia e do gemeo, nao deste cadastro
  assert.equal(herdado.confianca, null);
  assert.equal(herdado.herdadoDe.sku, "7854");
  assert.match(herdado.motivo, /mesmo item fisico/i);
});

test("gemeo sem fator, ou com fator 1, nao propaga nada", () => {
  // Herdar "1" seria transformar ausencia de evidencia em afirmacao
  assert.equal(derivarDoGemeo({ fator: 1, sku: "x", nome: "y" }), null);
  assert.equal(derivarDoGemeo({ fator: null, sku: "x", nome: "y" }), null);
  assert.equal(derivarDoGemeo(null), null);
});

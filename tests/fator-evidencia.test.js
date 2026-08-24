import test from "node:test";
import assert from "node:assert/strict";

import {
  classificarConfianca,
  CONFIANCA,
  derivarSugestao,
  ehPendenciaDeCadastro,
  interpretarRazao,
  SITUACAO,
  unidadeSuspeita
} from "../server/services/integrations/core/fator-evidencia.js";
import { lerEvidenciaDoItem } from "../server/services/integrations/providers/omie/tarefas/evidencia-compra.js";

// Testes do assistente de fator por historico de compra.
//
// Duas regras que estes testes existem para travar:
//   1. SO evidencia documental gera sugestao -- nunca semelhanca de nome, familia ou
//      conhecimento de mercado. Produto sem nota fica pendente.
//   2. NADA que sai da derivacao e conclusao. Toda sugestao exige confirmacao humana,
//      inclusive a de fator 1.

// Monta uma linha de evidencia com a descricao usada na comparacao de cadastro generico
const linha = (fator, vezes, descricao = "PRODUTO PADRAO") => ({
  fator,
  vezes,
  documento: { descricao }
});

test("a razao entre documento e estoque so vale como fator se for inteiro puro e positivo", () => {
  // 2 caixas viraram 24 unidades: a nota diz que a caixa tem 12
  assert.equal(interpretarRazao(2, 24), 12);
  assert.equal(interpretarRazao(1, 15), 15);
  assert.equal(interpretarRazao(30, 30), 1);

  // Fracao e ruido de lancamento, nao embalagem -- nos DOIS lados
  assert.equal(interpretarRazao(3, 10), null);
  assert.equal(interpretarRazao(4.448, 4.448), null);
  assert.equal(interpretarRazao(2, 5), null);

  // Caso real medido: "0,5 PCT -> 500 UND" dava fator 1000 porque 500/0,5 e inteiro.
  // Meia embalagem e erro de digitacao, e x1000 multiplicaria o pedido inteiro em silencio.
  assert.equal(interpretarRazao(0.5, 500), null);
  assert.equal(interpretarRazao(1.5, 30), null);

  assert.equal(interpretarRazao(0, 10), null);
  assert.equal(interpretarRazao(10, 0), null);
  assert.equal(interpretarRazao(-2, 10), null);
  assert.equal(interpretarRazao(null, 10), null);
  assert.equal(interpretarRazao("abc", 10), null);
});

test("estoque menor que o documento nunca vira fator", () => {
  // 10 unidades faturadas viraram 2 no estoque: isso e devolucao ou erro, nao embalagem
  assert.equal(interpretarRazao(10, 2), null);
});

test("a confianca sai do numero de notas que concordam", () => {
  assert.equal(classificarConfianca(19), CONFIANCA.ALTA);
  assert.equal(classificarConfianca(4), CONFIANCA.ALTA);
  assert.equal(classificarConfianca(3), CONFIANCA.MEDIA);
  assert.equal(classificarConfianca(2), CONFIANCA.MEDIA);
  assert.equal(classificarConfianca(1), CONFIANCA.UNICA);
  assert.equal(classificarConfianca(0), CONFIANCA.UNICA);
});

test("produto sem evidencia nenhuma fica pendente, nunca com fator adivinhado", () => {
  const resultado = derivarSugestao([]);
  assert.equal(resultado.situacao, SITUACAO.SEM_EVIDENCIA);
  assert.equal(resultado.fator, null);
  // Pendencia, nao conferencia: nao se cobra decisao sobre o que nao se sabe
  assert.equal(resultado.exigeConfirmacao, false);
});

test("so compra avulsa e SUGESTAO de fator 1, nunca fato consumado", () => {
  // O almoxarifado pode fracionar internamente uma embalagem que nao aparece em nota
  // nenhuma. Tratar "so aparece em UN" como fator 1 documentado e um passo alem da evidencia.
  const resultado = derivarSugestao([linha(1, 19)]);
  assert.equal(resultado.situacao, SITUACAO.SO_AVULSO);
  assert.equal(resultado.fator, 1);
  assert.match(resultado.motivo, /nao prova/i);
  // Fator 1 nao entra na fila de conferencia: nao ha o que configurar, o PDV pede em unidade
  assert.equal(resultado.exigeConfirmacao, false);
  assert.equal(resultado.nadaAConfigurar, true);
});

test("muitas notas avulsas NAO viram confianca alta", () => {
  // Caso real medido: o produto 7894900531008 (AGUA COM GAS) tem 21 notas registrando
  // "10 CX -> 10 UNID", porque ate o fim de 2025 quem lancava o recebimento nao convertia.
  // O fator verdadeiro e 15, e so aparece nas 9 notas de 2026 em que passaram a converter.
  // Numa varredura que nao alcance 2026, essas 21 notas sozinhas sugeririam fator 1 -- ou
  // seja, a contagem aqui mede quantas vezes ninguem converteu, nunca o quanto se sabe.
  const resultado = derivarSugestao([linha(1, 18)]);
  assert.equal(resultado.situacao, SITUACAO.SO_AVULSO);
  assert.equal(resultado.confianca, null, "compra avulsa nao pode receber rotulo de confianca");
  assert.equal(resultado.vezes, 18, "mas a contagem continua visivel para quem confere");
});

test("um unico fator acima de 1 vira sugestao, com a forca da evidencia junto", () => {
  const resultado = derivarSugestao([linha(12, 14)]);
  assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
  assert.equal(resultado.fator, 12);
  assert.equal(resultado.vezes, 14);
  assert.equal(resultado.confianca, CONFIANCA.ALTA);
  assert.equal(resultado.exigeConfirmacao, true);
});

test("uma nota so sugere, mas declarada como evidencia unica", () => {
  const resultado = derivarSugestao([linha(25, 1)]);
  assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
  assert.equal(resultado.fator, 25);
  assert.equal(resultado.confianca, CONFIANCA.UNICA);
});

test("duas ou tres notas concordando sao confianca media", () => {
  assert.equal(derivarSugestao([linha(15, 3)]).confianca, CONFIANCA.MEDIA);
  assert.equal(derivarSugestao([linha(15, 2)]).confianca, CONFIANCA.MEDIA);
});

test("produto tambem comprado avulso continua sugerindo, mas declara as duas linhas", () => {
  // Leitura certa: "quando vem em embalagem, a embalagem tem 12" -- nao "este produto vale 12"
  const resultado = derivarSugestao([linha(12, 8), linha(1, 3)]);
  assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
  assert.equal(resultado.fator, 12);
  assert.equal(resultado.tambemAvulso, 3);
});

test("RED BULL SIX PACK: duas embalagens legitimas viram escolha humana, sem eleger nenhuma", () => {
  // Caso real: x6 comprado em caixa e x4 em display. Os dois estao certos.
  const resultado = derivarSugestao([
    linha(6, 11, "RED BULL BR LATA 250ML SIX PACK"),
    linha(4, 4, "RED BULL BR LATA 250ML SIX PACK")
  ]);
  assert.equal(resultado.situacao, SITUACAO.CONFLITO_EMBALAGEM);
  assert.equal(resultado.fator, null, "nenhuma opcao pode ser eleita pelo sistema");
  assert.deepEqual(
    resultado.opcoes.map((o) => o.fator),
    [6, 4]
  );
  assert.equal(ehPendenciaDeCadastro(resultado.situacao), false);
});

test("BATATA INGLESA: frequencia esmagadora NAO desempata embalagem", () => {
  // Caso real: x25 em 28 notas (saco) e x20 em 1 (caixa). Trinta notas de um formato nao
  // provam que o outro deixou de existir -- e o de menos notas pode ser justamente o atual.
  const resultado = derivarSugestao([
    linha(25, 28, "BATATA INGLESA 25 KG"),
    linha(20, 1, "BATATA INGLESA 25 KG")
  ]);
  assert.equal(resultado.situacao, SITUACAO.CONFLITO_EMBALAGEM);
  assert.equal(resultado.fator, null);
  assert.equal(resultado.opcoes.length, 2);
});

test("BALAS: dispersao alta e cadastro generico, nao conflito de fator", () => {
  // Caso real: x120, x118, x100, x135, x125 no mesmo codigo. Nao existe embalagem que explique
  // isso -- e um cadastro guarda-chuva servindo produtos diferentes a cada compra. Forcar um
  // fator aqui so carimba o problema; o lugar disso e a fila de correcao de cadastro.
  const resultado = derivarSugestao([
    linha(120, 32, "BALAS"),
    linha(118, 15, "BALAS"),
    linha(100, 14, "BALAS"),
    linha(135, 2, "BALAS"),
    linha(125, 1, "BALAS")
  ]);
  assert.equal(resultado.situacao, SITUACAO.CADASTRO_GENERICO);
  assert.equal(resultado.fator, null);
  assert.equal(resultado.exigeConfirmacao, false, "nao entra na fila de conferencia de fator");
  assert.equal(ehPendenciaDeCadastro(resultado.situacao), true);
  assert.equal(resultado.opcoes.length, 5, "a dispersao observada precisa aparecer na tela");
});

test("PIRULITO: tres fatores sem padrao tambem sao cadastro generico", () => {
  const resultado = derivarSugestao([
    linha(50, 5, "PIRULITO"),
    linha(5, 4, "PIRULITO"),
    linha(42, 4, "PIRULITO")
  ]);
  assert.equal(resultado.situacao, SITUACAO.CADASTRO_GENERICO);
});

test("descricao divergente vira aviso, nunca classificacao", () => {
  // Medido contra o historico real: cada fornecedor escreve o nome do mesmo produto de um
  // jeito. Usar isso como criterio jogou COCA COLA ZERO, H2OH, TODDYNHO e a propria BATATA
  // INGLESA na fila de cadastro generico -- varios deles com um unico fator observado.
  const resultado = derivarSugestao([
    linha(12, 11, "CHOC LACTA DP12X28G LAKA"),
    linha(6, 1, "CHOC LACTA LAKA BCO 336GR")
  ]);
  assert.equal(resultado.situacao, SITUACAO.CONFLITO_EMBALAGEM, "continua sendo escolha humana");
  assert.equal(resultado.nomesDivergem, true, "mas quem confere e avisado");
});

test("um unico fator observado NUNCA cai na fila de cadastro generico", () => {
  // Regressao do erro medido: H2OH com x12 em 20 notas, e TODDYNHO com x27 em 1, foram
  // classificados como cadastro generico so porque os fornecedores escreveram o nome
  // diferente. Um so fator nao tem dispersao nenhuma para justificar isso.
  // Uma linha por fator: a tabela de evidencia tem unicidade em (produto, fator), entao
  // "um unico fator observado" e literalmente uma linha so.
  for (const evidencia of [
    [linha(12, 20, "H2OH LIMAO C/GAS PET 500ML")],
    [linha(12, 20, "H2OH LIMAO C/GAS PET 500ML"), linha(1, 3, "H2OH LIMAO GAS 500")],
    [linha(27, 1, "TODDYNHO 200ML")]
  ]) {
    const resultado = derivarSugestao(evidencia);
    assert.equal(resultado.situacao, SITUACAO.SUGERIDO);
    assert.equal(ehPendenciaDeCadastro(resultado.situacao), false);
  }
});

test("BATATA INGLESA continua sendo conflito de embalagem, nao cadastro generico", () => {
  // Caso real medido: x25 em saco (30 notas) e x20 em caixa (1). Sao duas embalagens
  // legitimas do mesmo produto -- o usuario apontou isso explicitamente.
  const resultado = derivarSugestao([
    linha(25, 30, "M.P - BATATA INGLESA"),
    linha(20, 1, "BATATA INGLESA 25 KG")
  ]);
  assert.equal(resultado.situacao, SITUACAO.CONFLITO_EMBALAGEM);
  assert.equal(ehPendenciaDeCadastro(resultado.situacao), false);
});

test("unidade igual dos dois lados e sinalizada, mas nao descarta a evidencia", () => {
  assert.equal(unidadeSuspeita("UN", "UN"), true);
  assert.equal(unidadeSuspeita("un", " UN "), true);
  assert.equal(unidadeSuspeita("CX", "UN"), false);
  assert.equal(unidadeSuspeita("", "UN"), false);
  assert.equal(unidadeSuspeita("CX", ""), false);
});

test("1 UN -> 12 UN e reconhecido como fator 12, apesar do rotulo igual", () => {
  // Quem digitou usou "UN" para o display. E proibido validar ou descartar evidencia pelo
  // texto da unidade: so a razao entre as quantidades vale.
  const item = {
    itensCabec: {
      nIdProduto: 555,
      cDescricaoProduto: "CHOC LACTA DP12X28G",
      nQtdeNFe: 1,
      cUnidadeNfe: "UN"
    },
    itensAjustes: { nQtdeRecebida: 12, cUnidade: "UN" }
  };
  const lido = lerEvidenciaDoItem(item, { cNumeroNFe: "000355709", dEmissaoNFe: "04/04/2025" });
  assert.equal(lido.fator, 12, "a evidencia nao pode ser descartada pelo rotulo igual");
  assert.equal(lido.documento.unidade_suspeita, true, "mas quem conferir precisa ser avisado");
});

test("o item de recebimento e lido pelo id do produto, nunca pelo EAN", () => {
  const item = {
    itensCabec: {
      nIdProduto: 10792612974,
      cEAN: "17894904084224",
      cDescricaoProduto: "LIMP MULTIUSO AZULIM 500ML",
      nQtdeNFe: 2,
      cUnidadeNfe: "CX",
      nPrecoUnit: 26.9
    },
    itensAjustes: { nQtdeRecebida: 24, cUnidade: "1UN" }
  };
  const cabecalho = {
    cNumeroNFe: "000607658",
    dEmissaoNFe: "19/03/2025",
    cNome: "NOVA AMAZONAS"
  };

  const lido = lerEvidenciaDoItem(item, cabecalho);
  assert.equal(lido.externalProductId, "10792612974");
  assert.equal(lido.fator, 12);
  assert.equal(lido.data, "2025-03-19");
  assert.equal(lido.documento.nota, "000607658");
  assert.equal(lido.documento.fornecedor, "NOVA AMAZONAS");
  assert.equal(lido.documento.unidade_suspeita, false);
});

test("item sem id de produto e descartado em vez de casado pelo EAN", () => {
  // O EAN da nota casou com 12 de 147 produtos no historico real: vem vazio com frequencia
  // e, quando vem, costuma ser o da embalagem do fornecedor, nao o da unidade do PDV.
  const item = {
    itensCabec: { cEAN: "7894900531008", nQtdeNFe: 2, cUnidadeNfe: "CX" },
    itensAjustes: { nQtdeRecebida: 24, cUnidade: "UN" }
  };
  assert.equal(lerEvidenciaDoItem(item, {}), null);
});

test("item cuja razao nao e fator valido nao vira evidencia", () => {
  const item = {
    itensCabec: { nIdProduto: 123, nQtdeNFe: 3, cUnidadeNfe: "CX" },
    itensAjustes: { nQtdeRecebida: 10, cUnidade: "KG" }
  };
  assert.equal(lerEvidenciaDoItem(item, {}), null);
});

test("nenhuma sugestao nasce de semelhanca de nome", () => {
  // Dois produtos da mesma familia, um com evidencia e outro sem. O sem evidencia continua
  // sem sugestao -- e este teste existe para que ninguem "melhore" isso depois.
  const comEvidencia = derivarSugestao([linha(12, 9)]);
  const semEvidencia = derivarSugestao([]);
  assert.equal(comEvidencia.situacao, SITUACAO.SUGERIDO);
  assert.equal(semEvidencia.situacao, SITUACAO.SEM_EVIDENCIA);
  assert.equal(semEvidencia.fator, null);
});

test("todo fator MAIOR QUE 1 exige confirmacao humana", () => {
  // Nenhum caminho da derivacao pode produzir um fator gravavel sem alguem olhar.
  for (const evidencia of [[linha(12, 30)], [linha(15, 1)], [linha(6, 2)]]) {
    const resultado = derivarSugestao(evidencia);
    assert.equal(resultado.exigeConfirmacao, true, `${resultado.situacao} deveria exigir confirmacao`);
  }
});

test("fator 1 sai da fila de conferencia, venha de onde vier", () => {
  // Produto sem a caracteristica no ERP ja e lido como unitario, entao confirmar e gravar "1"
  // seria trabalho humano e ruido no cadastro para nao mudar comportamento nenhum.
  for (const evidencia of [[linha(1, 25)], [linha(1, 1)], []]) {
    const r = derivarSugestao(evidencia);
    if (r.fator === 1) {
      assert.equal(r.exigeConfirmacao, false);
      assert.equal(r.nadaAConfigurar, true);
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const rotas = fs.readFileSync("server/modules/inventarios/inventarios.routes.js", "utf8");
const index = fs.readFileSync("server/index.js", "utf8");

test("as rotas de inventário estão registradas no servidor", () => {
  assert.match(index, /import \{ handleInventariosRoutes \}/);
  assert.match(index, /await handleInventariosRoutes\(req, res, \{ method, requireUser, url, user \}\)/);
});

test("toda rota de inventário do PDV exige papel de PDV", () => {
  // Sem isso, o Almoxarifado (ou qualquer sessão) alcançaria a contagem de um PDV qualquer.
  const guardas = [...rotas.matchAll(/requireUser\(req, res, "(\w+)"\)/g)].map((m) => m[1]);
  assert.ok(guardas.length >= 4, `esperava uma guarda por rota, achei ${guardas.length}`);
  assert.ok(guardas.every((papel) => papel === "pdv"), `todas precisam exigir pdv: ${guardas.join(", ")}`);
});

test("o catálogo do inventário usa a MESMA regra de liberação do pedido", () => {
  // Se o inventário usasse outro critério, o PDV contaria um catálogo diferente do que pede.
  assert.match(rotas, /JOIN pdv_categorias pc ON pc\.pdv_id = e\.pdv_id AND pc\.categoria = prc\.categoria/);
  assert.match(rotas, /e\.permitido = TRUE AND p\.ativo = TRUE/);
});

test("a contagem é sempre em unidade — não há conversão de embalagem", () => {
  // Decisão do usuário: o PDV conta o que está na prateleira, uma a uma. Diferente do
  // pedido, que oferece embalagem. Nenhum fator pode entrar nesse caminho.
  assert.doesNotMatch(rotas, /converterQuantidadeDoPedido/, "o inventário não converte embalagem");
  assert.doesNotMatch(rotas, /fator_conversao/, "o fator não deve nem ser carregado na tela de contagem");
});

test("unidade diferente de UNIDADE é recusada, nunca ignorada em silêncio", () => {
  // Ignorar faria uma tela desatualizada mandando "EMBALAGEM" gravar 2 onde havia 30.
  const corpo = rotas.slice(rotas.indexOf("function quantidadeContadaEmUnidades"));
  assert.match(corpo, /String\(unidadeMedida\)\.toUpperCase\(\) !== "UNIDADE"/);
  assert.match(corpo, /A contagem de inventário é sempre em unidades/);
  // A recusa vem antes de qualquer leitura da quantidade
  const posRecusa = corpo.indexOf('!== "UNIDADE"');
  const posQuantidade = corpo.indexOf("const numero = Number(quantidade)");
  assert.ok(posRecusa < posQuantidade, "a unidade precisa ser validada antes do número");
});

test("branco e zero são valores diferentes ao gravar", () => {
  // quantidade ausente vira NULL ("não contado"); zero digitado vira 0 ("contado como zero").
  const corpo = rotas.slice(rotas.indexOf("function quantidadeContadaEmUnidades"));
  assert.match(corpo, /if \(quantidade === null \|\| quantidade === undefined \|\| quantidade === ""\) return null;/);
  // Zero passa pela validação numérica e volta como 0, não como null
  assert.doesNotMatch(corpo, /!numero\b/, "não pode usar teste de veracidade: 0 é falsy e viraria 'não contado'");
});

test("apagar a quantidade apaga também o carimbo de data", () => {
  // Data de contagem sem quantidade seria registro de uma contagem desfeita.
  assert.match(rotas, /CASE WHEN \$3::numeric IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END/);
});

test("a data da contagem é do servidor, nunca do cliente", () => {
  // O requisito é data automática e não editável; aceitar data do corpo furaria isso.
  assert.doesNotMatch(rotas, /contado_em.*(corpo|item)\?\./, "contado_em não pode vir do corpo da requisição");
  assert.match(rotas, /contado_em = EXCLUDED\.contado_em/);
});

test("a contagem é travada com FOR UPDATE e confere o dono", () => {
  const corpo = rotas.slice(rotas.indexOf("async function travarInventarioDoPdv"));
  assert.match(corpo, /COALESCE\(pdv_id, -1\) = COALESCE\(\$2, -1\)/, "precisa confirmar o dono");
  assert.match(corpo, /FOR UPDATE/, "duas abas do mesmo PDV podem salvar ao mesmo tempo");
});

test("depois de enviado o PDV não edita mais, e a trava é do servidor", () => {
  assert.match(rotas, /function exigirEmContagem/);
  assert.match(rotas, /Esta contagem já foi enviada e não pode mais ser alterada pelo PDV/);
  // A checagem roda antes de qualquer escrita nas duas rotas que alteram
  for (const rota of ["/api/pdv/inventario\" && method === \"PATCH", "/api/pdv/inventario/enviar"]) {
    const inicio = rotas.indexOf(rota);
    const trecho = rotas.slice(inicio, inicio + 2500);
    const posGuarda = trecho.indexOf("exigirEmContagem");
    const posEscrita = Math.min(
      ...["INSERT INTO inventario_itens", "UPDATE inventarios SET status"]
        .map((sql) => trecho.indexOf(sql))
        .filter((pos) => pos > -1)
        .concat([Number.MAX_SAFE_INTEGER])
    );
    assert.ok(posGuarda > -1, `a rota ${rota} precisa checar o status`);
    assert.ok(posGuarda < posEscrita, `a checagem precisa vir antes da escrita em ${rota}`);
  }
});

test("fora da janela, abrir e editar contagem são recusados com 423", () => {
  const bloqueios = [...rotas.matchAll(/if \(!janela\.liberado\) \{\s*\n\s*send\(res, 423/g)];
  assert.equal(bloqueios.length, 2, "abrir e editar precisam respeitar a janela");
});

test("o envio exige ao menos um produto contado", () => {
  assert.match(rotas, /Conte ao menos um produto antes de enviar/);
});

test("o resumo conta o catálogo liberado, não só as linhas já gravadas", () => {
  // "Sem contagem" é o que o PDV podia contar e não contou. Contar só inventario_itens
  // mostraria zero pendências para quem nem abriu a maior parte da lista.
  const corpo = rotas.slice(rotas.indexOf("async function resumoDaContagem"));
  assert.match(corpo, /COUNT\(DISTINCT p\.sku\)::int/);
  assert.match(corpo, /quantidade_contada IS NOT NULL/);
});

test("abrir duas vezes reaproveita em vez de duplicar, e o índice é a última defesa", () => {
  assert.match(rotas, /if \(jaAberto\) return \{ inventario: jaAberto, reaproveitado: true \}/);
  assert.match(rotas, /if \(error\.code === "23505"\)/);
});

test("as ações do inventário ficam na auditoria", () => {
  assert.match(rotas, /acao: "inventario_aberto"/);
  assert.match(rotas, /acao: "inventario_enviado"/);
});

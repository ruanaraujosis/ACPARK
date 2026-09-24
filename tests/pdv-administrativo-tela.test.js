import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (caminho) =>
  fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");
const semComentarios = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const app = ler("public/app.js");
const css = ler("public/styles.css");
const index = ler("server/index.js");
const rotas = ler(
  "server/modules/pdv-administrativo/pdv-administrativo.routes.js",
);
const operacoes = ler(
  "server/services/integrations/providers/omie/omie.operacoes.js",
);
const tarefa = ler(
  "server/services/integrations/providers/omie/tarefas/consumo-administrativo.js",
);
const pedidos = ler("server/modules/pedidos/pedidos.routes.js");

// ===== Tela de cadastro: a tag =====

test("os dois formulários de PDV têm o campo do perfil", () => {
  const view = app.slice(app.indexOf("async function viewConfigV2"));
  assert.match(view, /const campoPdvAdministrativo = \(marcado\) =>/);
  assert.match(
    view,
    // Desde 23/09/2026 o "Local de estoque padrão" fica entre o perfil e as categorias
    /\$\{campoPdvAdministrativo\(false\)\}\s*\n\s*<label class="grid gap-1 text-sm font-bold">Local de estoque padrão[\s\S]*?<\/label>\s*\n\s*\$\{categorySelect\("edit-pdv-category"\)\}/,
  );
  assert.match(
    view,
    /\$\{campoPdvAdministrativo\(false\)\}\s*\n\s*\$\{categorySelect\("create-pdv-category"\)\}/,
  );
});

test("a tag só é editável pelo Almoxarifado", () => {
  // O campo mora dentro da view de configuração, que é do admin. Nenhuma tela do PDV envia
  // `administrativo` — se enviasse, ele mudaria o próprio perfil.
  const telasDoPdv = app.slice(
    app.indexOf("async function viewOrder"),
    app.indexOf("async function viewDamagesAdmin"),
  );
  assert.doesNotMatch(semComentarios(telasDoPdv), /name="administrativo"/);
  // E no servidor, a rota que grava o campo exige admin
  const rotaPdvs = index.slice(
    index.indexOf('url.pathname === "/api/admin/pdvs"'),
  );
  assert.match(rotaPdvs.slice(0, 200), /requireUser\(req, res, "admin"\)/);
});

test("checkbox desmarcado precisa virar false explícito", () => {
  // FormData omite checkbox não marcado: sem esta leitura o perfil nunca seria desligado.
  const ocorrencias =
    app.match(
      /form\.administrativo = formData\.get\("administrativo"\) === "on";/g,
    ) || [];
  assert.equal(ocorrencias.length, 2, "criar e editar precisam dos dois");
});

test("editar um PDV carrega o perfil atual, não o do PDV anterior", () => {
  // A quebra de linha é do Prettier; o que importa é a leitura vir do mapa, não do objeto.
  assert.match(
    app,
    /pdvEditForm\.querySelector\('\[name="administrativo"\]'\)\.checked =\s*perfilPorPdv\.get\(String\(pdv\.id\)\) === true;/,
  );
});

test("o perfil vem da rota admin, nunca do /api/bootstrap", () => {
  // Ler `administrativo` no bootstrap derrubou o login de todo mundo em 29/08/2026. A rota
  // tem comentário proibindo, e este teste impede a reintrodução por descuido.
  const bootstrap = index.slice(
    index.indexOf('url.pathname === "/api/bootstrap"'),
    index.indexOf("// Delega para os roteadores"),
  );
  assert.doesNotMatch(
    semComentarios(bootstrap),
    /p\.administrativo/,
    "o bootstrap não pode selecionar a coluna",
  );
  assert.match(
    app,
    /await request\("\/api\/admin\/pdvs", \{ silentLoading: true \}\)/,
  );
});

test("a lista de PDVs mostra o perfil de cada um", () => {
  assert.match(app, /\["PDV", "Perfil", "Categorias", "Ações"\]/);
  assert.match(app, /pdv-perfil-chip is-admin/);
});

test("o CSS do campo, do rótulo e do painel existe", () => {
  assert.match(css, /\.pdv-admin-toggle \{/);
  assert.match(css, /\.pdv-perfil-chip\.is-admin \{/);
  assert.match(css, /\.painel-adm-ranking-linha \{/);
});

// ===== Portão 2: saldo residual =====

test("alternar um PDV COM saldo é recusado, com o caminho de saída na mensagem", () => {
  const rotaPdvs = index.slice(
    index.indexOf('url.pathname === "/api/admin/pdvs"'),
  );
  assert.match(rotaPdvs, /if \(administrativo && !eraAdministrativo\)/);
  assert.match(
    rotaPdvs,
    /FROM estoque_pdv WHERE pdv_id = \$1 AND quantidade > 0/,
  );
  assert.match(rotaPdvs, /send\(res, 409, \{/);
  assert.match(
    rotaPdvs,
    /zere o estoque por inventário antes de trocar o perfil/,
  );
});

test("a recusa aparece em diálogo, não em toast que some", () => {
  const bloco = app.slice(app.indexOf("pdvEditForm.addEventListener"));
  assert.match(bloco, /if \(erro\?\.status === 409\)/);
  assert.match(bloco, /title: "Troca de perfil bloqueada"/);
  assert.match(bloco, /throw erro;/, "erro que não for 409 continua subindo");
});

// ===== Painel do setor =====

test("o menu do administrativo não tem tela de saldo", () => {
  // Para este perfil saldo é AUSÊNCIA, não zero: mostrar uma lista de zeros mentiria.
  assert.match(app, /state\.pdvAdministrativo/);
  const inicio = app.indexOf('["painel", "Painel do setor"]');
  assert.ok(inicio > -1, "o menu do administrativo precisa existir");
  const menuAdm = app.slice(inicio, app.indexOf("damage-return", inicio));
  assert.doesNotMatch(
    menuAdm,
    /my-stock/,
    "'Meu estoque' não pode aparecer para o administrativo",
  );
});

test("a tela de saldo desvia o administrativo mesmo se acessada direto", () => {
  const inicio = app.indexOf("async function viewMyStock");
  const bloco = app.slice(inicio, inicio + 700);
  const posGuarda = bloco.indexOf(
    'if (state.pdvAdministrativo) return route("painel")',
  );
  const posRequest = bloco.indexOf("request(");
  assert.ok(posGuarda > -1, "a guarda precisa existir");
  assert.ok(posGuarda < posRequest, "e vir antes de buscar o saldo");
});

test("o painel é exclusivo do perfil e não devolve saldo", () => {
  assert.match(rotas, /Este painel é exclusivo de PDV Administrativo/);
  assert.match(rotas, /send\(res, 403/);
  assert.doesNotMatch(
    semComentarios(rotas),
    /estoque_pdv|qtd_total/,
    "nenhuma consulta de saldo no painel",
  );
});

test("o ranking usa o que foi liberado, não o que foi pedido", () => {
  // Pedir não é consumir: um pedido cortado pela metade consumiu a metade.
  assert.match(
    rotas,
    /SUM\(COALESCE\(p\.quantidade_liberada, 0\)\)::int AS total_liberado/,
  );
  assert.match(rotas, /ORDER BY total_liberado DESC/);
  assert.match(app, /Pela quantidade efetivamente liberada/);
});

test("o filtro pega o dia final inteiro", () => {
  // Sem o `+ 1 day`, um pedido feito às 14h do último dia ficaria de fora.
  assert.match(rotas, /p\.data_hora < \(\$3::date \+ INTERVAL '1 day'\)/);
  assert.match(rotas, /A data inicial não pode ser depois da data final/);
});

// ===== Portão 1: saída na OMIE =====

test("a saída por consumo é SAI, nunca TRF", () => {
  assert.match(operacoes, /export function montarSaidaConsumoAdministrativo/);
  const bloco = operacoes.slice(
    operacoes.indexOf("export function montarSaidaConsumoAdministrativo"),
  );
  assert.match(bloco, /tipo: "SAI"/);
  assert.doesNotMatch(
    semComentarios(bloco),
    /"TRF"/,
    "transferência diria que a mercadoria continua na empresa",
  );
  assert.doesNotMatch(
    semComentarios(bloco),
    /codigo_local_estoque_destino/,
    "consumo não tem destino",
  );
});

test("o motivo confirmado é PDV, um dos quatro valores reais do domínio SAI da OMIE", () => {
  // Nenhum dos quatro (INV, PER, OPS, PDV) significa literalmente "consumo interno" -- o
  // usuário escolheu PDV em 01/09/2026 sabendo disso (categorização fiscal é decisão dele).
  assert.match(
    operacoes,
    /export const MOTIVO_CONSUMO_ADMINISTRATIVO = "PDV";/,
  );
  // O sentinela antigo não pode sobreviver em nenhuma forma -- reintroduzi-lo bloquearia
  // o envio de novo sem ninguém perceber.
  assert.doesNotMatch(operacoes, /__MOTIVO_PENDENTE__/);
});

test("a observação de cada lançamento deixa explícito que é consumo administrativo, já que o motivo (PDV) não diz isso sozinho", () => {
  assert.match(
    tarefa,
    /OBSERVACAO_CONSUMO_ADMINISTRATIVO =\s*\n?\s*"SAIDA PARA USO DE SETORES COMO ESCRITORIO, ACPASS e LIMPEZA\."/,
  );
  assert.match(
    tarefa,
    /observacao: `Consumo interno do pedido \$\{lancamento\.codigo_pedido\} \(PDV Administrativo\) no MyEstoque\. \$\{OBSERVACAO_CONSUMO_ADMINISTRATIVO\}`/,
  );
});

test("a tarefa não tem mais trava própria -- segue a mesma trava genérica das outras (modo REAL)", () => {
  // Motivo definido: a única trava que resta é a do núcleo, igual transferências e inventário.
  assert.doesNotMatch(tarefa, /motivoIndefinido/);
  assert.doesNotMatch(tarefa, /bloqueado_por_motivo_pendente/);
  assert.match(tarefa, /const simulacao = emSimulacao\(configuracao\);/);
});

test("o envio real usa o mesmo endpoint/chamada da transferência (IncluirAjusteEstoque)", () => {
  // Consumo administrativo também é um ajuste de estoque (tipo SAI) -- mesma API, tipo diferente.
  assert.match(tarefa, /const CALL = "IncluirAjusteEstoque";/);
  assert.match(tarefa, /endpoint: ENDPOINTS\.AJUSTE,/);
  assert.match(tarefa, /call: CALL,/);
});

test("bloqueio por limite de taxa para o lote inteiro, igual a transferência", () => {
  // Mesmo incidente que já custou caro na transferência (29/08/2026): continuar batendo
  // numa API que acabou de recusar por consumo renova a punição em vez de esperar.
  assert.match(tarefa, /if \(ehLimiteDeTaxa\(erro\)\) \{/);
  assert.match(tarefa, /await pausarIntegracao\(client, integracao\.id/);
  assert.match(tarefa, /return resumo;/);
});

test("a tarefa filtra o próprio evento, para não brigar com as outras", () => {
  // Sem o filtro ela leria transferências e inventários e os marcaria como ERRO.
  assert.match(
    tarefa,
    /eventos: \[lancamentos\.EVENTOS\.CONSUMO_ADMINISTRATIVO\]/,
  );
  const transferencias = ler(
    "server/services/integrations/providers/omie/tarefas/transferencias.js",
  );
  assert.match(
    transferencias,
    /eventos: \[lancamentos\.EVENTOS\.RETIRADA, lancamentos\.EVENTOS\.COMPENSACAO\]/,
  );
});

test("a retirada do administrativo enfileira consumo, nunca transferência", () => {
  const bloco = pedidos.slice(
    pedidos.indexOf("const itensDeRevenda"),
    pedidos.indexOf("const finalized"),
  );
  assert.match(
    bloco,
    /const itensDeRevenda = targetRows\.filter\(\(row\) => !administrativos\.has\(row\.pdv_id\)\)/,
  );
  assert.match(bloco, /registrarConsumoAdministrativo\(client, \{/);
  // E a retirada nunca é bloqueada pela integração
  assert.match(
    ler("server/services/integrations/core/stock-launches.service.js"),
    /Falha ao registrar o consumo administrativo/,
  );
});

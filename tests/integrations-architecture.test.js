import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Testes de arquitetura: travam as regras que fazem a Central de Integracoes continuar
// extensivel. Se algum falhar, alguem acoplou o nucleo a uma API especifica -- e a partir
// dai ligar uma API nova volta a exigir mexer em rota, fila, agendador e tela.

const RAIZ = "server/services/integrations";
const NUCLEO = path.join(RAIZ, "core");
const PROVIDERS = path.join(RAIZ, "providers");

function listarArquivos(diretorio) {
  const saida = [];
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    const completo = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) saida.push(...listarArquivos(completo));
    else if (entrada.name.endsWith(".js")) saida.push(completo);
  }
  return saida;
}

const ler = (arquivo) => fs.readFileSync(arquivo, "utf8");

// Remove comentarios antes de checar acoplamento. Comentario que explica por que uma
// regra existe (citando o bug antigo, inclusive pelo nome) e documentacao util e nao pode
// derrubar o teste -- o que importa e o codigo que roda.
function semComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("as arvores antigas de integracao foram removidas de vez", () => {
  // Existiam duas implementacoes paralelas: leitura em services/integrations/omie e
  // escrita em services/omie, mais um roteador proprio em modules/omie. Manter qualquer
  // uma delas por perto e convite para o codigo voltar a se dividir.
  for (const caminho of [
    "server/services/integrations/omie",
    "server/services/omie",
    "server/modules/omie",
    "server/services/integrations/integration.service.js"
  ]) {
    assert.equal(fs.existsSync(caminho), false, `${caminho} deveria ter sido removido`);
  }
});

test("o nucleo nao conhece nenhum provider especifico", () => {
  for (const arquivo of listarArquivos(NUCLEO)) {
    const src = semComentarios(ler(arquivo));
    assert.doesNotMatch(src, /providers\//, `${arquivo} importa a pasta de providers`);
    assert.doesNotMatch(
      src,
      /\bOMIE\b|app_key|app_secret|omie\./i,
      `${arquivo} menciona uma API especifica; o nucleo tem de ser agnostico`
    );
  }
});

test("um provider nunca importa outro provider", () => {
  for (const arquivo of listarArquivos(PROVIDERS)) {
    const relativo = path.relative(PROVIDERS, arquivo).replace(/\\/g, "/");
    const pasta = relativo.split("/")[0];
    if (!relativo.includes("/")) continue; // o index.js do registro pode importar todos
    for (const outro of ["omie"]) {
      if (outro === pasta) continue;
      assert.doesNotMatch(ler(arquivo), new RegExp(`providers/${outro}`), `${arquivo} importa o provider ${outro}`);
    }
  }
});

test("as rotas de integracao nao tratam nenhuma API como caso especial", () => {
  const src = ler("server/modules/integrations/integrations.routes.js");
  // Nome de tabela especifica de provider ainda aparece (omie_stock_locations), mas
  // nenhuma decisao de fluxo pode depender do provedor ser OMIE
  assert.doesNotMatch(src, /provedor\s*===\s*["']OMIE["']/, "rota nao pode ramificar por provedor");
  assert.doesNotMatch(src, /ListarProdutos|app_secret/, "rota nao pode conhecer chamada nem credencial de API");
  // A validacao de operacao passa pelo registro, nunca por lista fixa
  assert.match(src, /exigirCapacidade/);
  assert.match(src, /catalogoPublico/);
});

test("o servidor sobe o agendador generico, nao um agendador de OMIE", () => {
  const src = ler("server/index.js");
  assert.match(src, /core\/scheduler\.js/);
  assert.match(src, /iniciarAgendador\(\)/);
  assert.doesNotMatch(src, /startOmieScheduler|runOmieSchedulerTick|handleOmieRoutes/);
});

test("a tela de integracoes se monta a partir do catalogo, sem lista fixa de provedores", () => {
  const src = ler("public/app.js");
  assert.match(src, /\/api\/admin\/integrations\/providers/, "a tela precisa ler o catalogo de providers");
  // O <select> de provedor e as operacoes vem do catalogo; nao pode haver option fixa
  assert.doesNotMatch(src, /<option value="OMIE"/, "o provedor nao pode estar fixo no HTML");
  assert.doesNotMatch(
    src,
    /<option value="PRODUTOS">|<option value="MOVIMENTOS">/,
    "as operacoes tem de vir do catalogo, nao de uma lista escrita na tela"
  );
  assert.match(src, /providers\.map\(\(provider\)/, "o seletor de provedor e gerado do catalogo");
});

test("credenciais gravadas sao apenas as que o provider declara", () => {
  const src = ler("server/modules/integrations/integrations.routes.js");
  assert.match(
    src,
    /for \(const credencial of provider\.credenciais \|\| \[\]\)/,
    "a rota precisa iterar as credenciais declaradas, nunca gravar campo arbitrario do corpo"
  );
});

test("todo provider registrado tem manifesto completo e handlers distintos", async () => {
  const { listarProviders } = await import("../server/services/integrations/core/provider-registry.js");
  await import("../server/services/integrations/providers/index.js");

  const providers = listarProviders();
  assert.ok(providers.length >= 1, "nenhum provider registrado");

  for (const provider of providers) {
    assert.ok(provider.rotulo, `${provider.id} sem rotulo`);
    assert.ok(provider.urlBasePadrao, `${provider.id} sem url base padrao`);
    assert.ok(provider.credenciais?.length, `${provider.id} sem credenciais declaradas`);

    const ids = provider.capacidades.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `${provider.id} tem capacidade com id repetido`);

    // Duas capacidades apontando para o mesmo handler foi como o sistema antigo acabou
    // executando so produtos: todo escopo caia no mesmo caminho de codigo.
    const handlers = provider.capacidades.map((c) => c.executar);
    assert.equal(
      new Set(handlers).size,
      handlers.length,
      `${provider.id} reaproveita o mesmo handler em capacidades diferentes`
    );
  }
});

test("a fila grava o id da capacidade literalmente, sem normalizar escopo", () => {
  const src = semComentarios(ler(path.join(NUCLEO, "job.queue.js")));
  // normalizeSyncScope traduzia SYNC_OMIE_PRODUCTS/STOCK/MOVEMENTS todos para SYNC_OMIE_FULL,
  // e por isso saldos, locais e movimentos nunca rodaram
  assert.doesNotMatch(src, /normalizeSyncScope|normalizarEscopo|SYNC_OMIE_FULL/);
  assert.match(src, /const tipo = String\(capacidade\)\.toUpperCase\(\);/);
});

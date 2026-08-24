import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Testes de regressao de seguranca: cada um trava uma correcao concreta aplicada depois de uma
// auditoria. Se algum falhar, e regressao de seguranca -- nao ajuste o teste sem entender o motivo.
const indexSrc = fs.readFileSync("server/index.js", "utf8");
const avariasSrc = fs.readFileSync("server/modules/avarias/avarias.routes.js", "utf8");
const backupSrc = fs.readFileSync("server/services/backup/backup.service.js", "utf8");
const integracaoSrc = fs.readFileSync("server/services/integrations/core/integration.security.js", "utf8");
const gitignore = fs.readFileSync(".gitignore", "utf8");

test("upload de fotos tem teto de tamanho e nao acumula o corpo sem limite", () => {
  // Sem teto, um POST grande derrubava por falta de memoria o servico que atende todos os PDVs
  assert.match(avariasSrc, /function readRawBody/);
  assert.match(avariasSrc, /total > limite/, "readRawBody precisa abortar ao passar do teto");
  assert.match(avariasSrc, /req\.destroy\(\)/, "a conexao precisa ser cortada, nao so o erro lancado");
  assert.match(avariasSrc, /statusCode = 413/);
  assert.match(avariasSrc, /maxImageBytes/, "o teto deve derivar do limite configurado de imagem");
});

test("/api/health nao devolve o erro do driver do banco (rota sem autenticacao)", () => {
  const trecho = indexSrc.slice(indexSrc.indexOf('"/api/health"'), indexSrc.indexOf('"/api/health"') + 600);
  // O erro do pg traz usuario, host e porta do banco -- nao pode ir para quem esta na rede
  assert.doesNotMatch(trecho, /error:\s*error\.message/, "erro do driver nao pode ir na resposta");
  assert.match(trecho, /console\.error/, "o detalhe deve ir para o log do servidor");
});

test("nomes vindos de arquivo de backup nao entram crus em SQL", () => {
  assert.match(backupSrc, /escapeIdentifier/);
  assert.doesNotMatch(backupSrc, /ALTER TABLE public\.\$\{t\.tablename\}\s/, "tablename cru vira SQLi");
  assert.doesNotMatch(backupSrc, /ALTER SEQUENCE public\.\$\{s\.sequencename\}\s/, "sequencename cru vira SQLi");
});

test("resolverCaminhoBackup nao aceita caminho absoluto do servidor", () => {
  // Aceitar caminho absoluto daria a quem tem sessao de admin acesso ao filesystem do host
  assert.doesNotMatch(backupSrc, /if \(path\.isAbsolute\(caminhoOuNome\)\) return caminhoOuNome/);
  assert.match(backupSrc, /path\.relative\(pastaBackups, resolvido\)/);
  assert.match(backupSrc, /relativo\.startsWith\("\.\."\)/);
});

test("a chave de criptografia das credenciais OMIE nao tem fallback fixo", () => {
  // O fallback antigo era uma string fixa neste arquivo, que esta num repositorio publico.
  // Ignora comentarios: o que importa e o codigo executavel, nao a explicacao historica.
  const codigo = integracaoSrc
    .split("\n")
    .filter((linha) => !linha.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(codigo, /String\(raw \|\| ["']/, "fallback fixo reintroduzido no derivar da chave");
  assert.doesNotMatch(codigo, /INTEGRATION_ENCRYPTION_KEY \|\| env\.JWT_SECRET/, "nao pode cair no JWT_SECRET");
  assert.match(codigo, /Configure INTEGRATION_ENCRYPTION_KEY/);
});

test("o .gitignore cobre tudo que contem dado real ou segredo", () => {
  for (const padrao of ["backups/", ".storage/", "logs_rascunhos/", ".claude/settings.local.json", "*.dump"]) {
    assert.ok(gitignore.includes(padrao), `.gitignore deveria conter ${padrao}`);
  }
  // O dump de estrutura (schema-only, sem dados) e a excecao proposital a regra *.dump
  assert.match(gitignore, /!db\/estrutura\.dump/);
  assert.match(gitignore, /^\.env\*/m, "todas as variantes de .env precisam ficar fora do Git");
});

test("nenhuma rota administrativa ficou sem gate de admin", () => {
  const arquivos = [
    "server/modules/pedidos/pedidos.routes.js",
    "server/modules/estoque/estoque.routes.js",
    "server/modules/avarias/avarias.routes.js",
    "server/modules/backup/backup.routes.js",
    "server/modules/integrations/integrations.routes.js"
  ];
  for (const arquivo of arquivos) {
    const src = fs.readFileSync(arquivo, "utf8");
    const linhas = src.split("\n");
    for (let i = 0; i < linhas.length; i++) {
      const rota = linhas[i].match(/url\.pathname === "(\/api\/admin\/[^"]+)"/);
      if (!rota) continue;
      // O gate precisa aparecer logo depois da checagem do caminho da rota
      const janela = linhas.slice(i, i + 6).join("\n");
      const temGate = /requireUser\(req, res, "admin"\)/.test(janela)
        || /requireAdmin\(req, res, context\)/.test(janela)
        || /user\.role !== "admin"/.test(janela);
      assert.ok(temGate, `${arquivo}: rota ${rota[1]} (linha ${i + 1}) sem gate de admin visivel`);
    }
  }
});

test("o atalho requireAdmin das integracoes delega mesmo para o gate de admin", () => {
  // O teste acima aceita requireAdmin() como gate valido; aqui se garante que esse atalho
  // nao vira um gate frouxo com o tempo.
  const src = fs.readFileSync("server/modules/integrations/integrations.routes.js", "utf8");
  assert.match(
    src,
    /function requireAdmin\(req, res, context\) \{\s*return context\.requireUser\(req, res, "admin"\);\s*\}/,
    "requireAdmin precisa continuar delegando para requireUser(..., \"admin\")"
  );
});

test("rotas de PDV usam o pdvId da sessao, nunca o enviado pelo cliente", () => {
  const pedidos = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");
  // O padrao correto: admin pode escolher o PDV por query, sessao de PDV e forcada ao proprio id
  assert.match(pedidos, /user\.role === "pdv" \? user\.pdvId :/);
  const estoque = fs.readFileSync("server/modules/estoque/estoque.routes.js", "utf8");
  assert.match(estoque, /user\.role === "pdv" \? user\.pdvId :/);
});

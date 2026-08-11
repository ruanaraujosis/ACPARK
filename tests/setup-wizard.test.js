import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleSetupRoutes } from "../server/modules/setup/setup.routes.js";

const routesSrc = fs.readFileSync("server/modules/setup/setup.routes.js", "utf8");
const authSrc = fs.readFileSync("public/js/modules/auth/auth.js", "utf8");
const setupSrc = fs.readFileSync("public/js/modules/setup/setup.js", "utf8");
const indexSrc = fs.readFileSync("server/index.js", "utf8");

function createResponse() {
  return {
    status: null,
    body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; }
  };
}

test("handleSetupRoutes ignora rotas que não são dele", async () => {
  const res = createResponse();
  const handled = await handleSetupRoutes({}, res, {
    method: "GET",
    url: new URL("http://localhost/api/qualquer-outra-coisa")
  });
  assert.equal(handled, false);
});

test("a checagem de instalação já configurada roda no servidor antes de gravar a senha", () => {
  // A rota de definir senha precisa recusar ANTES de ler o corpo, se já houver senha configurada --
  // senão viraria um jeito de resetar a senha de uma instalação em uso sem autenticação nenhuma.
  const trecho = routesSrc.slice(
    routesSrc.indexOf('"/api/setup/senha-admin"'),
    routesSrc.indexOf('"/api/setup/senha-admin"') + 400
  );
  assert.match(trecho, /if \(await estaConfigurado\(\)\)/);
  const posChecagem = trecho.indexOf("estaConfigurado()");
  const posReadBody = trecho.indexOf("readBody(req)");
  assert.ok(posChecagem < posReadBody, "checagem de instalação configurada deve vir antes de ler o corpo");
});

test("senha_almoxarifado é a única fonte usada para decidir se a instalação é nova", () => {
  assert.match(routesSrc, /SELECT 1 FROM configuracoes WHERE chave = 'senha_almoxarifado'/);
  // Não deveria depender de nenhuma flag extra (setup_concluido etc.) -- ausência da senha já basta
  assert.doesNotMatch(routesSrc, /setup_concluido|onboarding_completo/);
});

test("a senha exige tamanho mínimo e confirmação antes de gravar", () => {
  assert.match(routesSrc, /senha\.length < 4/);
  assert.match(routesSrc, /senha !== confirmarSenha/);
  assert.match(routesSrc, /hashPassword\(senha\)/);
});

test("as rotas de setup são registradas antes do requireUser obrigatório", () => {
  const posSetup = indexSrc.indexOf("handleSetupRoutes(req, res");
  const posRequireUser = indexSrc.indexOf("const user = requireUser(req, res);");
  assert.ok(posSetup > -1 && posRequireUser > -1);
  assert.ok(posSetup < posRequireUser, "rotas de setup precisam ser públicas (antes do gate de sessão)");
});

test("o assistente é a tela inicial quando a instalação precisa ser configurada", () => {
  assert.match(authSrc, /verificarSetupNecessario/);
  assert.match(authSrc, /renderSetupWizard/);
  // A checagem de setup precisa acontecer antes de decidir entre app autenticado e tela de login
  const posSetup = authSrc.indexOf("verificarSetupNecessario()");
  const posAuthMe = authSrc.indexOf('request("/api/auth/me")');
  assert.ok(posSetup < posAuthMe, "checagem de setup deve rodar antes de tentar recuperar a sessão");
});

test("o assistente reaproveita o parser de planilha já existente, sem duplicar lógica", () => {
  assert.match(setupSrc, /import \{ parseProductsFile \} from "\.\.\/\.\.\/utils\/spreadsheets\.js"/);
});

test("a etapa de importar produtos é opcional (tem botão de pular); a de PDV não tem", () => {
  const etapaPdv = setupSrc.slice(setupSrc.indexOf("renderPassoPrimeiroPdv"), setupSrc.indexOf("importarProdutosEmLotes"));
  const etapaImport = setupSrc.slice(setupSrc.indexOf("renderPassoImportarProdutos"), setupSrc.indexOf("renderConclusao"));
  assert.doesNotMatch(etapaPdv, /pular|skip/i);
  assert.match(etapaImport, /Pular esta etapa/);
});

test("depois de definir a senha, o assistente já autentica antes de seguir para o próximo passo", () => {
  const trecho = setupSrc.slice(setupSrc.indexOf("setup-senha-form"), setupSrc.indexOf("renderPassoPrimeiroPdv()") + 30);
  assert.match(trecho, /\/api\/setup\/senha-admin/);
  assert.match(trecho, /\/api\/auth\/login/);
  assert.match(trecho, /profile: "admin"/);
});

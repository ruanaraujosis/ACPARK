import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Travas estáticas da arquitetura do MyControl (não tocam em banco). O comportamento em si é
// provado contra banco descartável em mycontrol-sessao.test.js e mycontrol-usuarios.test.js;
// aqui ficam as decisões que um refactor poderia desfazer sem nenhum teste de rota cair.
const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");
const index = ler("server/index.js");
const sessao = ler("server/services/mycontrol/sessao.js");
const schema = ler("server/services/mycontrol/mycontrol.schema.js");
const runtime = ler("server/services/backup/runtime-schema.service.js");
const htmlMc = ler("public/mycontrol/index.html");
const appMc = ler("public/mycontrol/app.js");
const appEstoque = ler("public/app.js");

test("rotas do MyControl são tratadas antes do portão de sessão e da reposição automática", () => {
  const posMc = index.indexOf("if (ehRotaMyControl(url.pathname))");
  const posPortao = index.indexOf("const user = requireUser(req, res);");
  const posAuto = index.indexOf("await processAutoOrders();");
  assert.ok(posMc > -1 && posPortao > -1 && posAuto > -1);
  assert.ok(posMc < posPortao, "MyControl precisa vir antes do portão genérico do MyEstoque");
  assert.ok(posMc < posAuto, "chamada do MyControl não pode rodar processAutoOrders()");
});

test("o sessionFrom do MyEstoque recusa token do MyControl", () => {
  const trecho = index.slice(index.indexOf("function sessionFrom"), index.indexOf("function requireUser"));
  assert.match(trecho, /ehTokenDoMyControl\(payload\) \? null : payload/);
});

test("o token do MyControl usa segredo derivado, audience própria e só HS256", () => {
  assert.match(sessao, /createHmac\("sha256", String\(jwtSecret\)\)\.update\("mycontrol"\)/);
  assert.match(sessao, /audience: MC_AUDIENCE, algorithms: \["HS256"\]/);
  assert.match(sessao, /export const MC_COOKIE = "mc_session"/);
});

test("requireMcUser consulta o banco a cada requisição (não confia no token)", () => {
  const trecho = sessao.slice(sessao.indexOf("export async function requireMcUser"));
  assert.match(trecho, /await usuarioDaSessaoMc\(req\)/);
  assert.match(sessao, /SELECT id, usuario, nome, permissoes, ativo, senha_alterada_em FROM mc_usuarios WHERE id = \$1/);
  assert.match(trecho, /!usuario\.ativo/);
  // Token anterior à última troca de senha não vale (Fase 2)
  assert.match(sessao, /tokenRevogadoPelaSenha\(token\.emitidoEm, usuario\.senha_alterada_em\)/);
});

test("tabelas mc_ são criadas em runtime, registradas no restore e com datas TIMESTAMPTZ", () => {
  assert.match(runtime, /await ensureMyControlTables\(\);/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mc_usuarios/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS mc_auditoria/);
  assert.doesNotMatch(schema, /TIMESTAMP(?! ?TZ)(?!TZ)[ ,\n]/, "coluna de data nova precisa ser TIMESTAMPTZ");
  // O motivo de ser diferente das tabelas antigas fica escrito junto do código
  assert.match(schema, /DIFERENTE de propósito/);
});

test("assets do MyControl usam uma única versão própria (?v=)", () => {
  const versoes = [...htmlMc.matchAll(/(?:\/styles\.css|\/mycontrol\/[\w.-]+)\?v=([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(versoes.length >= 3, "styles.css, mycontrol.css e app.js precisam ter ?v=");
  assert.equal(new Set(versoes).size, 1, `todas as versões do MyControl precisam ser iguais: ${versoes.join(", ")}`);
  assert.match(htmlMc, /<script type="module" src="\/mycontrol\/app\.js\?v=/);
  // O comentário do próprio index.html diz qual é a versão vigente (ajuda a lembrar de trocar)
  assert.ok(htmlMc.includes(`(${versoes[0]})`), "o comentário do index.html deve citar a versão atual");
  // Módulo compartilhado importado pelo MyControl segue a mesma versão (sem ?v= ficaria 1h em cache)
  assert.ok(appMc.includes(`from "../js/ui/assinatura.js?v=${versoes[0]}"`), "o import da assinatura precisa da versão do MyControl");
});

test("links entre MyEstoque e MyControl abrem na mesma janela", () => {
  // No app desktop, target=_blank iria para o navegador externo (setWindowOpenHandler)
  assert.doesNotMatch(appMc, /target=["']?_blank/);
  // O botão fica no cabeçalho, ao lado das 3 barras (antes do menu-toggle), não dentro do menu
  const cabecalhoMc = appMc.slice(appMc.indexOf('<div class="menu-wrap">'), appMc.indexOf('id="menu-toggle"'));
  assert.match(cabecalhoMc, /<a class="troca-sistema" href="\/" title="Abrir o MyEstoque" aria-label="Abrir o MyEstoque">/);
  const cabecalhoEstoque = appEstoque.slice(appEstoque.indexOf('<div class="menu-wrap">'), appEstoque.indexOf('id="menu-toggle"'));
  // No MyEstoque, só a sessão do Almoxarifado vê o botão
  assert.match(cabecalhoEstoque, /role === "admin" \? `<a class="troca-sistema" href="\/mycontrol" title="Abrir o MyControl" aria-label="Abrir o MyControl">/);
  assert.doesNotMatch(appEstoque, /href="\/mycontrol"[^>]*target=/);
});

test("o front do MyControl reaproveita os módulos compartilhados de public/js", () => {
  assert.match(appMc, /import \{ request \} from "\.\.\/js\/api\/api-client\.js"/);
  assert.match(appMc, /import \{ toast \} from "\.\.\/js\/ui\/notifications\.js"/);
  assert.match(appMc, /import \{ esc, table \} from "\.\.\/js\/ui\.js"/);
});

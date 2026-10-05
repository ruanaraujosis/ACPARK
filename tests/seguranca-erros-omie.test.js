import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Chave fixa só para estes testes cifrarem/decifrarem credencial falsa
process.env.INTEGRATION_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || "chave-de-teste-longa";

const { ehErroInterno, respostaDeErro, mensagemPublica, MENSAGEM_ERRO_INTERNO } = await import("../server/utils/erros.js");
const { isLoginRateLimited, registerLoginFailure } = await import("../server/utils/limite-login.js");
const { chamarOmie, ehErroDeCredencial, ENDPOINTS } = await import("../server/services/integrations/providers/omie/omie.api.js");
const { encryptSecret } = await import("../server/services/integrations/core/integration.security.js");
const { limparProvidersRegistrados, registrarProvider } = await import(
  "../server/services/integrations/core/provider-registry.js"
);

// Erro no formato que o driver pg devolve (SQLSTATE + severity)
function erroDoBanco(code, message) {
  return Object.assign(new Error(message), { code, severity: "ERROR", routine: "x" });
}

// ---------------------------------------------------------------------------------------------
// Erros internos não vazam para o cliente
// ---------------------------------------------------------------------------------------------

test("erro do PostgreSQL nunca chega ao cliente com o texto original", () => {
  const erro = erroDoBanco("42703", "coluna p.administrativo não existe");
  assert.equal(ehErroInterno(erro), true);
  const { status, corpo } = respostaDeErro(erro);
  assert.equal(status, 500);
  assert.equal(corpo.message, MENSAGEM_ERRO_INTERNO);
  assert.doesNotMatch(JSON.stringify(corpo), /administrativo|coluna|42703/);
});

test("erros do banco que o usuário resolve viram mensagem amigável sem nome de constraint", () => {
  const unico = respostaDeErro(erroDoBanco("23505", 'duplicar valor da chave viola a restrição de unicidade "pdvs_nome_key"'));
  assert.equal(unico.status, 409);
  assert.doesNotMatch(JSON.stringify(unico.corpo), /pdvs_nome_key|restrição/);

  const formato = respostaDeErro(erroDoBanco("22P02", 'sintaxe de entrada é inválida para tipo integer: "6.01"'));
  assert.equal(formato.status, 400);
  assert.doesNotMatch(JSON.stringify(formato.corpo), /integer|6\.01/);

  const impasse = respostaDeErro(erroDoBanco("40P01", "impasse detectado"));
  assert.equal(impasse.status, 409);
});

test("erro de sistema (caminho de arquivo) e bug de programação ficam só no log", () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\User\\x.png'"), {
    code: "ENOENT",
    errno: -4058,
    syscall: "open"
  });
  assert.doesNotMatch(JSON.stringify(respostaDeErro(enoent).corpo), /Users|ENOENT/);
  assert.equal(ehErroInterno(new TypeError("Cannot read properties of undefined (reading 'id')")), true);
  assert.equal(ehErroInterno(new Error("Connection terminated unexpectedly")), true);
  assert.equal(ehErroInterno(new Error("timeout exceeded when trying to connect")), true);
});

test("mensagem de negócio continua chegando ao usuário como antes", () => {
  const negocio = new Error("Produto não liberado para este PDV.");
  assert.equal(ehErroInterno(negocio), false);
  const { status, corpo } = respostaDeErro(negocio);
  assert.equal(status, 500);
  assert.equal(corpo.message, "Produto não liberado para este PDV.");

  const comStatus = Object.assign(new Error("Pedido não encontrado."), { statusCode: 404, code: "NAO_ENCONTRADO" });
  const resposta = respostaDeErro(comStatus);
  assert.equal(resposta.status, 404);
  assert.equal(resposta.corpo.error, "NAO_ENCONTRADO");
  assert.equal(resposta.corpo.message, "Pedido não encontrado.");
  assert.equal(mensagemPublica(comStatus), "Pedido não encontrado.");
});

test("os handlers centrais e as rotas que montam erro próprio usam o filtro", () => {
  const index = fs.readFileSync("server/index.js", "utf8");
  // Nenhum send de erro com error.message cru no servidor principal
  assert.doesNotMatch(index, /send\(res, [^)]*\{ error: error\.message/);
  assert.match(index, /respostaDeErro\(error\)/);
  const pedidos = fs.readFileSync("server/modules/pedidos/pedidos.routes.js", "utf8");
  assert.doesNotMatch(pedidos, /error: erro\.message \|\|/);
  const integracoes = fs.readFileSync("server/modules/integrations/integrations.routes.js", "utf8");
  assert.match(integracoes, /ehErroInterno\(erro\.causa \|\| erroBruto\)/);
});

// ---------------------------------------------------------------------------------------------
// Limite de tentativas de senha
// ---------------------------------------------------------------------------------------------

test("depois de 3 senhas erradas o IP fica bloqueado, e outro IP não", () => {
  // Limite definido pelo usuário em 02/10/2026: 3 tentativas a cada 5 minutos
  const ip = `teste-${Date.now()}`;
  for (let i = 0; i < 2; i += 1) registerLoginFailure(ip);
  assert.equal(isLoginRateLimited(ip), false);
  registerLoginFailure(ip);
  assert.equal(isLoginRateLimited(ip), true);
  assert.equal(isLoginRateLimited(`${ip}-outro`), false);
});

test("toda conferência da senha do almoxarifado passa pelo limite de tentativas", () => {
  // Antes só o login tinha limite; a reconfirmação de senha em avarias e na troca de senha
  // permitia testar senhas sem limite com uma sessão de admin esquecida aberta
  const avarias = fs.readFileSync("server/modules/avarias/avarias.routes.js", "utf8");
  const conferencias = avarias.match(/verifyPassword\(/g) || [];
  assert.equal(conferencias.length, 1, "avarias deve conferir senha só dentro de senhaAdminConfere");
  assert.match(avarias, /async function senhaAdminConfere[\s\S]{0,200}isLoginRateLimited\(ip\)/);
  assert.equal((avarias.match(/ipDaRequisicao\(req\)/g) || []).length, 3);

  const index = fs.readFileSync("server/index.js", "utf8");
  const troca = index.slice(index.indexOf("currentAdminPassword"), index.indexOf("currentAdminPassword") + 1500);
  assert.match(troca, /isLoginRateLimited\(ip\)/);
  assert.match(troca, /registerLoginFailure\(ip\)/);
});

// ---------------------------------------------------------------------------------------------
// Falha de autenticação da OMIE
// ---------------------------------------------------------------------------------------------

test("credencial recusada é reconhecida mesmo com o texto acentuado da OMIE", () => {
  assert.equal(ehErroDeCredencial("ERROR: A chave de acesso não está preenchida ou não é válida!"), true);
  assert.equal(ehErroDeCredencial("ERROR: Acesso não autorizado para este aplicativo."), true);
  assert.equal(ehErroDeCredencial("ERROR: Esta aplicação não possui permissão para usar este método."), true);
  assert.equal(ehErroDeCredencial("app_key invalido"), true);
});

test("erro de negócio não vira credencial recusada (pausaria a integração inteira)", () => {
  // "chave de acesso" também é o nome da chave de 44 dígitos da NF-e
  assert.equal(ehErroDeCredencial("ERROR: Chave de acesso da NF-e 3526... não encontrada."), false);
  assert.equal(ehErroDeCredencial('ERROR: O "tipo do Movimento de Estoque" é inválido para o um Kit.'), false);
  assert.equal(ehErroDeCredencial("Invalid page number"), false);
  assert.equal(ehErroDeCredencial("Nao existem registros para a pagina informada"), false);
});

test("HTTP 401/403 da OMIE é autenticação e não é retentado", async () => {
  const fetchImpl = async () => ({
    status: 401,
    headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => "{}"
  });
  const erro = await chamarOmie({
    integracao: { url_base: "https://app.omie.com.br/api/v1" },
    segredos: { app_key: "k", app_secret: "s" },
    endpoint: ENDPOINTS.PRODUTOS,
    call: "ListarProdutos",
    fetchImpl
  }).catch((e) => e);
  assert.equal(erro.codigo, "AUTENTICACAO");
  assert.equal(erro.retentavel, false);
});

// Cliente falso que responde as consultas do runner/agendador para uma integracao
function clienteFalso({ statusIntegracao }) {
  const executadas = [];
  return {
    executadas,
    async query(texto, params = []) {
      executadas.push({ texto, params });
      if (/FROM integrations/.test(texto)) {
        return {
          rows: [{ id: 1, provedor: "TESTE_AUTH", status: statusIntegracao, ativo: true, configuracao: {}, url_base: "https://x/api/v1" }],
          rowCount: 1
        };
      }
      if (texto.includes("credential_key")) {
        return { rows: [{ credential_key: "token", encrypted_value: encryptSecret("t") }], rowCount: 1 };
      }
      if (/INSERT INTO integration_jobs/.test(texto)) return { rows: [{ id: 99, status: "PENDENTE" }], rowCount: 1 };
      if (/UPDATE integration_jobs/.test(texto)) return { rows: [{ id: 9, status: params[1] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
}

// Provider de teste que conta quantas vezes a API "seria" chamada
function registrarProviderDeTeste() {
  const chamadas = { n: 0 };
  limparProvidersRegistrados();
  registrarProvider({
    id: "TESTE_AUTH",
    rotulo: "Teste",
    credenciais: [{ chave: "token", rotulo: "Token" }],
    capacidades: [
      {
        id: "LEITURA",
        rotulo: "Leitura",
        intervaloPadraoMs: 60_000,
        executar: async () => {
          chamadas.n += 1;
          return {};
        }
      }
    ]
  });
  return chamadas;
}

test("com credencial recusada o agendador não chama a API; o operador ainda pode testar", async () => {
  const { executarJob } = await import("../server/services/integrations/core/job.runner.js");
  const chamadas = registrarProviderDeTeste();
  const job = { id: 9, integration_id: 1, job_type: "LEITURA", attempts: 1, payload: {} };

  const automatico = await executarJob(clienteFalso({ statusIntegracao: "ERRO_AUTENTICACAO" }), job);
  assert.equal(chamadas.n, 0, "o agendador nao pode chamar a API com credencial recusada");
  assert.equal(automatico.status, "ERRO_AUTENTICACAO");

  await executarJob(clienteFalso({ statusIntegracao: "ERRO_AUTENTICACAO" }), job, { manual: true });
  assert.equal(chamadas.n, 1, "o clique do operador continua podendo tentar");

  await executarJob(clienteFalso({ statusIntegracao: "CONECTADO" }), job);
  assert.equal(chamadas.n, 2, "integracao saudavel segue normal");
});

test("com credencial recusada o agendador não enfileira nenhuma capacidade", async () => {
  const { enfileirarCapacidadesVencidas } = await import("../server/services/integrations/core/scheduler.js");
  registrarProviderDeTeste();

  const bloqueada = clienteFalso({ statusIntegracao: "ERRO_AUTENTICACAO" });
  await enfileirarCapacidadesVencidas(bloqueada);
  assert.equal(bloqueada.executadas.filter((q) => /INSERT INTO integration_jobs/.test(q.texto)).length, 0);

  const saudavel = clienteFalso({ statusIntegracao: "CONECTADO" });
  await enfileirarCapacidadesVencidas(saudavel);
  assert.equal(saudavel.executadas.filter((q) => /INSERT INTO integration_jobs/.test(q.texto)).length, 1);
});

test("só credencial nova ou sucesso liberam o bloqueio por credencial recusada", () => {
  const repo = fs.readFileSync("server/services/integrations/core/integration.repository.js", "utf8");
  // Salvar credencial nova libera
  assert.match(repo, /SET status = 'PENDENTE'[\s\S]{0,120}status = 'ERRO_AUTENTICACAO'/);
  // Outra falha qualquer (rede, dados) nao pode religar o agendador com a chave errada
  assert.match(repo, /CASE WHEN status = 'ERRO_AUTENTICACAO' THEN status ELSE \$2 END/);
  assert.match(repo, /WHEN status = 'ERRO_AUTENTICACAO' THEN status/);
});

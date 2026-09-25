import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chamar, cookieDe, criarAmbienteDescartavel } from "./helpers/ambiente-descartavel.js";

// Cadastros da Fase 2 contra servidor e banco DESCARTÁVEIS (nunca produção): cargos, matrícula,
// veículos (placa e chave), ferramentas (identificador), fotos/assinaturas pelo storage, sessão
// derrubada pela troca de senha e auditoria.

let amb;
let cookieA;
let idA;
const senhaA = "senha-gestor-a";
// PNG 1x1 válido: as rotas de upload recebem a imagem crua, com Content-Type de imagem
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");

// Atalho para a API do MyControl
const api = (caminho, opcoes = {}) => chamar(amb.base, `/api/mycontrol${caminho}`, { cookie: cookieA, ...opcoes });

// Envia uma imagem crua para a rota de upload
function enviar(caminho, corpo, { tipo = "image/png", cookie = cookieA } = {}) {
  return fetch(`${amb.base}/api/mycontrol${caminho}`, { method: "POST", headers: { "Content-Type": tipo, ...(cookie ? { Cookie: cookie } : {}) }, body: corpo });
}

// Cria usuário com as permissões e devolve o cookie dele
async function criarELogar(usuario, permissoes, senha = "senha-teste-1") {
  const criado = await api("/usuarios", { method: "POST", corpo: { nome: usuario, usuario, senha, confirmarSenha: senha, permissoes } });
  assert.equal(criado.status, 200, JSON.stringify(criado.dados));
  const login = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario, senha } });
  assert.equal(login.status, 200);
  return { id: criado.dados.usuario.id, cookie: cookieDe(login.cookies, "mc_session") };
}

// Cria um cargo e devolve o registro
async function cargo(nome, abreviacao) {
  const r = await api("/cargos", { method: "POST", corpo: { nome, abreviacao } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  return r.dados.cargo;
}

// Cria um colaborador e devolve a resposta inteira
function colaborador(nome, cargoId, extras = {}) {
  return api("/colaboradores", { method: "POST", corpo: { valores: { nome, cargo: cargoId, ...extras } } });
}

test.before(async () => {
  amb = await criarAmbienteDescartavel({ env: { UPLOAD_MAX_IMAGE_MB: "1" } });
  const primeiro = await chamar(amb.base, "/api/mycontrol/setup/primeiro-usuario", {
    method: "POST",
    corpo: { nome: "Gestor A", usuario: "gestor.a", senha: senhaA, confirmarSenha: senhaA }
  });
  assert.equal(primeiro.status, 200);
  cookieA = cookieDe(primeiro.cookies, "mc_session");
  idA = primeiro.dados.usuario.id;
});

test.after(async () => {
  await amb?.encerrar();
});

// ===== Cargos =====

test("cargo: abreviação de 2 a 6 letras, gravada em maiúsculas e única; nome único sem diferenciar caixa", async () => {
  const op = await cargo("Operador", "op");
  assert.equal(op.abreviacao, "OP");
  for (const ruim of ["A", "ABCDEFG", "A1", "AÇO", "A B", ""]) {
    const r = await api("/cargos", { method: "POST", corpo: { nome: `Cargo ${ruim}`, abreviacao: ruim } });
    assert.equal(r.status, 400, `abreviação "${ruim}" deveria ser recusada`);
  }
  assert.equal((await api("/cargos", { method: "POST", corpo: { nome: "Outro", abreviacao: "OP" } })).status, 409);
  const nomeRepetido = await api("/cargos", { method: "POST", corpo: { nome: "OPERADOR", abreviacao: "OPE" } });
  assert.equal(nomeRepetido.status, 409);
  assert.match(nomeRepetido.dados.error, /nome/);
});

// ===== Matrícula =====

test("matrícula ABREV-000123 vem de uma sequence única, compartilhada entre os cargos", async () => {
  const { rows: cargos } = await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'OP'");
  const mot = await cargo("Motorista", "MOT");
  const a = await colaborador("Ana", cargos[0].id);
  const b = await colaborador("Bruno", mot.id);
  assert.equal(a.status, 200, JSON.stringify(a.dados));
  assert.match(a.dados.item.matricula, /^OP-\d{6}$/);
  assert.match(b.dados.item.matricula, /^MOT-\d{6}$/);
  const n = (m) => Number(m.split("-")[1]);
  assert.equal(n(b.dados.item.matricula), n(a.dados.item.matricula) + 1, "uma sequence só para todos os cargos");
});

test("matrícula: criações simultâneas nunca repetem número", async () => {
  const { rows } = await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'OP'");
  const respostas = await Promise.all(Array.from({ length: 10 }, (_, i) => colaborador(`Simultâneo ${i}`, rows[0].id)));
  assert.ok(respostas.every((r) => r.status === 200), respostas.map((r) => r.status).join(","));
  const matriculas = respostas.map((r) => r.dados.item.matricula);
  assert.equal(new Set(matriculas).size, 10);
  const { rows: dup } = await amb.sql("SELECT matricula_numero, count(*) FROM mc_colaboradores GROUP BY 1 HAVING count(*) > 1");
  assert.equal(dup.length, 0);
});

test("matrícula não é editável pela API e não muda ao trocar de cargo", async () => {
  const mot = (await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'MOT'")).rows[0];
  const criado = await colaborador("Carla", (await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'OP'")).rows[0].id);
  const { id, matricula } = criado.dados.item;
  const tentativa = await api(`/colaboradores/${id}`, { method: "PATCH", corpo: { valores: { matricula: "OP-999999", nome: "Carla" } } });
  assert.equal(tentativa.status, 400);
  assert.match(tentativa.dados.error, /matrícula/i);
  const troca = await api(`/colaboradores/${id}`, { method: "PATCH", corpo: { valores: { nome: "Carla Souza", cargo: mot.id } } });
  assert.equal(troca.status, 200, JSON.stringify(troca.dados));
  assert.equal(troca.dados.item.matricula, matricula, "trocar de cargo não muda a matrícula");
  assert.equal(troca.dados.item.cargo.abreviacao, "MOT");
  // Nem um UPDATE direto no banco consegue trocar (gatilho)
  await assert.rejects(() => amb.sql("UPDATE mc_colaboradores SET matricula = 'MOT-000001' WHERE id = $1", [id]), /matricula/i);
  await assert.rejects(() => amb.sql("UPDATE mc_colaboradores SET matricula_numero = 1 WHERE id = $1", [id]), /matricula/i);
});

test("matrícula nunca é reaproveitada: desativar alguém não devolve o número", async () => {
  const opId = (await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'OP'")).rows[0].id;
  const { rows: maior } = await amb.sql("SELECT max(matricula_numero)::int AS n FROM mc_colaboradores");
  const ultimo = (await amb.sql("SELECT id FROM mc_colaboradores WHERE matricula_numero = $1", [maior[0].n])).rows[0];
  assert.equal((await api(`/colaboradores/${ultimo.id}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
  // Cadastro recusado na validação não gera matrícula nenhuma
  const falha = await api("/colaboradores", { method: "POST", corpo: { valores: { nome: "", cargo: opId } } });
  assert.equal(falha.status, 400);
  const novo = await colaborador("Depois", opId);
  assert.ok(Number(novo.dados.item.matricula.split("-")[1]) > maior[0].n);
});

test("editar a abreviação do cargo não muda as matrículas já geradas", async () => {
  const op = (await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'OP'")).rows[0];
  const { rows: antes } = await amb.sql("SELECT id, matricula FROM mc_colaboradores WHERE cargo_id = $1 ORDER BY id", [op.id]);
  const editado = await api(`/cargos/${op.id}`, { method: "PATCH", corpo: { nome: "Operador", abreviacao: "OPR" } });
  assert.equal(editado.status, 200);
  assert.equal(editado.dados.cargo.abreviacao_mudou, true);
  const { rows: depois } = await amb.sql("SELECT id, matricula FROM mc_colaboradores WHERE cargo_id = $1 ORDER BY id", [op.id]);
  assert.deepEqual(depois, antes);
  const novo = await colaborador("Nova", op.id);
  assert.match(novo.dados.item.matricula, /^OPR-\d{6}$/);
});

test("cargo em uso não é excluído, só desativado; desativado não vale para colaborador novo", async () => {
  const mot = (await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'MOT'")).rows[0];
  const excluir = await api(`/cargos/${mot.id}/excluir`, { method: "POST", corpo: {} });
  assert.equal(excluir.status, 409);
  assert.equal((await api(`/cargos/${mot.id}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
  assert.equal((await colaborador("Não pode", mot.id)).status, 400);
  // Quem já está no cargo desativado continua editável sem trocar de cargo
  const bruno = (await amb.sql("SELECT id FROM mc_colaboradores WHERE nome = 'Bruno'")).rows[0];
  const edita = await api(`/colaboradores/${bruno.id}`, { method: "PATCH", corpo: { valores: { nome: "Bruno Lima", cargo: mot.id } } });
  assert.equal(edita.status, 200, JSON.stringify(edita.dados));
  // Cargo nunca usado pode ser excluído
  const livre = await cargo("Temporário", "TEMP");
  assert.equal((await api(`/cargos/${livre.id}/excluir`, { method: "POST", corpo: {} })).status, 200);
  assert.equal((await amb.sql("SELECT count(*)::int AS n FROM mc_cargos WHERE id = $1", [livre.id])).rows[0].n, 0);
});

// ===== Veículos =====

test("placa é normalizada (antigo e Mercosul) e exibida formatada; placa inválida é recusada", async () => {
  const antigo = await api("/veiculos", { method: "POST", corpo: { valores: { numero_chave: "1", nome: "Caminhão", placa: "abc-1234" } } });
  assert.equal(antigo.status, 200, JSON.stringify(antigo.dados));
  assert.equal(antigo.dados.item.valores.placa, "ABC1234");
  assert.equal(antigo.dados.item.placa_formatada, "ABC-1234");
  const mercosul = await api("/veiculos", { method: "POST", corpo: { valores: { numero_chave: "2", nome: "Van", placa: "bra 2e19" } } });
  assert.equal(mercosul.dados.item.valores.placa, "BRA2E19");
  assert.equal(mercosul.dados.item.placa_formatada, "BRA2E19");
  for (const ruim of ["AB12345", "ABCD123", "ABC12345", "1BC1234"]) {
    const r = await api("/veiculos", { method: "POST", corpo: { valores: { numero_chave: `X${ruim}`, nome: "Ruim", placa: ruim } } });
    assert.equal(r.status, 400, ruim);
  }
});

test("número da chave é único entre os ativos (veículo baixado libera a chave)", async () => {
  const dup = await api("/veiculos", { method: "POST", corpo: { valores: { numero_chave: "1", nome: "Outro", placa: "XYZ9876" } } });
  assert.equal(dup.status, 409);
  assert.match(dup.dados.error, /chave/);
  const primeiro = (await amb.sql("SELECT id FROM mc_veiculos WHERE numero_chave = '1'")).rows[0];
  assert.equal((await api(`/veiculos/${primeiro.id}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
  const agora = await api("/veiculos", { method: "POST", corpo: { valores: { numero_chave: "1", nome: "Outro", placa: "XYZ9876" } } });
  assert.equal(agora.status, 200);
  // Reativar o antigo esbarra na chave em uso
  const reativa = await api(`/veiculos/${primeiro.id}/ativo`, { method: "POST", corpo: { ativo: true } });
  assert.equal(reativa.status, 409);
});

// ===== Ferramentas =====

test("identificador da ferramenta é único sempre (mesmo desativada) e gravado em maiúsculas", async () => {
  const f = await api("/ferramentas", { method: "POST", corpo: { valores: { nome: "Furadeira", identificador: "fur-01" } } });
  assert.equal(f.status, 200, JSON.stringify(f.dados));
  assert.equal(f.dados.item.valores.identificador, "FUR-01");
  await api(`/ferramentas/${f.dados.item.id}/ativo`, { method: "POST", corpo: { ativo: false } });
  const dup = await api("/ferramentas", { method: "POST", corpo: { valores: { nome: "Outra", identificador: "FUR-01" } } });
  assert.equal(dup.status, 409);
  assert.match(dup.dados.error, /identificador/);
});

// ===== Fotos e assinaturas =====

test("upload exige Content-Type de imagem, confere os bytes e respeita o limite", async () => {
  assert.equal((await enviar("/arquivos/colaborador", PNG, { tipo: "text/plain" })).status, 415);
  assert.equal((await enviar("/arquivos/colaborador", PNG, { tipo: "application/json" })).status, 415);
  assert.equal((await enviar("/arquivos/colaborador", PNG, { tipo: "multipart/form-data; boundary=x" })).status, 415);
  const falso = await enviar("/arquivos/colaborador", Buffer.from("<script>alert(1)</script>"), { tipo: "image/png" });
  assert.equal(falso.status, 400, "conteúdo que não é imagem de verdade é recusado");
  const grande = Buffer.concat([PNG, Buffer.alloc(1.2 * 1024 * 1024)]);
  const r = await enviar("/arquivos/colaborador", grande).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
  assert.equal((await chamar(amb.base, "/api/health")).status, 200, "o servidor segue no ar");
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_arquivos");
  assert.equal(rows[0].n, 0);
});

test("foto vai para o storage (sem base64 no banco), com miniatura e acesso só de quem gerencia", async () => {
  const principal = await enviar("/arquivos/colaborador?papel=foto", PNG);
  assert.equal(principal.status, 200);
  const { arquivo } = await principal.json();
  const mini = await enviar(`/arquivos/colaborador/${arquivo.id}/miniatura`, PNG);
  assert.equal(mini.status, 200);
  // Miniatura é gravada uma vez só (não dá para trocar a imagem da lista de um cadastro salvo)
  assert.equal((await enviar(`/arquivos/colaborador/${arquivo.id}/miniatura`, PNG)).status, 409);
  const { rows } = await amb.sql("SELECT storage_key, miniatura_key FROM mc_arquivos WHERE id = $1", [arquivo.id]);
  assert.ok(fs.existsSync(path.join(amb.pastaStorage, rows[0].storage_key)), "o arquivo está no storage");
  assert.ok(rows[0].miniatura_key);

  const opId = (await amb.sql("SELECT id FROM mc_cargos WHERE abreviacao = 'OPR'")).rows[0].id;
  const criado = await colaborador("Com foto", opId, { foto: arquivo.id });
  assert.equal(criado.status, 200, JSON.stringify(criado.dados));
  assert.equal(criado.dados.item.foto_id, arquivo.id);

  // Foto de outra entidade ou assinatura no lugar da foto é recusada
  const doVeiculo = await (await enviar("/arquivos/veiculo?papel=foto", PNG)).json();
  assert.equal((await colaborador("Errado", opId, { foto: doVeiculo.arquivo.id })).status, 400);
  const assinatura = await (await enviar("/arquivos/colaborador?papel=assinatura", PNG)).json();
  assert.equal((await colaborador("Errado 2", opId, { foto: assinatura.arquivo.id })).status, 400);
  const comAssinatura = await colaborador("Assinou", opId, { assinatura: assinatura.arquivo.id });
  assert.equal(comAssinatura.status, 200);

  // Servir: quem gerencia colaboradores vê; quem só gerencia veículos, não
  const ok = await fetch(`${amb.base}/api/mycontrol/arquivos/${arquivo.id}?miniatura=1`, { headers: { Cookie: cookieA } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  const soVeiculo = await criarELogar("so.veiculo", ["veiculo.gerenciar"]);
  assert.equal((await fetch(`${amb.base}/api/mycontrol/arquivos/${arquivo.id}`, { headers: { Cookie: soVeiculo.cookie } })).status, 403);
  assert.equal((await enviar("/arquivos/colaborador", PNG, { cookie: soVeiculo.cookie })).status, 403);
  assert.equal((await enviar("/arquivos/veiculo", PNG, { cookie: soVeiculo.cookie })).status, 200);

  // Nenhum base64 de imagem em lugar nenhum do banco do MyControl
  const { rows: texto } = await amb.sql(
    `SELECT (SELECT coalesce(string_agg(dados::text, ''), '') FROM mc_colaboradores) ||
            (SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') FROM mc_arquivos a) AS t`
  );
  assert.doesNotMatch(texto[0].t, /data:image|base64|iVBORw0KGgo/);
});

// ===== Sessão =====

test("redefinir a senha derruba as sessões abertas do usuário", async () => {
  const u = await criarELogar("usuario.u", ["colaborador.gerenciar"]);
  assert.equal((await chamar(amb.base, "/api/mycontrol/colaboradores", { cookie: u.cookie })).status, 200);
  // Garante que a troca aconteça num segundo posterior ao do login (o iat do JWT é em segundos)
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const troca = await api(`/usuarios/${u.id}/senha`, { method: "POST", corpo: { senha: "nova-senha-9", confirmarSenha: "nova-senha-9" } });
  assert.equal(troca.status, 200);
  assert.equal(troca.cookies.length, 0, "trocar a senha de outra pessoa não mexe no cookie de quem trocou");
  assert.equal((await chamar(amb.base, "/api/mycontrol/colaboradores", { cookie: u.cookie })).status, 401);
  assert.equal((await chamar(amb.base, "/api/mycontrol/auth/me", { cookie: u.cookie })).dados.usuario, null);
  const novoLogin = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "usuario.u", senha: "nova-senha-9" } });
  assert.equal(novoLogin.status, 200);
  assert.equal((await chamar(amb.base, "/api/mycontrol/colaboradores", { cookie: cookieDe(novoLogin.cookies, "mc_session") })).status, 200);
});

test("quem redefine a própria senha recebe sessão nova e as outras sessões dele caem", async () => {
  const outraSessao = cookieDe((await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario: "gestor.a", senha: senhaA } })).cookies, "mc_session");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const troca = await api(`/usuarios/${idA}/senha`, { method: "POST", corpo: { senha: "gestor-nova-1", confirmarSenha: "gestor-nova-1" } });
  assert.equal(troca.status, 200);
  const novoCookie = cookieDe(troca.cookies, "mc_session");
  assert.ok(novoCookie, "a própria pessoa recebe um token novo");
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: novoCookie })).status, 200);
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: outraSessao })).status, 401);
  assert.equal((await chamar(amb.base, "/api/mycontrol/usuarios", { cookie: cookieA })).status, 401);
  cookieA = novoCookie;
});

// ===== Auditoria =====

test("auditoria registra criação e edição de cadastro e de cargo, com o autor", async () => {
  const { rows } = await amb.sql("SELECT acao, usuario_id FROM mc_auditoria WHERE entidade IN ('colaborador', 'veiculo', 'ferramenta', 'cargo')");
  const acoes = new Set(rows.map((r) => r.acao));
  for (const acao of ["cargo.criar", "cargo.editar", "cargo.desativar", "cargo.excluir", "colaborador.criar", "colaborador.editar", "colaborador.desativar", "veiculo.criar", "veiculo.desativar", "ferramenta.criar", "ferramenta.desativar"]) {
    assert.ok(acoes.has(acao), `faltou ${acao} na auditoria`);
  }
  assert.ok(rows.every((r) => r.usuario_id === idA));
  // A troca de cargo fica registrada com antes e depois
  const { rows: troca } = await amb.sql("SELECT antes, depois FROM mc_auditoria WHERE acao = 'colaborador.editar' AND depois ? 'cargo' LIMIT 1");
  assert.ok(troca[0], "a troca de cargo deveria aparecer na auditoria");
});

import test from "node:test";
import assert from "node:assert/strict";
import { chamar, cookieDe, criarAmbienteDescartavel } from "./helpers/ambiente-descartavel.js";

// Campos configuráveis contra servidor e banco DESCARTÁVEIS (nunca produção): seed dos campos do
// sistema (idempotente e sem desfazer o que o usuário mudou), campos travados, tipos, validação
// no servidor, regra coluna x `dados`, exclusão lógica e aviso de obrigatório vazio.

let amb;
let cookieA;
let cargoId;
const senhaA = "senha-gestor-a";

// Atalho para a API do MyControl com a sessão do gestor
const api = (caminho, opcoes = {}) => chamar(amb.base, `/api/mycontrol${caminho}`, { cookie: cookieA, ...opcoes });

// Campos de uma entidade, por chave
async function campos(entidade) {
  const r = await api(`/campos?entidade=${entidade}`);
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  return Object.fromEntries(r.dados.campos.map((c) => [c.chave, c]));
}

// Cria um campo do usuário e devolve o registro
async function novoCampo(corpo) {
  const r = await api("/campos", { method: "POST", corpo });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  return r.dados.campo;
}

test.before(async () => {
  amb = await criarAmbienteDescartavel();
  const primeiro = await chamar(amb.base, "/api/mycontrol/setup/primeiro-usuario", {
    method: "POST",
    corpo: { nome: "Gestor A", usuario: "gestor.a", senha: senhaA, confirmarSenha: senhaA }
  });
  cookieA = cookieDe(primeiro.cookies, "mc_session");
  cargoId = (await api("/cargos", { method: "POST", corpo: { nome: "Operador", abreviacao: "OP" } })).dados.cargo.id;
});

test.after(async () => {
  await amb?.encerrar();
});

test("o seed cria os campos do sistema com os travados certos", async () => {
  const col = await campos("colaborador");
  for (const chave of ["nome", "assinatura", "cargo", "matricula"]) assert.equal(col[chave].travado, true, `colaborador.${chave}`);
  assert.equal(col.foto.travado, false);
  const vei = await campos("veiculo");
  for (const chave of ["numero_chave", "nome", "placa"]) assert.equal(vei[chave].travado, true, `veiculo.${chave}`);
  const fer = await campos("ferramenta");
  for (const chave of ["nome", "identificador"]) assert.equal(fer[chave].travado, true, `ferramenta.${chave}`);
  assert.equal((await api("/campos?entidade=cliente")).status, 400);
});

test("campo travado não é desativado nem excluído; tipo nunca muda; obrigatório fixo não sai", async () => {
  const col = await campos("colaborador");
  assert.equal((await api(`/campos/${col.nome.id}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 400);
  assert.equal((await api(`/campos/${col.assinatura.id}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 400);
  assert.equal((await api(`/campos/${col.nome.id}/excluir`, { method: "POST", corpo: {} })).status, 400);
  assert.equal((await api(`/campos/${col.nome.id}`, { method: "PATCH", corpo: { obrigatorio: false } })).status, 400);
  assert.equal((await api(`/campos/${col.nome.id}`, { method: "PATCH", corpo: { tipo: "numero" } })).status, 400);
  // Campo do sistema não travado: desativa, mas não é excluído
  assert.equal((await api(`/campos/${col.foto.id}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
  assert.equal((await api(`/campos/${col.foto.id}/excluir`, { method: "POST", corpo: {} })).status, 400);
  assert.equal((await api(`/campos/${col.foto.id}/ativo`, { method: "POST", corpo: { ativo: true } })).status, 200);
  // Rótulo de travado pode mudar
  assert.equal((await api(`/campos/${col.nome.id}`, { method: "PATCH", corpo: { rotulo: "Nome completo" } })).status, 200);
});

test("criação de campo valida tipo e opções e gera chave sem reaproveitar", async () => {
  assert.equal((await api("/campos", { method: "POST", corpo: { entidade: "colaborador", rotulo: "X", tipo: "matricula" } })).status, 400);
  assert.equal((await api("/campos", { method: "POST", corpo: { entidade: "colaborador", rotulo: "X", tipo: "planilha" } })).status, 400);
  assert.equal((await api("/campos", { method: "POST", corpo: { entidade: "colaborador", rotulo: "Camisa", tipo: "selecao", opcoes: [] } })).status, 400);
  assert.equal((await api("/campos", { method: "POST", corpo: { entidade: "outro", rotulo: "X", tipo: "texto" } })).status, 400);
  const camisa = await novoCampo({ entidade: "colaborador", rotulo: "Tamanho da camisa", tipo: "selecao", opcoes: ["P", "M", "G", "M"] });
  assert.equal(camisa.chave, "tamanho_da_camisa");
  assert.deepEqual(camisa.opcoes, ["P", "M", "G"]);
  const denovo = await novoCampo({ entidade: "colaborador", rotulo: "Tamanho da Camisa", tipo: "texto" });
  assert.equal(denovo.chave, "tamanho_da_camisa_2");
  await novoCampo({ entidade: "colaborador", rotulo: "Data de admissão", tipo: "data" });
  await novoCampo({ entidade: "colaborador", rotulo: "CNH válida", tipo: "sim_nao" });
  await novoCampo({ entidade: "colaborador", rotulo: "Telefone", tipo: "telefone" });
  await novoCampo({ entidade: "colaborador", rotulo: "Calçado", tipo: "numero" });
});

test("campo do sistema vai para coluna e campo do usuário vai para `dados`", async () => {
  const r = await api("/colaboradores", {
    method: "POST",
    corpo: { valores: { nome: "Ana", cargo: cargoId, tamanho_da_camisa: "M", data_de_admissao: "2026-09-01", cnh_valida: true, telefone: "(62) 99999-1234", calcado: "41,5" } }
  });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const { rows } = await amb.sql("SELECT nome, cargo_id, dados FROM mc_colaboradores WHERE id = $1", [r.dados.item.id]);
  assert.equal(rows[0].nome, "Ana");
  assert.equal(rows[0].cargo_id, cargoId);
  assert.deepEqual(rows[0].dados, { tamanho_da_camisa: "M", data_de_admissao: "2026-09-01", cnh_valida: true, telefone: "62999991234", calcado: 41.5 });
  assert.equal(rows[0].dados.nome, undefined, "campo do sistema nunca vai para dados");
});

test("valores são validados no servidor contra os campos ativos", async () => {
  const casos = [
    [{ desconhecido: "x" }, /desconhecido/],
    [{ tamanho_da_camisa: "GG" }, /opções/],
    [{ data_de_admissao: "2026-02-30" }, /data/],
    [{ calcado: "quarenta" }, /número/],
    [{ telefone: "1234" }, /telefone/i],
    [{ cnh_valida: "sim" }, /sim ou não/],
    [{ nome: "x".repeat(121) }, /máximo/],
    [{ cargo: 999999 }, /cargo/i]
  ];
  for (const [extra, erro] of casos) {
    const r = await api("/colaboradores", { method: "POST", corpo: { valores: { nome: "Teste", cargo: cargoId, ...extra } } });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.dados.error, erro, JSON.stringify(extra));
  }
  assert.equal((await api("/colaboradores", { method: "POST", corpo: { valores: { cargo: cargoId } } })).status, 400, "nome obrigatório");
  assert.equal((await api("/colaboradores", { method: "POST", corpo: {} })).status, 400);
});

test("tornar um campo obrigatório não invalida os antigos, mas a lista avisa", async () => {
  const antigo = await api("/colaboradores", { method: "POST", corpo: { valores: { nome: "Sem telefone", cargo: cargoId } } });
  assert.equal(antigo.status, 200);
  const tel = (await campos("colaborador")).telefone;
  assert.equal((await api(`/campos/${tel.id}`, { method: "PATCH", corpo: { obrigatorio: true } })).status, 200);
  const lista = await api("/colaboradores?q=Sem%20telefone");
  assert.equal(lista.status, 200);
  const item = lista.dados.itens.find((i) => i.id === antigo.dados.item.id);
  assert.deepEqual(item.pendencias, ["Telefone"]);
  // Cadastro novo já precisa do campo
  const novo = await api("/colaboradores", { method: "POST", corpo: { valores: { nome: "Novo", cargo: cargoId } } });
  assert.equal(novo.status, 400);
  assert.match(novo.dados.error, /Telefone/);
  // Campo desativado deixa de ser exigido e o valor gravado fica
  assert.equal((await api(`/campos/${tel.id}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
  assert.equal((await api("/colaboradores", { method: "POST", corpo: { valores: { nome: "Novo", cargo: cargoId } } })).status, 200);
  const ana = (await amb.sql("SELECT id FROM mc_colaboradores WHERE nome = 'Ana'")).rows[0];
  await api(`/colaboradores/${ana.id}`, { method: "PATCH", corpo: { valores: { nome: "Ana Paula", cargo: cargoId } } });
  assert.equal((await amb.sql("SELECT dados->>'telefone' AS t FROM mc_colaboradores WHERE id = $1", [ana.id])).rows[0].t, "62999991234");
  await api(`/campos/${tel.id}/ativo`, { method: "POST", corpo: { ativo: true } });
  await api(`/campos/${tel.id}`, { method: "PATCH", corpo: { obrigatorio: false } });
});

test("excluir campo é lógico: some da tela, o valor antigo fica e a chave não volta", async () => {
  const calcado = (await campos("colaborador")).calcado;
  assert.equal((await api(`/campos/${calcado.id}/excluir`, { method: "POST", corpo: {} })).status, 200);
  assert.equal((await campos("colaborador")).calcado, undefined);
  const ana = (await amb.sql("SELECT id FROM mc_colaboradores WHERE nome = 'Ana Paula'")).rows[0];
  // Mandar valor para o campo excluído é recusado; editar o resto não apaga o valor antigo
  assert.equal((await api(`/colaboradores/${ana.id}`, { method: "PATCH", corpo: { valores: { calcado: 40 } } })).status, 400);
  assert.equal((await api(`/colaboradores/${ana.id}`, { method: "PATCH", corpo: { valores: { nome: "Ana P." } } })).status, 200);
  assert.equal((await amb.sql("SELECT dados->>'calcado' AS c FROM mc_colaboradores WHERE id = $1", [ana.id])).rows[0].c, "41.5");
  const outro = await novoCampo({ entidade: "colaborador", rotulo: "Calçado", tipo: "numero" });
  assert.equal(outro.chave, "calcado_2", "a chave de um campo excluído nunca é reaproveitada");
});

test("reordenar exige a lista completa dos campos", async () => {
  const lista = (await api("/campos?entidade=ferramenta")).dados.campos.map((c) => c.id);
  const invertida = [...lista].reverse();
  const r = await api("/campos/ordem", { method: "POST", corpo: { entidade: "ferramenta", ids: invertida } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.dados.campos.map((c) => c.id), invertida);
  assert.equal((await api("/campos/ordem", { method: "POST", corpo: { entidade: "ferramenta", ids: invertida.slice(1) } })).status, 409);
});

test("o seed não desfaz nem ressuscita nada depois de um reboot", async () => {
  // Mudanças do usuário: rótulo, ordem, obrigatoriedade, campo do sistema desativado, campo excluído
  const vei = await campos("veiculo");
  await api(`/campos/${vei.placa.id}`, { method: "PATCH", corpo: { rotulo: "Placa do veículo" } });
  await api(`/campos/${vei.foto.id}/ativo`, { method: "POST", corpo: { ativo: false } });
  await api(`/campos/${vei.descricao.id}`, { method: "PATCH", corpo: { obrigatorio: true } });
  const ordem = Object.values(vei).sort((a, b) => a.ordem - b.ordem).map((c) => c.id).reverse();
  await api("/campos/ordem", { method: "POST", corpo: { entidade: "veiculo", ids: ordem } });
  const { rows: antes } = await amb.sql("SELECT id, entidade, chave, rotulo, obrigatorio, ordem, ativo, excluido_em FROM mc_campos ORDER BY id");

  // "Reboot": roda o ensure de novo, num processo novo (este), contra o banco descartável
  process.env.DATABASE_URL = amb.databaseUrl;
  const { ensureMyControlTables } = await import("../server/services/mycontrol/mycontrol.schema.js");
  await ensureMyControlTables();
  const { pool } = await import("../server/db.js");
  await pool.end();

  const { rows: depois } = await amb.sql("SELECT id, entidade, chave, rotulo, obrigatorio, ordem, ativo, excluido_em FROM mc_campos ORDER BY id");
  assert.deepEqual(depois, antes, "nenhuma linha mudou nem nasceu");
  const excluido = depois.find((c) => c.chave === "calcado");
  assert.ok(excluido.excluido_em, "o campo excluído continua excluído");
});

test("auditoria registra criação, edição, desativação, exclusão e ordem de campos", async () => {
  const { rows } = await amb.sql("SELECT DISTINCT acao FROM mc_auditoria WHERE entidade = 'campo'");
  const acoes = new Set(rows.map((r) => r.acao));
  for (const acao of ["campo.criar", "campo.editar", "campo.desativar", "campo.reativar", "campo.excluir", "campo.reordenar"]) {
    assert.ok(acoes.has(acao), `faltou ${acao}`);
  }
});

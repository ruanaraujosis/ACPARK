import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chamar, cookieDe, criarAmbienteDescartavel } from "./helpers/ambiente-descartavel.js";

// Registros de uso e devolução (Fase 3) contra servidor e banco DESCARTÁVEIS (nunca produção):
// hora do servidor, um item em uso por vez (inclusive com envios simultâneos), devolução, km,
// cancelamento e exclusão lógica com motivo, cópia real da assinatura, item em uso não pode ser
// desativado, cadastro desativado fora da escolha, permissão por ação e acesso às fotos.

let amb;
let cookieA;
let idA;
const senhaA = "senha-gestor-a";
// Dois PNGs válidos e diferentes (assinatura antiga e nova, para provar a cópia)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");
const PNG_2 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const ids = {};

// Atalho para a API do MyControl (sessão do gestor por padrão)
const api = (caminho, opcoes = {}) => chamar(amb.base, `/api/mycontrol${caminho}`, { cookie: cookieA, ...opcoes });

// Envia uma imagem e devolve o id do arquivo
async function subir(entidade, { papel = "foto", corpo = PNG, cookie = cookieA } = {}) {
  const r = await fetch(`${amb.base}/api/mycontrol/arquivos/${entidade}?papel=${papel}`, { method: "POST", headers: { "Content-Type": "image/png", Cookie: cookie }, body: corpo });
  const dados = await r.json();
  assert.equal(r.status, 200, JSON.stringify(dados));
  return dados.arquivo.id;
}

// Cria usuário com as permissões e devolve id + cookie
async function criarELogar(usuario, permissoes, senha = "senha-teste-1") {
  const criado = await api("/usuarios", { method: "POST", corpo: { nome: usuario, usuario, senha, confirmarSenha: senha, permissoes } });
  assert.equal(criado.status, 200, JSON.stringify(criado.dados));
  const login = await chamar(amb.base, "/api/mycontrol/auth/login", { method: "POST", corpo: { usuario, senha } });
  return { id: criado.dados.usuario.id, cookie: cookieDe(login.cookies, "mc_session") };
}

// Registra uma retirada com foto nova; `extras` sobrescreve o corpo
async function registrar(extras = {}, cookie = cookieA) {
  const foto = await subir("registro", { cookie: cookieA });
  return api("/registros", { method: "POST", cookie, corpo: { tipo: "veiculo", item_id: ids.veiculo, colaborador_id: ids.colaborador, km_saida: 1000, foto_antes: foto, ...extras } });
}

// Devolve com foto nova
async function devolver(id, extras = {}) {
  const foto = await subir("registro");
  return api(`/registros/${id}/devolver`, { method: "POST", corpo: { foto_depois: foto, km_volta: 1050, ...extras } });
}

// sha256 do arquivo gravado no storage para um id de mc_arquivos
async function shaDoArquivo(id) {
  const { rows } = await amb.sql("SELECT storage_key FROM mc_arquivos WHERE id = $1", [id]);
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(amb.pastaStorage, rows[0].storage_key))).digest("hex");
}

test.before(async () => {
  amb = await criarAmbienteDescartavel();
  const primeiro = await chamar(amb.base, "/api/mycontrol/setup/primeiro-usuario", {
    method: "POST",
    corpo: { nome: "Gestor A", usuario: "gestor.a", senha: senhaA, confirmarSenha: senhaA }
  });
  cookieA = cookieDe(primeiro.cookies, "mc_session");
  idA = primeiro.dados.usuario.id;
  const cargo = (await api("/cargos", { method: "POST", corpo: { nome: "Motorista", abreviacao: "MOT" } })).dados.cargo;
  ids.cargo = cargo.id;
  // Cadastros com os obrigatórios: assinatura do colaborador e foto do veículo
  const criarColaborador = async (nome) => {
    const assinatura = await subir("colaborador", { papel: "assinatura" });
    const r = await api("/colaboradores", { method: "POST", corpo: { valores: { nome, cargo: cargo.id, assinatura } } });
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    return r.dados.item.id;
  };
  ids.colaborador = await criarColaborador("Ana Motorista");
  ids.colaborador2 = await criarColaborador("Bruno Motorista");
  const criarVeiculo = async (chave, placa) => {
    const foto = await subir("veiculo");
    const r = await api("/veiculos", { method: "POST", corpo: { valores: { numero_chave: chave, nome: `Van ${chave}`, placa, foto } } });
    assert.equal(r.status, 200, JSON.stringify(r.dados));
    return r.dados.item.id;
  };
  ids.veiculo = await criarVeiculo("1", "ABC1D23");
  ids.veiculo2 = await criarVeiculo("2", "XYZ9876");
  ids.veiculo3 = await criarVeiculo("3", "QWE1234");
  const f = await api("/ferramentas", { method: "POST", corpo: { valores: { nome: "Furadeira", identificador: "FUR-01" } } });
  ids.ferramenta = f.dados.item.id;
});

test.after(async () => {
  await amb?.encerrar();
});

test("a hora do registro é do servidor: a hora enviada pelo navegador é ignorada", async () => {
  const r = await registrar({ retirado_em: "2001-01-01T00:00:00Z", devolvido_em: "2001-01-02T00:00:00Z", status: "DEVOLVIDO" });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  const { rows } = await amb.sql("SELECT abs(extract(epoch FROM (retirado_em - now())))::int AS dif, status, devolvido_em FROM mc_registros WHERE id = $1", [r.dados.registro.id]);
  assert.ok(rows[0].dif < 60, `retirado_em deveria ser agora (diferença ${rows[0].dif}s)`);
  assert.equal(rows[0].status, "EM_USO");
  assert.equal(rows[0].devolvido_em, null);
  const { rows: tipo } = await amb.sql("SELECT data_type FROM information_schema.columns WHERE table_name = 'mc_registros' AND column_name IN ('retirado_em', 'devolvido_em', 'cancelado_em', 'excluido_em')");
  assert.equal(tipo.length, 4);
  assert.ok(tipo.every((c) => c.data_type === "timestamp with time zone"));
  ids.registroAberto = r.dados.registro.id;
});

test("um item não pode ter dois registros em uso, nem com envios simultâneos", async () => {
  const segundo = await registrar();
  assert.equal(segundo.status, 409);
  assert.match(segundo.dados.error, /em uso/);
  // Cinco envios ao mesmo tempo para um item livre: só um passa
  const fotos = await Promise.all(Array.from({ length: 5 }, () => subir("registro")));
  const respostas = await Promise.all(fotos.map((foto) => api("/registros", { method: "POST", corpo: { tipo: "veiculo", item_id: ids.veiculo2, colaborador_id: ids.colaborador2, km_saida: 500, foto_antes: foto } })));
  assert.equal(respostas.filter((r) => r.status === 200).length, 1, respostas.map((r) => r.status).join(","));
  assert.ok(respostas.filter((r) => r.status !== 200).every((r) => r.status === 409));
  const { rows } = await amb.sql("SELECT count(*)::int AS n FROM mc_registros WHERE tipo = 'veiculo' AND item_id = $1 AND status = 'EM_USO'", [ids.veiculo2]);
  assert.equal(rows[0].n, 1);
  // A regra é do banco: um INSERT direto também é barrado pelo índice único parcial
  const existente = (await amb.sql("SELECT * FROM mc_registros WHERE item_id = $1 AND tipo = 'veiculo' AND status = 'EM_USO'", [ids.veiculo2])).rows[0];
  await assert.rejects(() => amb.sql(
    "INSERT INTO mc_registros (tipo, item_id, colaborador_id, registrado_por, foto_antes_id, assinatura_id, km_saida) VALUES ('veiculo', $1, $2, $3, $4, $5, 1)",
    [ids.veiculo2, ids.colaborador, idA, existente.assinatura_id, existente.assinatura_id]
  ), /mc_registros_item_em_uso|duplicate|duplicada/i);
});

test("foto antes é obrigatória, não pode ser reaproveitada e km de saída é exigido para veículo", async () => {
  const sem = await api("/registros", { method: "POST", corpo: { tipo: "veiculo", item_id: ids.veiculo3, colaborador_id: ids.colaborador, km_saida: 10 } });
  assert.equal(sem.status, 400);
  const usada = (await amb.sql("SELECT foto_antes_id FROM mc_registros LIMIT 1")).rows[0].foto_antes_id;
  assert.equal((await api("/registros", { method: "POST", corpo: { tipo: "veiculo", item_id: ids.veiculo3, colaborador_id: ids.colaborador, km_saida: 10, foto_antes: usada } })).status, 400);
  const fotoCadastro = await subir("veiculo");
  assert.equal((await api("/registros", { method: "POST", corpo: { tipo: "veiculo", item_id: ids.veiculo3, colaborador_id: ids.colaborador, km_saida: 10, foto_antes: fotoCadastro } })).status, 400, "foto de cadastro não serve como foto de registro");
  const semKm = await registrar({ item_id: ids.veiculo3, km_saida: undefined });
  assert.equal(semKm.status, 400);
  // Ferramenta não tem km
  const ferramenta = await registrar({ tipo: "ferramenta", item_id: ids.ferramenta, km_saida: undefined });
  assert.equal(ferramenta.status, 200, JSON.stringify(ferramenta.dados));
  assert.equal(ferramenta.dados.registro.km_saida, null);
  ids.registroFerramenta = ferramenta.dados.registro.id;
});

test("a assinatura do registro é uma cópia real: trocar a do cadastro depois não muda o registro", async () => {
  const { rows } = await amb.sql(
    `SELECT r.assinatura_id, r.assinatura_automatica, a.papel, a.entidade, a.storage_key, c.assinatura_id AS do_cadastro, ac.storage_key AS chave_cadastro
     FROM mc_registros r JOIN mc_arquivos a ON a.id = r.assinatura_id JOIN mc_colaboradores c ON c.id = r.colaborador_id JOIN mc_arquivos ac ON ac.id = c.assinatura_id
     WHERE r.id = $1`, [ids.registroAberto]);
  const r = rows[0];
  assert.notEqual(r.assinatura_id, r.do_cadastro, "o registro tem arquivo próprio");
  assert.notEqual(r.storage_key, r.chave_cadastro, "e objeto próprio no storage");
  assert.equal(r.papel, "assinatura_registro");
  assert.equal(r.entidade, "registro");
  assert.equal(r.assinatura_automatica, true);
  const shaAntes = await shaDoArquivo(r.assinatura_id);
  assert.equal(shaAntes, await shaDoArquivo(r.do_cadastro), "no momento do registro a cópia é idêntica");
  // Troca a assinatura do cadastro por outra imagem
  const nova = await subir("colaborador", { papel: "assinatura", corpo: PNG_2 });
  const troca = await api(`/colaboradores/${ids.colaborador}`, { method: "PATCH", corpo: { valores: { nome: "Ana Motorista", cargo: ids.cargo, assinatura: nova } } });
  assert.equal(troca.status, 200, JSON.stringify(troca.dados));
  const depois = (await amb.sql("SELECT assinatura_id FROM mc_registros WHERE id = $1", [ids.registroAberto])).rows[0];
  assert.equal(depois.assinatura_id, r.assinatura_id);
  assert.equal(await shaDoArquivo(depois.assinatura_id), shaAntes, "o registro guarda a assinatura do dia do registro");
  assert.notEqual(await shaDoArquivo(nova), shaAntes);
  // A auditoria diz que foi automática e quem registrou
  const { rows: aud } = await amb.sql("SELECT usuario_id, motivo, depois FROM mc_auditoria WHERE acao = 'registro.criar' AND entidade_id = $1", [String(ids.registroAberto)]);
  assert.equal(aud[0].usuario_id, idA);
  assert.match(aud[0].motivo, /aplicada automaticamente/);
  assert.equal(aud[0].depois.assinatura_automatica, true);
});

test("devolução: km de volta menor é recusado, diferença grande pede confirmação e o item é liberado", async () => {
  const id = ids.registroAberto;
  assert.equal((await api(`/registros/${id}/devolver`, { method: "POST", corpo: { km_volta: 1100 } })).status, 400, "foto depois obrigatória");
  const menor = await devolver(id, { km_volta: 999 });
  assert.equal(menor.status, 400);
  assert.match(menor.dados.error, /menor/);
  const alto = await devolver(id, { km_volta: 2001 });
  assert.equal(alto.status, 409);
  assert.equal(alto.dados.codigo, "KM_ALTO");
  assert.equal(alto.dados.diferenca, 1001);
  const confirmado = await devolver(id, { km_volta: 2001, confirmarKmAlto: true, observacao_devolucao: "Viagem para a outra unidade", devolvido_em: "2001-01-01T00:00:00Z" });
  assert.equal(confirmado.status, 200, JSON.stringify(confirmado.dados));
  assert.equal(confirmado.dados.registro.status, "DEVOLVIDO");
  assert.equal(confirmado.dados.registro.km_alto_confirmado, true);
  const { rows } = await amb.sql("SELECT abs(extract(epoch FROM (devolvido_em - now())))::int AS dif, devolvido_por FROM mc_registros WHERE id = $1", [id]);
  assert.ok(rows[0].dif < 60, "devolvido_em é a hora do servidor");
  assert.equal(rows[0].devolvido_por, idA);
  const { rows: aud } = await amb.sql("SELECT motivo, depois FROM mc_auditoria WHERE acao = 'registro.devolver' AND entidade_id = $1", [String(id)]);
  assert.match(aud[0].motivo, /confirmada/);
  assert.equal(aud[0].depois.km_alto_confirmado, true);
  // Devolver de novo é recusado; o item volta para a lista de disponíveis e aceita novo registro
  assert.equal((await devolver(id, { km_volta: 2100 })).status, 409);
  const livres = await api("/registros/disponiveis?tipo=veiculo");
  assert.ok(livres.dados.itens.some((i) => i.id === ids.veiculo));
  const novo = await registrar({ km_saida: 2001 });
  assert.equal(novo.status, 200);
  ids.registroNovo = novo.dados.registro.id;
  // O banco também barra km de volta menor que o de saída
  await assert.rejects(() => amb.sql("UPDATE mc_registros SET km_volta = 1 WHERE id = $1", [id]), /mc_registros_km_volta_minimo|check/i);
});

test("editar observação, foto e colaborador fica na auditoria com antes e depois", async () => {
  const id = ids.registroNovo;
  const foto = await subir("registro");
  const r = await api(`/registros/${id}`, { method: "PATCH", corpo: { observacao: "Saiu com tanque cheio", foto_antes: foto, colaborador_id: ids.colaborador2 } });
  assert.equal(r.status, 200, JSON.stringify(r.dados));
  assert.equal(r.dados.registro.colaborador.id, ids.colaborador2);
  const { rows } = await amb.sql("SELECT antes, depois, motivo FROM mc_auditoria WHERE acao = 'registro.editar' AND entidade_id = $1", [String(id)]);
  assert.equal(rows[0].antes.colaborador_id, ids.colaborador);
  assert.equal(rows[0].depois.colaborador_id, ids.colaborador2);
  assert.equal(rows[0].depois.observacao, "Saiu com tanque cheio");
  assert.ok(rows[0].depois.assinatura_id !== rows[0].antes.assinatura_id, "trocar o colaborador copia a assinatura do novo");
  assert.match(rows[0].motivo, /automaticamente/);
  // Devolução só é editável depois de registrada
  assert.equal((await api(`/registros/${id}`, { method: "PATCH", corpo: { observacao_devolucao: "x" } })).status, 409);
});

test("item em uso não pode ser desativado; a regra aguenta corrida com o registro", async () => {
  const desativar = await api(`/veiculos/${ids.veiculo}/ativo`, { method: "POST", corpo: { ativo: false } });
  assert.equal(desativar.status, 409);
  assert.match(desativar.dados.error, /em uso/);
  // Corrida: registrar e desativar o mesmo item ao mesmo tempo, várias vezes
  for (let rodada = 0; rodada < 4; rodada++) {
    const foto = await subir("registro");
    const [reg, des] = await Promise.all([
      api("/registros", { method: "POST", corpo: { tipo: "veiculo", item_id: ids.veiculo3, colaborador_id: ids.colaborador, km_saida: 10, foto_antes: foto } }),
      api(`/veiculos/${ids.veiculo3}/ativo`, { method: "POST", corpo: { ativo: false } })
    ]);
    const { rows } = await amb.sql(
      "SELECT v.ativo, (SELECT count(*)::int FROM mc_registros r WHERE r.tipo = 'veiculo' AND r.item_id = v.id AND r.status = 'EM_USO' AND r.excluido_em IS NULL) AS em_uso FROM mc_veiculos v WHERE v.id = $1",
      [ids.veiculo3]
    );
    assert.ok(!(rows[0].ativo === false && rows[0].em_uso > 0), `rodada ${rodada}: item desativado com registro em uso (${reg.status}/${des.status})`);
    // Volta ao estado inicial: devolve ou reativa
    if (reg.status === 200) assert.equal((await devolver(reg.dados.registro.id, { km_volta: 20 })).status, 200);
    if (!rows[0].ativo) assert.equal((await api(`/veiculos/${ids.veiculo3}/ativo`, { method: "POST", corpo: { ativo: true } })).status, 200);
  }
});

test("colaborador e item desativados somem da escolha e não entram em registro novo", async () => {
  assert.equal((await api(`/veiculos/${ids.veiculo3}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
  assert.equal((await api(`/colaboradores/${ids.colaborador2}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
  const livres = await api("/registros/disponiveis?tipo=veiculo");
  assert.ok(!livres.dados.itens.some((i) => i.id === ids.veiculo3));
  const pessoas = await api("/registros/colaboradores");
  assert.ok(!pessoas.dados.colaboradores.some((c) => c.id === ids.colaborador2));
  assert.equal((await registrar({ item_id: ids.veiculo3 })).status, 400);
  assert.equal((await registrar({ tipo: "ferramenta", item_id: ids.ferramenta, colaborador_id: ids.colaborador2, km_saida: undefined })).status, 400);
  // Registro antigo continua mostrando o colaborador desativado
  const antigo = await api(`/registros/${ids.registroNovo}`);
  assert.equal(antigo.dados.registro.colaborador.id, ids.colaborador2);
  await api(`/veiculos/${ids.veiculo3}/ativo`, { method: "POST", corpo: { ativo: true } });
  await api(`/colaboradores/${ids.colaborador2}/ativo`, { method: "POST", corpo: { ativo: true } });
});

test("cancelar exige motivo, libera o item e o registro continua visível como cancelado", async () => {
  const id = ids.registroFerramenta;
  assert.equal((await api(`/registros/${id}/cancelar`, { method: "POST", corpo: {} })).status, 400);
  assert.equal((await api(`/registros/${id}/cancelar`, { method: "POST", corpo: { motivo: "  " } })).status, 400);
  const r = await api(`/registros/${id}/cancelar`, { method: "POST", corpo: { motivo: "Registrado no item errado" } });
  assert.equal(r.status, 200);
  assert.equal(r.dados.registro.status, "CANCELADO");
  assert.equal(r.dados.registro.motivo_cancelamento, "Registrado no item errado");
  const livres = await api("/registros/disponiveis?tipo=ferramenta");
  assert.ok(livres.dados.itens.some((i) => i.id === ids.ferramenta), "item volta a ficar disponível");
  const historico = await api("/registros?status=CANCELADO");
  assert.ok(historico.dados.registros.some((reg) => reg.id === id));
  assert.equal((await api(`/registros/${id}/cancelar`, { method: "POST", corpo: { motivo: "de novo" } })).status, 409);
  assert.equal((await api(`/registros/${id}`, { method: "PATCH", corpo: { observacao: "x" } })).status, 409, "cancelado não é editado");
  const { rows } = await amb.sql("SELECT motivo FROM mc_auditoria WHERE acao = 'registro.cancelar' AND entidade_id = $1", [String(id)]);
  assert.equal(rows[0].motivo, "Registrado no item errado");
});

test("excluir é lógico, exige motivo, some das listas e fica na auditoria", async () => {
  const id = ids.registroNovo;
  assert.equal((await api(`/registros/${id}/excluir`, { method: "POST", corpo: { motivo: "" } })).status, 400);
  const r = await api(`/registros/${id}/excluir`, { method: "POST", corpo: { motivo: "Registro de teste feito por engano" } });
  assert.equal(r.status, 200);
  assert.equal((await api(`/registros/${id}`)).status, 404);
  assert.ok(!(await api("/registros")).dados.registros.some((reg) => reg.id === id));
  assert.ok(!(await api("/registros/em-uso")).dados.registros.some((reg) => reg.id === id));
  const { rows } = await amb.sql("SELECT excluido_em, excluido_por, motivo_exclusao FROM mc_registros WHERE id = $1", [id]);
  assert.ok(rows[0], "a linha continua no banco (nunca DELETE físico)");
  assert.ok(rows[0].excluido_em);
  assert.equal(rows[0].excluido_por, idA);
  assert.equal(rows[0].motivo_exclusao, "Registro de teste feito por engano");
  const { rows: aud } = await amb.sql("SELECT motivo, antes FROM mc_auditoria WHERE acao = 'registro.excluir' AND entidade_id = $1", [String(id)]);
  assert.equal(aud[0].motivo, "Registro de teste feito por engano");
  assert.ok(aud[0].antes.foto_antes_id);
  // Estava em uso: a exclusão libera o item
  assert.ok((await api("/registros/disponiveis?tipo=veiculo")).dados.itens.some((i) => i.id === ids.veiculo));
  // Excluído não volta a ser alterado
  assert.equal((await api(`/registros/${id}/cancelar`, { method: "POST", corpo: { motivo: "teste" } })).status, 404);
});

test("histórico é paginado e filtra por tipo, status, período e busca", async () => {
  const todos = await api("/registros");
  assert.equal(todos.status, 200);
  assert.equal(todos.dados.por_pagina, 30);
  assert.ok(todos.dados.total >= 3);
  const ferramentas = await api("/registros?tipo=ferramenta");
  assert.ok(ferramentas.dados.registros.every((r) => r.tipo === "ferramenta"));
  const hoje = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
  assert.ok((await api(`/registros?de=${hoje}&ate=${hoje}`)).dados.total >= 1);
  assert.equal((await api("/registros?de=2001-01-01&ate=2001-01-31")).dados.total, 0);
  const porPlaca = await api("/registros?q=abc1d23");
  assert.ok(porPlaca.dados.registros.length >= 1 && porPlaca.dados.registros.every((r) => r.item.secundario === "ABC1D23"));
  assert.ok((await api("/registros?q=%25")).status === 200, "% é texto, não curinga");
});

test("cada ação exige a própria permissão (403) e sessão (401)", async () => {
  const soRegistrar = await criarELogar("so.registrar", ["registro.registrar"]);
  const soVer = await criarELogar("so.cancelar", ["registro.cancelar"]);
  const foto = await subir("registro");
  const criado = await api("/registros", { method: "POST", cookie: soRegistrar.cookie, corpo: { tipo: "veiculo", item_id: ids.veiculo, colaborador_id: ids.colaborador, km_saida: 3000, foto_antes: foto } });
  assert.equal(criado.status, 200, JSON.stringify(criado.dados));
  const id = criado.dados.registro.id;
  const casos = [
    ["POST", `/registros/${id}/devolver`, { foto_depois: 1, km_volta: 3001 }],
    ["PATCH", `/registros/${id}`, { observacao: "x" }],
    ["POST", `/registros/${id}/cancelar`, { motivo: "sem permissão" }],
    ["POST", `/registros/${id}/excluir`, { motivo: "sem permissão" }]
  ];
  for (const [method, caminho, corpo] of casos) {
    assert.equal((await api(caminho, { method, cookie: soRegistrar.cookie, corpo })).status, 403, `${method} ${caminho} com só registrar`);
    assert.equal((await chamar(amb.base, `/api/mycontrol${caminho}`, { method, corpo })).status, 401, `${method} ${caminho} sem sessão`);
  }
  // Quem só cancela não registra nem escolhe item, mas vê listas e detalhe
  assert.equal((await registrar({}, soVer.cookie)).status, 403);
  assert.equal((await api("/registros/disponiveis?tipo=veiculo", { cookie: soVer.cookie })).status, 403);
  assert.equal((await api("/registros/em-uso", { cookie: soVer.cookie })).status, 200);
  assert.equal((await api(`/registros/${id}`, { cookie: soVer.cookie })).status, 200);
  // Sem nenhuma permissão de registro, nem as listas
  const nada = await criarELogar("so.veiculos", ["veiculo.gerenciar"]);
  for (const caminho of ["/registros", "/registros/em-uso", `/registros/${id}`, "/registros/colaboradores"]) {
    assert.equal((await api(caminho, { cookie: nada.cookie })).status, 403, caminho);
  }
  // Nada mudou pelas tentativas recusadas
  const { rows } = await amb.sql("SELECT status, observacao FROM mc_registros WHERE id = $1", [id]);
  assert.deepEqual(rows[0], { status: "EM_USO", observacao: null });
  ids.registroPermissao = id;
  ids.cookieSoRegistrar = soRegistrar.cookie;
  ids.cookieSoVeiculos = nada.cookie;
  ids.cookieSoCancelar = soVer.cookie;
});

test("fotos: quem registra vê as fotos dos cadastros e dos registros; quem só gerencia cadastro não vê as de registro", async () => {
  const registro = (await api(`/registros/${ids.registroPermissao}`)).dados.registro;
  const { rows } = await amb.sql("SELECT foto_id FROM mc_colaboradores WHERE id = $1", [ids.colaborador]);
  const fotoVeiculo = (await amb.sql("SELECT foto_id FROM mc_veiculos WHERE id = $1", [ids.veiculo])).rows[0].foto_id;
  const assinaturaCadastro = (await amb.sql("SELECT assinatura_id FROM mc_colaboradores WHERE id = $1", [ids.colaborador])).rows[0].assinatura_id;
  const ver = (id, cookie) => fetch(`${amb.base}/api/mycontrol/arquivos/${id}`, { headers: { Cookie: cookie } }).then((r) => r.status);
  for (const id of [fotoVeiculo, assinaturaCadastro, registro.foto_antes_id, registro.assinatura_id]) {
    assert.equal(await ver(id, ids.cookieSoRegistrar), 200, `quem registra deveria ver o arquivo ${id}`);
  }
  assert.equal(rows[0].foto_id, null);
  // Quem só gerencia veículos vê a foto do veículo, mas não as do registro nem a assinatura do colaborador
  assert.equal(await ver(fotoVeiculo, ids.cookieSoVeiculos), 200);
  assert.equal(await ver(registro.foto_antes_id, ids.cookieSoVeiculos), 403);
  assert.equal(await ver(registro.assinatura_id, ids.cookieSoVeiculos), 403);
  assert.equal(await ver(assinaturaCadastro, ids.cookieSoVeiculos), 403);
  // Quem só cancela vê as fotos do registro (abre o detalhe), mas não as dos cadastros
  assert.equal(await ver(registro.foto_antes_id, ids.cookieSoCancelar), 200);
  assert.equal(await ver(fotoVeiculo, ids.cookieSoCancelar), 403);
  // Registro só recebe foto: pedir papel de assinatura grava foto mesmo assim
  const r = await fetch(`${amb.base}/api/mycontrol/arquivos/registro?papel=assinatura`, { method: "POST", headers: { "Content-Type": "image/png", Cookie: ids.cookieSoRegistrar }, body: PNG });
  const { arquivo } = await r.json();
  assert.equal((await amb.sql("SELECT papel FROM mc_arquivos WHERE id = $1", [arquivo.id])).rows[0].papel, "foto");
  // Quem só gerencia veículos não envia foto de registro
  const negado = await fetch(`${amb.base}/api/mycontrol/arquivos/registro`, { method: "POST", headers: { "Content-Type": "image/png", Cookie: ids.cookieSoVeiculos }, body: PNG });
  assert.equal(negado.status, 403);
});

test("usuário com registros nunca é excluído: não há rota e o banco protege", async () => {
  const soRegistrarId = (await amb.sql("SELECT id FROM mc_usuarios WHERE usuario = 'so.registrar'")).rows[0].id;
  assert.equal((await api(`/usuarios/${soRegistrarId}`, { method: "DELETE" })).status, 404);
  await assert.rejects(() => amb.sql("DELETE FROM mc_usuarios WHERE id = $1", [soRegistrarId]), /foreign key|chave estrangeira|violates|viola/i);
  // Desativar continua possível
  assert.equal((await api(`/usuarios/${soRegistrarId}/ativo`, { method: "POST", corpo: { ativo: false } })).status, 200);
});

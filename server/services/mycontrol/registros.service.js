// Registros de uso e devolução (Fase 3 do MyControl): quem levou qual veículo ou ferramenta,
// quando, com que foto e assinatura, e a devolução.
//
// HORA: retirado_em, devolvido_em, cancelado_em e excluido_em são do SERVIDOR (now() do banco,
// TIMESTAMPTZ). Qualquer data mandada pelo navegador é ignorada. As tabelas antigas do MyEstoque
// usam timestamp sem fuso lido como texto (server/db.js); aqui é TIMESTAMPTZ de propósito, e a
// tela exibe em America/Sao_Paulo.
//
// Regras que moram no banco e não só aqui: um item não tem dois registros em uso (índice único
// parcial mc_registros_item_em_uso), km_volta >= km_saida e km_saida obrigatório para veículo.
import { tx } from "../../db.js";
import { normalizeText } from "../../utils/http.js";
import { formatarPlaca } from "./campos.service.js";
import { copiarAssinaturaParaRegistro } from "./arquivos.service.js";
import { registrarAuditoria } from "./mycontrol.schema.js";
import { erroMc } from "./usuarios.service.js";

// Acima desta diferença (km_volta - km_saida) a devolução pede confirmação em vez de gravar
// direto: provavelmente é erro de digitação (um zero a mais), mas pode ser uma viagem longa real
export const LIMITE_KM_ALTO = 1000;

// Maior quilometragem aceita (evita número absurdo por engano)
const KM_MAXIMO = 9_999_999;

// Itens por página do histórico
export const REGISTROS_POR_PAGINA = 30;

// Todas as permissões de registro: quem tem qualquer uma vê as listas e o detalhe
export const PERMISSOES_REGISTRO = Object.freeze(["registro.registrar", "registro.devolver", "registro.editar", "registro.cancelar", "registro.excluir"]);

// Tabela e colunas de cada tipo de item (lista fixa interna, nunca do cliente)
const TIPOS = {
  veiculo: { tabela: "mc_veiculos", rotulo: "Veículo" },
  ferramenta: { tabela: "mc_ferramentas", rotulo: "Ferramenta" }
};

// Tipo de item válido?
function exigirTipo(tipo) {
  if (!Object.prototype.hasOwnProperty.call(TIPOS, tipo)) throw erroMc(400, "Escolha se o registro é de veículo ou de ferramenta.");
  return tipo;
}

// Número inteiro positivo (id) ou erro com o rótulo
function exigirId(valor, rotulo) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw erroMc(400, `Escolha ${rotulo}.`);
  return id;
}

// Quilometragem: inteiro de 0 a KM_MAXIMO (aceita "12.345" digitado com ponto de milhar)
function exigirKm(valor, rotulo) {
  if (valor === null || valor === undefined || String(valor).trim() === "") throw erroMc(400, `Informe ${rotulo}.`);
  const km = typeof valor === "number" ? valor : Number(String(valor).trim().replace(/\./g, ""));
  if (!Number.isInteger(km) || km < 0 || km > KM_MAXIMO) throw erroMc(400, `${rotulo[0].toUpperCase()}${rotulo.slice(1)} deve ser um número inteiro de quilômetros.`);
  return km;
}

// Texto livre opcional (observação), até 1000 caracteres
function textoOpcional(valor) {
  const texto = normalizeText(valor, 1000);
  return texto || null;
}

// Motivo obrigatório (cancelar, excluir), de 3 a 500 caracteres
function exigirMotivo(valor, acao) {
  const motivo = normalizeText(valor, 500);
  if (motivo.length < 3) throw erroMc(400, `Informe o motivo para ${acao}.`);
  return motivo;
}

// Foto de registro já enviada (entidade "registro", papel "foto") e ainda não usada por outro
// registro. `atual` é a foto que o próprio registro já usa (editar sem trocar).
async function exigirFotoDeRegistro(client, valor, rotulo, atual = null) {
  const id = exigirId(valor, rotulo);
  if (id === atual) return id;
  const { rows } = await client.query("SELECT 1 FROM mc_arquivos WHERE id = $1 AND entidade = 'registro' AND papel = 'foto'", [id]);
  if (!rows[0]) throw erroMc(400, `${rotulo[0].toUpperCase()}${rotulo.slice(1)}: arquivo não encontrado. Tire a foto de novo.`);
  const { rows: usada } = await client.query("SELECT 1 FROM mc_registros WHERE foto_antes_id = $1 OR foto_depois_id = $1", [id]);
  if (usada[0]) throw erroMc(400, "Esta foto já pertence a outro registro. Tire uma foto nova.");
  return id;
}

// Colaborador ativo, travado para leitura até o fim da transação (desativar espera)
async function carregarColaboradorAtivo(client, id) {
  const { rows } = await client.query(
    "SELECT id, nome, matricula, assinatura_id FROM mc_colaboradores WHERE id = $1 AND ativo FOR SHARE",
    [id]
  );
  if (!rows[0]) throw erroMc(400, "Colaborador não encontrado ou desativado.");
  return rows[0];
}

// SELECT completo de um registro com item, colaborador, cargo e nomes de quem agiu
const SELECT_REGISTRO = `
  SELECT r.*,
         c.nome AS colaborador_nome, c.matricula, c.foto_id AS colaborador_foto_id,
         cg.nome AS cargo_nome, cg.abreviacao AS cargo_abreviacao,
         COALESCE(v.nome, f.nome) AS item_nome, v.placa, v.numero_chave, f.identificador,
         COALESCE(v.foto_id, f.foto_id) AS item_foto_id,
         ur.nome AS registrado_por_nome, ud.nome AS devolvido_por_nome,
         uc.nome AS cancelado_por_nome, ua.nome AS atualizado_por_nome
  FROM mc_registros r
  JOIN mc_colaboradores c ON c.id = r.colaborador_id
  JOIN mc_cargos cg ON cg.id = c.cargo_id
  LEFT JOIN mc_veiculos v ON r.tipo = 'veiculo' AND v.id = r.item_id
  LEFT JOIN mc_ferramentas f ON r.tipo = 'ferramenta' AND f.id = r.item_id
  LEFT JOIN mc_usuarios ur ON ur.id = r.registrado_por
  LEFT JOIN mc_usuarios ud ON ud.id = r.devolvido_por
  LEFT JOIN mc_usuarios uc ON uc.id = r.cancelado_por
  LEFT JOIN mc_usuarios ua ON ua.id = r.atualizado_por`;

// Registro no formato da tela (sem nada de exclusão: registro excluído não sai daqui)
function paraTela(linha) {
  return {
    id: linha.id,
    tipo: linha.tipo,
    status: linha.status,
    item: {
      id: linha.item_id,
      nome: linha.item_nome,
      foto_id: linha.item_foto_id,
      secundario: linha.tipo === "veiculo" ? formatarPlaca(linha.placa) : linha.identificador,
      numero_chave: linha.numero_chave || null
    },
    colaborador: {
      id: linha.colaborador_id,
      nome: linha.colaborador_nome,
      matricula: linha.matricula,
      foto_id: linha.colaborador_foto_id,
      cargo: { nome: linha.cargo_nome, abreviacao: linha.cargo_abreviacao }
    },
    retirado_em: linha.retirado_em,
    registrado_por: linha.registrado_por_nome,
    foto_antes_id: linha.foto_antes_id,
    assinatura_id: linha.assinatura_id,
    assinatura_automatica: linha.assinatura_automatica,
    observacao: linha.observacao,
    km_saida: linha.km_saida,
    devolvido_em: linha.devolvido_em,
    devolvido_por: linha.devolvido_por_nome,
    foto_depois_id: linha.foto_depois_id,
    observacao_devolucao: linha.observacao_devolucao,
    km_volta: linha.km_volta,
    km_alto_confirmado: linha.km_alto_confirmado,
    cancelado_em: linha.cancelado_em,
    cancelado_por: linha.cancelado_por_nome,
    motivo_cancelamento: linha.motivo_cancelamento,
    atualizado_em: linha.atualizado_em,
    atualizado_por: linha.atualizado_por_nome
  };
}

// Um registro para a tela; excluído é tratado como inexistente
export async function carregarRegistro(client, id) {
  const { rows } = await client.query(`${SELECT_REGISTRO} WHERE r.id = $1 AND r.excluido_em IS NULL`, [id]);
  if (!rows[0]) throw erroMc(404, "Registro não encontrado.");
  return paraTela(rows[0]);
}

// Trava a linha do registro para alterar; excluído é tratado como inexistente
async function travarRegistro(client, id) {
  const { rows } = await client.query("SELECT * FROM mc_registros WHERE id = $1 AND excluido_em IS NULL FOR UPDATE", [id]);
  if (!rows[0]) throw erroMc(404, "Registro não encontrado.");
  return rows[0];
}

// Retrato para a auditoria (só o que importa para saber o que mudou)
function retrato(linha) {
  return {
    tipo: linha.tipo,
    item_id: linha.item_id,
    colaborador_id: linha.colaborador_id,
    status: linha.status,
    foto_antes_id: linha.foto_antes_id,
    assinatura_id: linha.assinatura_id,
    observacao: linha.observacao,
    km_saida: linha.km_saida,
    foto_depois_id: linha.foto_depois_id,
    observacao_devolucao: linha.observacao_devolucao,
    km_volta: linha.km_volta
  };
}

// Escapa % e _ digitados na busca (viram texto, não curinga)
function padraoDeBusca(texto) {
  return `%${texto.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Itens ATIVOS e sem registro em uso, para a tela de registrar (busca por nome, placa, chave ou
// identificador). Item desativado ou em uso não aparece.
export async function listarDisponiveis(client, tipo, q = "") {
  exigirTipo(tipo);
  const busca = String(q || "").trim().slice(0, 80);
  const parametros = [tipo];
  let filtro = "";
  if (busca) {
    parametros.push(padraoDeBusca(busca));
    // Placa é gravada sem hífen: a busca também procura a versão sem hífen/espaço
    parametros.push(padraoDeBusca(busca.toUpperCase().replace(/[^A-Z0-9]/g, "")));
    filtro = tipo === "veiculo"
      ? "AND (t.nome ILIKE $2 OR t.numero_chave ILIKE $2 OR t.placa ILIKE $3)"
      : "AND (t.nome ILIKE $2 OR t.identificador ILIKE $2)";
  }
  const colunas = tipo === "veiculo" ? "t.placa, t.numero_chave" : "t.identificador";
  const { rows } = await client.query(
    `SELECT t.id, t.nome, t.foto_id, ${colunas}
     FROM ${TIPOS[tipo].tabela} t
     WHERE t.ativo
       AND NOT EXISTS (SELECT 1 FROM mc_registros r WHERE r.tipo = $1 AND r.item_id = t.id AND r.status = 'EM_USO' AND r.excluido_em IS NULL)
       ${filtro}
     ORDER BY lower(t.nome), t.id
     LIMIT 30`,
    parametros
  );
  return rows.map((linha) => ({
    id: linha.id,
    nome: linha.nome,
    foto_id: linha.foto_id,
    secundario: tipo === "veiculo" ? formatarPlaca(linha.placa) : linha.identificador,
    numero_chave: linha.numero_chave || null
  }));
}

// Colaboradores ATIVOS para a escolha (busca por nome ou matrícula), com cargo e assinatura
export async function listarColaboradoresParaRegistro(client, q = "") {
  const busca = String(q || "").trim().slice(0, 80);
  const parametros = [];
  let filtro = "";
  if (busca) {
    parametros.push(padraoDeBusca(busca));
    filtro = "AND (c.nome ILIKE $1 OR c.matricula ILIKE $1)";
  }
  const { rows } = await client.query(
    `SELECT c.id, c.nome, c.matricula, c.foto_id, c.assinatura_id, cg.nome AS cargo_nome, cg.abreviacao AS cargo_abreviacao
     FROM mc_colaboradores c JOIN mc_cargos cg ON cg.id = c.cargo_id
     WHERE c.ativo ${filtro}
     ORDER BY lower(c.nome), c.id
     LIMIT 30`,
    parametros
  );
  return rows.map((linha) => ({
    id: linha.id,
    nome: linha.nome,
    matricula: linha.matricula,
    foto_id: linha.foto_id,
    assinatura_id: linha.assinatura_id,
    cargo: { nome: linha.cargo_nome, abreviacao: linha.cargo_abreviacao }
  }));
}

// Registra a retirada. A hora é do servidor; a assinatura do cadastro é copiada automaticamente.
export async function criarRegistro(ator, corpo = {}) {
  const tipo = exigirTipo(corpo.tipo);
  const itemId = exigirId(corpo.item_id, "o item");
  const colaboradorId = exigirId(corpo.colaborador_id, "o colaborador");
  const kmSaida = tipo === "veiculo" ? exigirKm(corpo.km_saida, "a quilometragem de saída") : null;
  const observacao = textoOpcional(corpo.observacao);
  try {
    return await tx(async (client) => {
      // FOR SHARE no item: quem tentar desativá-lo agora espera este registro terminar
      const { rows: item } = await client.query(`SELECT id, nome FROM ${TIPOS[tipo].tabela} WHERE id = $1 AND ativo FOR SHARE`, [itemId]);
      if (!item[0]) throw erroMc(400, `${TIPOS[tipo].rotulo} não encontrado ou desativado.`);
      const colaborador = await carregarColaboradorAtivo(client, colaboradorId);
      const fotoAntes = await exigirFotoDeRegistro(client, corpo.foto_antes, "a foto de antes");
      const assinaturaId = await copiarAssinaturaParaRegistro(client, { ator, assinaturaId: colaborador.assinatura_id });
      const { rows } = await client.query(
        `INSERT INTO mc_registros (tipo, item_id, colaborador_id, registrado_por, foto_antes_id, assinatura_id, assinatura_automatica, observacao, km_saida)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8)
         RETURNING *`,
        [tipo, itemId, colaboradorId, ator.id, fotoAntes, assinaturaId, observacao, kmSaida]
      );
      await registrarAuditoria(client, {
        ator,
        acao: "registro.criar",
        entidade: "registro",
        entidadeId: rows[0].id,
        depois: { ...retrato(rows[0]), retirado_em: rows[0].retirado_em, assinatura_automatica: true, registrado_por: ator.id },
        motivo: "Assinatura do cadastro aplicada automaticamente"
      });
      return carregarRegistro(client, rows[0].id);
    });
  } catch (erro) {
    // Índice único parcial: outro registro em uso para o mesmo item (inclusive envio simultâneo)
    if (erro.code === "23505" && erro.constraint === "mc_registros_item_em_uso") {
      throw erroMc(409, "Este item já está em uso. Registre a devolução antes de uma nova retirada.");
    }
    throw erro;
  }
}

// Devolve: fecha o registro com a hora do servidor, foto depois e observação. Veículo exige
// km_volta >= km_saida; diferença acima de LIMITE_KM_ALTO pede confirmação (409 KM_ALTO).
export async function devolverRegistro(ator, id, corpo = {}) {
  return tx(async (client) => {
    const atual = await travarRegistro(client, id);
    if (atual.status !== "EM_USO") throw erroMc(409, "Só um registro em uso pode ser devolvido.");
    let kmVolta = null;
    let kmAltoConfirmado = false;
    if (atual.tipo === "veiculo") {
      kmVolta = exigirKm(corpo.km_volta, "a quilometragem de volta");
      if (kmVolta < atual.km_saida) {
        throw erroMc(400, `A quilometragem de volta (${kmVolta}) não pode ser menor que a de saída (${atual.km_saida}).`);
      }
      const diferenca = kmVolta - atual.km_saida;
      if (diferenca > LIMITE_KM_ALTO) {
        if (corpo.confirmarKmAlto !== true) {
          throw erroMc(409, `Foram rodados ${diferenca} km neste uso. Confira a quilometragem e confirme se está certa.`, { codigo: "KM_ALTO", diferenca, limite: LIMITE_KM_ALTO });
        }
        kmAltoConfirmado = true;
      }
    }
    const fotoDepois = await exigirFotoDeRegistro(client, corpo.foto_depois, "a foto de depois");
    const observacaoDevolucao = textoOpcional(corpo.observacao_devolucao);
    const { rows } = await client.query(
      `UPDATE mc_registros
       SET status = 'DEVOLVIDO', devolvido_em = now(), devolvido_por = $2, foto_depois_id = $3,
           observacao_devolucao = $4, km_volta = $5, km_alto_confirmado = $6
       WHERE id = $1 RETURNING *`,
      [id, ator.id, fotoDepois, observacaoDevolucao, kmVolta, kmAltoConfirmado]
    );
    await registrarAuditoria(client, {
      ator,
      acao: "registro.devolver",
      entidade: "registro",
      entidadeId: id,
      antes: retrato(atual),
      depois: { ...retrato(rows[0]), devolvido_em: rows[0].devolvido_em, km_alto_confirmado: kmAltoConfirmado },
      motivo: kmAltoConfirmado ? `Quilometragem alta confirmada pelo usuário (${kmVolta - atual.km_saida} km)` : null
    });
    return carregarRegistro(client, id);
  });
}

// Edita observação, fotos e colaborador (com auditoria de antes e depois). Trocar o colaborador
// copia a assinatura do novo colaborador, de novo automaticamente.
export async function editarRegistro(ator, id, corpo = {}) {
  return tx(async (client) => {
    const atual = await travarRegistro(client, id);
    if (atual.status === "CANCELADO") throw erroMc(409, "Registro cancelado não pode ser editado.");
    const mudancas = {};
    if (corpo.observacao !== undefined) mudancas.observacao = textoOpcional(corpo.observacao);
    if (corpo.foto_antes !== undefined) mudancas.foto_antes_id = await exigirFotoDeRegistro(client, corpo.foto_antes, "a foto de antes", atual.foto_antes_id);
    if (corpo.observacao_devolucao !== undefined || corpo.foto_depois !== undefined) {
      if (atual.status !== "DEVOLVIDO") throw erroMc(409, "A devolução só pode ser editada depois de registrada.");
      if (corpo.observacao_devolucao !== undefined) mudancas.observacao_devolucao = textoOpcional(corpo.observacao_devolucao);
      if (corpo.foto_depois !== undefined) mudancas.foto_depois_id = await exigirFotoDeRegistro(client, corpo.foto_depois, "a foto de depois", atual.foto_depois_id);
    }
    let motivo = null;
    if (corpo.colaborador_id !== undefined) {
      const colaboradorId = exigirId(corpo.colaborador_id, "o colaborador");
      if (colaboradorId !== atual.colaborador_id) {
        const colaborador = await carregarColaboradorAtivo(client, colaboradorId);
        mudancas.colaborador_id = colaboradorId;
        mudancas.assinatura_id = await copiarAssinaturaParaRegistro(client, { ator, assinaturaId: colaborador.assinatura_id });
        mudancas.assinatura_automatica = true;
        motivo = "Colaborador trocado: assinatura do novo cadastro aplicada automaticamente";
      }
    }
    const nomes = Object.keys(mudancas).filter((nome) => mudancas[nome] !== atual[nome]);
    if (!nomes.length) return carregarRegistro(client, id);
    const { rows } = await client.query(
      `UPDATE mc_registros SET ${nomes.map((nome, i) => `${nome} = $${i + 2}`).join(", ")}, atualizado_em = now(), atualizado_por = $${nomes.length + 2}
       WHERE id = $1 RETURNING *`,
      [id, ...nomes.map((nome) => mudancas[nome]), ator.id]
    );
    const antes = {};
    const depois = {};
    for (const nome of nomes) {
      antes[nome] = atual[nome];
      depois[nome] = rows[0][nome];
    }
    await registrarAuditoria(client, { ator, acao: "registro.editar", entidade: "registro", entidadeId: id, antes, depois, motivo });
    return carregarRegistro(client, id);
  });
}

// Cancela com motivo: o item volta a ficar disponível e o registro continua visível como cancelado
export async function cancelarRegistro(ator, id, corpo = {}) {
  const motivo = exigirMotivo(corpo.motivo, "cancelar");
  return tx(async (client) => {
    const atual = await travarRegistro(client, id);
    if (atual.status === "CANCELADO") throw erroMc(409, "Este registro já está cancelado.");
    const { rows } = await client.query(
      `UPDATE mc_registros SET status = 'CANCELADO', cancelado_em = now(), cancelado_por = $2, motivo_cancelamento = $3
       WHERE id = $1 RETURNING *`,
      [id, ator.id, motivo]
    );
    await registrarAuditoria(client, { ator, acao: "registro.cancelar", entidade: "registro", entidadeId: id, antes: retrato(atual), depois: retrato(rows[0]), motivo });
    return carregarRegistro(client, id);
  });
}

// Exclusão LÓGICA com motivo: some das listas (e do dashboard da Fase 4), mas a linha continua no
// banco e a auditoria guarda tudo. Nunca DELETE físico.
export async function excluirRegistro(ator, id, corpo = {}) {
  const motivo = exigirMotivo(corpo.motivo, "excluir");
  return tx(async (client) => {
    const atual = await travarRegistro(client, id);
    await client.query("UPDATE mc_registros SET excluido_em = now(), excluido_por = $2, motivo_exclusao = $3 WHERE id = $1", [id, ator.id, motivo]);
    await registrarAuditoria(client, { ator, acao: "registro.excluir", entidade: "registro", entidadeId: id, antes: retrato(atual), motivo });
    return { id };
  });
}

// Registros em uso agora (mais antigos primeiro: quem está há mais tempo com o item aparece antes)
export async function listarEmUso(client) {
  const { rows } = await client.query(`${SELECT_REGISTRO} WHERE r.status = 'EM_USO' AND r.excluido_em IS NULL ORDER BY r.retirado_em, r.id`);
  return rows.map(paraTela);
}

// Data AAAA-MM-DD válida ou null
function dataOuNula(valor) {
  const texto = String(valor || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const data = new Date(`${texto}T00:00:00Z`);
  return Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== texto ? null : texto;
}

// Histórico paginado com filtros simples (tipo, status, período e busca). Cancelados aparecem;
// excluídos não. O período é comparado no dia de Brasília, não no UTC.
export async function listarHistorico(client, { tipo = "", status = "", de = "", ate = "", q = "", pagina = 1 } = {}) {
  const condicoes = ["r.excluido_em IS NULL"];
  const parametros = [];
  // Adiciona um parâmetro e devolve o marcador $n
  const param = (valor) => {
    parametros.push(valor);
    return `$${parametros.length}`;
  };
  if (TIPOS[tipo]) condicoes.push(`r.tipo = ${param(tipo)}`);
  if (["EM_USO", "DEVOLVIDO", "CANCELADO"].includes(status)) condicoes.push(`r.status = ${param(status)}`);
  const dataDe = dataOuNula(de);
  const dataAte = dataOuNula(ate);
  if (dataDe) condicoes.push(`(r.retirado_em AT TIME ZONE 'America/Sao_Paulo')::date >= ${param(dataDe)}::date`);
  if (dataAte) condicoes.push(`(r.retirado_em AT TIME ZONE 'America/Sao_Paulo')::date <= ${param(dataAte)}::date`);
  const busca = String(q || "").trim().slice(0, 80);
  if (busca) {
    const p = param(padraoDeBusca(busca));
    const placa = param(padraoDeBusca(busca.toUpperCase().replace(/[^A-Z0-9]/g, "") || busca));
    condicoes.push(`(c.nome ILIKE ${p} OR c.matricula ILIKE ${p} OR COALESCE(v.nome, f.nome) ILIKE ${p} OR v.numero_chave ILIKE ${p} OR f.identificador ILIKE ${p} OR v.placa ILIKE ${placa})`);
  }
  const onde = `WHERE ${condicoes.join(" AND ")}`;
  const paginaSegura = Math.max(1, Math.min(10_000, Number.parseInt(pagina, 10) || 1));
  const { rows: total } = await client.query(`SELECT count(*)::int AS n FROM (${SELECT_REGISTRO} ${onde}) x`, parametros);
  const { rows } = await client.query(
    `${SELECT_REGISTRO} ${onde} ORDER BY r.retirado_em DESC, r.id DESC LIMIT ${REGISTROS_POR_PAGINA} OFFSET ${(paginaSegura - 1) * REGISTROS_POR_PAGINA}`,
    parametros
  );
  return { registros: rows.map(paraTela), total: total[0].n, pagina: paginaSegura, por_pagina: REGISTROS_POR_PAGINA };
}

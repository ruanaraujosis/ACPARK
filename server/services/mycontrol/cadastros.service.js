// Cadastros do MyControl: colaboradores, veículos e ferramentas, com o mesmo fluxo para os três.
//
// Onde cada valor mora segue a regra única de campos.catalogo.js: campo do sistema -> coluna;
// campo do usuário -> `dados` JSONB. A validação (obrigatório, tipo, chave desconhecida) é
// sempre no servidor, contra os campos ativos (campos.service.js).
//
// MATRÍCULA (só colaborador): ABREV-000123, com a abreviação do cargo e o número da sequence
// única mc_matricula_seq, gerada aqui no servidor na MESMA transação do INSERT. Nunca vem do
// cliente, nunca é reaproveitada, não muda ao trocar de cargo e não é editável (a API recusa e
// um gatilho no banco barra até UPDATE direto).
import { tx } from "../../db.js";
import { ENTIDADES } from "./campos.catalogo.js";
import { exigirEntidade, formatarPlaca, listarCampos, pendenciasDoCadastro, validarValores } from "./campos.service.js";
import { registrarAuditoria } from "./mycontrol.schema.js";
import { erroMc } from "./usuarios.service.js";

// Itens por página nas listas (lista grande é carregada aos poucos)
export const ITENS_POR_PAGINA = 30;

// Colunas que a busca de texto consulta em cada entidade (lista fixa interna, nunca do cliente)
const COLUNAS_DE_BUSCA = {
  colaborador: ["t.nome", "t.matricula"],
  veiculo: ["t.nome", "t.placa", "t.numero_chave"],
  ferramenta: ["t.nome", "t.identificador"]
};

// Mensagens para as violações de unicidade dos cadastros e cargos (nome da constraint -> texto)
export const MENSAGENS_CONFLITO = Object.freeze({
  mc_veiculos_chave_ativa: "Já existe um veículo ativo com esse número de chave.",
  mc_veiculos_placa_ativa: "Já existe um veículo ativo com essa placa.",
  mc_ferramentas_identificador_key: "Já existe uma ferramenta com esse identificador.",
  mc_cargos_abreviacao_key: "Já existe um cargo com essa abreviação.",
  mc_cargos_nome_unico: "Já existe um cargo com esse nome.",
  mc_usuarios_usuario_key: "Já existe um usuário com esse login."
});

// Linha do banco -> valores por chave de campo (colunas do sistema + `dados` do usuário)
function valoresDaLinha(campos, linha) {
  const valores = {};
  for (const campo of campos) {
    valores[campo.chave] = campo.coluna ? (linha[campo.coluna] ?? null) : (linha.dados?.[campo.chave] ?? null);
  }
  return valores;
}

// Item como a tela recebe: valores, extras de exibição e pendências de campos obrigatórios
function itemParaTela(entidade, campos, linha) {
  const valores = valoresDaLinha(campos, linha);
  const item = {
    id: linha.id,
    ativo: linha.ativo,
    valores,
    foto_id: linha.foto_id ?? null,
    pendencias: pendenciasDoCadastro(campos, valores),
    criado_em: linha.criado_em,
    atualizado_em: linha.atualizado_em
  };
  if (entidade === "colaborador") {
    item.matricula = linha.matricula;
    item.cargo = { id: linha.cargo_id, nome: linha.cargo_nome, abreviacao: linha.cargo_abreviacao, ativo: linha.cargo_ativo };
  }
  if (entidade === "veiculo") item.placa_formatada = formatarPlaca(linha.placa);
  return item;
}

// SELECT base de cada entidade (colaborador traz o cargo junto)
function selectBase(entidade) {
  const { tabela } = ENTIDADES[entidade];
  if (entidade === "colaborador") {
    return `SELECT t.*, c.nome AS cargo_nome, c.abreviacao AS cargo_abreviacao, c.ativo AS cargo_ativo
            FROM ${tabela} t JOIN mc_cargos c ON c.id = t.cargo_id`;
  }
  return `SELECT t.* FROM ${tabela} t`;
}

// Lista paginada com busca e filtro de situação (ativos, inativos ou todos)
export async function listarCadastros(client, entidade, { q = "", situacao = "ativos", pagina = 1 } = {}) {
  exigirEntidade(entidade);
  const campos = await listarCampos(client, entidade);
  const condicoes = [];
  const parametros = [];
  if (situacao === "ativos") condicoes.push("t.ativo");
  else if (situacao === "inativos") condicoes.push("NOT t.ativo");
  const busca = String(q || "").trim().slice(0, 80);
  if (busca) {
    // % e _ digitados são texto, não curinga
    parametros.push(`%${busca.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    condicoes.push(`(${COLUNAS_DE_BUSCA[entidade].map((coluna) => `${coluna} ILIKE $${parametros.length}`).join(" OR ")})`);
  }
  const onde = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";
  const paginaSegura = Math.max(1, Math.min(10_000, Number.parseInt(pagina, 10) || 1));
  const { rows: total } = await client.query(`SELECT count(*)::int AS n FROM (${selectBase(entidade)} ${onde}) x`, parametros);
  const { rows } = await client.query(
    `${selectBase(entidade)} ${onde} ORDER BY t.ativo DESC, lower(t.nome), t.id LIMIT ${ITENS_POR_PAGINA} OFFSET ${(paginaSegura - 1) * ITENS_POR_PAGINA}`,
    parametros
  );
  return {
    itens: rows.map((linha) => itemParaTela(entidade, campos, linha)),
    campos,
    total: total[0].n,
    pagina: paginaSegura,
    por_pagina: ITENS_POR_PAGINA
  };
}

// Carrega um cadastro travando a linha (para editar)
async function carregarParaEditar(client, entidade, id) {
  const { tabela } = ENTIDADES[entidade];
  const { rows } = await client.query(`SELECT * FROM ${tabela} WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw erroMc(404, `${ENTIDADES[entidade].singular} não encontrado.`);
  return rows[0];
}

// Carrega um cadastro já no formato da tela
async function carregarParaTela(client, entidade, id, campos) {
  const { rows } = await client.query(`${selectBase(entidade)} WHERE t.id = $1`, [id]);
  return itemParaTela(entidade, campos, rows[0]);
}

// Diferença campo a campo para a auditoria (só o que mudou)
function diferencas(antes, depois) {
  const a = {};
  const d = {};
  for (const chave of new Set([...Object.keys(antes), ...Object.keys(depois)])) {
    if (JSON.stringify(antes[chave] ?? null) !== JSON.stringify(depois[chave] ?? null)) {
      a[chave] = antes[chave] ?? null;
      d[chave] = depois[chave] ?? null;
    }
  }
  return { antes: a, depois: d, mudou: Object.keys(d).length > 0 };
}

// Junta os `dados` validados com os que já existem: null apaga a chave; chaves de campos
// excluídos (fora da lista validada) ficam como estavam
function juntarDados(existentes, validados) {
  const resultado = { ...(existentes || {}) };
  for (const [chave, valor] of Object.entries(validados)) {
    if (valor === null) delete resultado[chave];
    else resultado[chave] = valor;
  }
  return resultado;
}

// Cria um cadastro; colaborador ganha a matrícula aqui, na mesma transação
export async function criarCadastro(ator, entidade, corpo) {
  exigirEntidade(entidade);
  return tx(async (client) => {
    const campos = await listarCampos(client, entidade);
    const { colunas, dados } = await validarValores(client, { entidade, campos, entrada: corpo?.valores, atual: null });
    const registro = { ...colunas, dados: juntarDados({}, dados), criado_por: ator.id };

    if (entidade === "colaborador") {
      // FOR SHARE: a abreviação não muda (nem o cargo é excluído) no meio desta transação
      const { rows: cargo } = await client.query("SELECT abreviacao FROM mc_cargos WHERE id = $1 AND ativo FOR SHARE", [colunas.cargo_id]);
      if (!cargo[0]) throw erroMc(400, "Cargo: este cargo está desativado.");
      const { rows: seq } = await client.query("SELECT nextval('mc_matricula_seq') AS n");
      registro.matricula_numero = seq[0].n;
      registro.matricula = `${cargo[0].abreviacao}-${String(seq[0].n).padStart(6, "0")}`;
    }

    const nomes = Object.keys(registro);
    const { rows } = await client.query(
      `INSERT INTO ${ENTIDADES[entidade].tabela} (${nomes.join(", ")})
       VALUES (${nomes.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      nomes.map((nome) => (nome === "dados" ? JSON.stringify(registro[nome]) : registro[nome]))
    );
    const item = await carregarParaTela(client, entidade, rows[0].id, campos);
    await registrarAuditoria(client, {
      ator,
      acao: `${entidade}.criar`,
      entidade,
      entidadeId: item.id,
      depois: { ...item.valores, ...(item.matricula ? { matricula: item.matricula } : {}) }
    });
    return item;
  });
}

// Edita um cadastro. A matrícula nunca muda (inclusive ao trocar de cargo).
export async function editarCadastro(ator, entidade, id, corpo) {
  exigirEntidade(entidade);
  return tx(async (client) => {
    const campos = await listarCampos(client, entidade);
    const linha = await carregarParaEditar(client, entidade, id);
    const valoresAntes = valoresDaLinha(campos, linha);
    const { colunas, dados } = await validarValores(client, { entidade, campos, entrada: corpo?.valores, atual: valoresAntes });
    const registro = { ...colunas, dados: juntarDados(linha.dados, dados), atualizado_por: ator.id };
    const nomes = Object.keys(registro);
    await client.query(
      `UPDATE ${ENTIDADES[entidade].tabela}
       SET ${nomes.map((nome, i) => `${nome} = $${i + 2}`).join(", ")}, atualizado_em = now()
       WHERE id = $1`,
      [id, ...nomes.map((nome) => (nome === "dados" ? JSON.stringify(registro[nome]) : registro[nome]))]
    );
    const item = await carregarParaTela(client, entidade, id, campos);
    const diff = diferencas(valoresAntes, item.valores);
    if (diff.mudou) {
      await registrarAuditoria(client, { ator, acao: `${entidade}.editar`, entidade, entidadeId: id, antes: diff.antes, depois: diff.depois });
    }
    return item;
  });
}

// Desativa ou reativa. Não existe exclusão física: os registros da Fase 3 vão apontar para cá.
export async function alterarAtivoCadastro(ator, entidade, id, ativo) {
  exigirEntidade(entidade);
  if (typeof ativo !== "boolean") throw erroMc(400, "Informe se o cadastro fica ativo ou não.");
  return tx(async (client) => {
    const campos = await listarCampos(client, entidade);
    const linha = await carregarParaEditar(client, entidade, id);
    // Item em uso não é desativado antes de devolvido. A linha já está travada (FOR UPDATE) e o
    // registro de uso trava a mesma linha (FOR SHARE), então os dois nunca passam juntos.
    if (!ativo && linha.ativo && entidade !== "colaborador") {
      const { rows: emUso } = await client.query(
        "SELECT 1 FROM mc_registros WHERE tipo = $1 AND item_id = $2 AND status = 'EM_USO' AND excluido_em IS NULL LIMIT 1",
        [entidade, id]
      );
      if (emUso[0]) throw erroMc(409, "Este item está em uso. Registre a devolução antes de desativá-lo.");
    }
    if (linha.ativo !== ativo) {
      await client.query(`UPDATE ${ENTIDADES[entidade].tabela} SET ativo = $2, atualizado_em = now(), atualizado_por = $3 WHERE id = $1`, [id, ativo, ator.id]);
      await registrarAuditoria(client, { ator, acao: `${entidade}.${ativo ? "reativar" : "desativar"}`, entidade, entidadeId: id, antes: { ativo: linha.ativo }, depois: { ativo } });
    }
    return carregarParaTela(client, entidade, id, campos);
  });
}

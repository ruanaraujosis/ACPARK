// Cargos do MyControl (Configurações > Cargos). A abreviação vira o prefixo da matrícula
// (ABREV-000123) no momento em que o colaborador é criado; trocar a abreviação depois NÃO muda
// as matrículas já geradas. Cargo em uso não é excluído, só desativado.
import { tx } from "../../db.js";
import { normalizeText } from "../../utils/http.js";
import { registrarAuditoria } from "./mycontrol.schema.js";
import { erroMc } from "./usuarios.service.js";

// Nome obrigatório, até 60 caracteres
function normalizarNome(valor) {
  const nome = normalizeText(valor, 60);
  if (!nome) throw erroMc(400, "Informe o nome do cargo.");
  return nome;
}

// Abreviação: 2 a 6 letras (sem acento nem número), gravada em maiúsculas
function normalizarAbreviacao(valor) {
  const abreviacao = String(valor || "").trim().toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(abreviacao)) throw erroMc(400, "A abreviação deve ter de 2 a 6 letras, sem acento, número ou espaço.");
  return abreviacao;
}

// Retrato do cargo para a auditoria
function retrato(cargo) {
  return { nome: cargo.nome, abreviacao: cargo.abreviacao, ativo: cargo.ativo };
}

// Lista cargos com quantos colaboradores usam cada um (para decidir entre excluir e desativar)
export async function listarCargos(client) {
  const { rows } = await client.query(
    `SELECT c.id, c.nome, c.abreviacao, c.ativo, c.criado_em,
            (SELECT count(*)::int FROM mc_colaboradores col WHERE col.cargo_id = c.id) AS em_uso
     FROM mc_cargos c
     ORDER BY c.ativo DESC, c.nome`
  );
  return rows;
}

// Carrega um cargo travando a linha
async function carregarCargo(client, id) {
  const { rows } = await client.query("SELECT * FROM mc_cargos WHERE id = $1 FOR UPDATE", [id]);
  if (!rows[0]) throw erroMc(404, "Cargo não encontrado.");
  return rows[0];
}

// Cria um cargo
export async function criarCargo(ator, dados) {
  const nome = normalizarNome(dados.nome);
  const abreviacao = normalizarAbreviacao(dados.abreviacao);
  return tx(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO mc_cargos (nome, abreviacao, criado_por) VALUES ($1, $2, $3) RETURNING id, nome, abreviacao, ativo",
      [nome, abreviacao, ator.id]
    );
    await registrarAuditoria(client, { ator, acao: "cargo.criar", entidade: "cargo", entidadeId: rows[0].id, depois: retrato(rows[0]) });
    return rows[0];
  });
}

// Edita nome e abreviação (as matrículas já geradas continuam com a abreviação antiga)
export async function editarCargo(ator, id, dados) {
  const nome = normalizarNome(dados.nome);
  const abreviacao = normalizarAbreviacao(dados.abreviacao);
  return tx(async (client) => {
    const atual = await carregarCargo(client, id);
    const { rows } = await client.query(
      "UPDATE mc_cargos SET nome = $2, abreviacao = $3, atualizado_em = now() WHERE id = $1 RETURNING id, nome, abreviacao, ativo",
      [id, nome, abreviacao]
    );
    await registrarAuditoria(client, {
      ator,
      acao: "cargo.editar",
      entidade: "cargo",
      entidadeId: id,
      antes: retrato(atual),
      depois: retrato(rows[0]),
      motivo: atual.abreviacao !== abreviacao ? "Abreviação alterada: matrículas já geradas não mudam" : null
    });
    return { ...rows[0], abreviacao_mudou: atual.abreviacao !== abreviacao };
  });
}

// Desativa ou reativa (cargo desativado não aparece para colaboradores novos)
export async function alterarAtivoCargo(ator, id, ativo) {
  if (typeof ativo !== "boolean") throw erroMc(400, "Informe se o cargo fica ativo ou não.");
  return tx(async (client) => {
    const atual = await carregarCargo(client, id);
    const { rows } = await client.query("UPDATE mc_cargos SET ativo = $2, atualizado_em = now() WHERE id = $1 RETURNING id, nome, abreviacao, ativo", [id, ativo]);
    await registrarAuditoria(client, { ator, acao: ativo ? "cargo.reativar" : "cargo.desativar", entidade: "cargo", entidadeId: id, antes: { ativo: atual.ativo }, depois: { ativo } });
    return rows[0];
  });
}

// Exclui um cargo que nunca foi usado. Em uso (mesmo por colaborador desativado): recusa e
// orienta a desativar. A linha está travada, então ninguém o atribui no meio da checagem
// (a FK ON DELETE RESTRICT é a segunda barreira).
export async function excluirCargo(ator, id) {
  return tx(async (client) => {
    const atual = await carregarCargo(client, id);
    const { rows } = await client.query("SELECT count(*)::int AS n FROM mc_colaboradores WHERE cargo_id = $1", [id]);
    if (rows[0].n > 0) throw erroMc(409, "Este cargo está em uso por colaboradores e não pode ser excluído. Desative-o.");
    await client.query("DELETE FROM mc_cargos WHERE id = $1", [id]);
    await registrarAuditoria(client, { ator, acao: "cargo.excluir", entidade: "cargo", entidadeId: id, antes: retrato(atual) });
    return { id };
  });
}

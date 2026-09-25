// Regras de negócio dos usuários do MyControl: assistente de primeiro uso, criação, edição,
// redefinição de senha e desativação -- sempre em transação e com auditoria em mc_auditoria.
//
// CONCORRÊNCIA: toda operação que muda usuários pega o mesmo advisory lock de transação
// (pg_advisory_xact_lock). Com isso duas chamadas simultâneas nunca leem o mesmo "estado
// antes": não nascem dois "primeiros" usuários, e dois gestores não conseguem tirar a
// permissão um do outro ao mesmo tempo e deixar o sistema sem ninguém que gerencie usuários.
import { hashPassword, tx } from "../../db.js";
import { normalizeText } from "../../utils/http.js";
import { registrarAuditoria } from "./mycontrol.schema.js";
import { PERMISSAO_GERENCIAR_USUARIOS, TODAS_PERMISSOES, validarPermissoes } from "./permissoes.js";

// Tamanho mínimo de senha do MyControl (o MyEstoque usa 4; aqui é maior de propósito)
export const SENHA_MINIMA = 6;

// Colunas devolvidas ao cliente: nunca inclui o hash da senha
const COLUNAS_PUBLICAS = "id, usuario, nome, permissoes, ativo, criado_em, criado_por, ultimo_login_em";

// Erro com status HTTP e mensagem em português, tratado pelas rotas. `extras` vai junto na
// resposta (ex.: { codigo: "KM_ALTO" } para a tela pedir confirmação em vez de só mostrar o erro)
export function erroMc(statusCode, mensagem, extras = null) {
  const erro = new Error(mensagem);
  erro.statusCode = statusCode;
  erro.mensagemUsuario = mensagem;
  erro.extras = extras;
  return erro;
}

// Serializa todas as mudanças de usuários do MyControl (ver comentário do topo)
async function travarUsuarios(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('mycontrol:usuarios'))");
}

// Login: minúsculo, sem espaços, só letras, números, ponto, hífen e sublinhado
export function normalizarLogin(valor) {
  const login = String(valor || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(login)) {
    throw erroMc(400, "Usuário deve ter de 3 a 40 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.");
  }
  return login;
}

// Nome de exibição obrigatório
function normalizarNome(valor) {
  const nome = normalizeText(valor, 120);
  if (!nome) throw erroMc(400, "Informe o nome do usuário.");
  return nome;
}

// Senha com tamanho mínimo e confirmação idêntica
function validarSenha(senhaBruta, confirmacaoBruta) {
  const senha = normalizeText(senhaBruta, 120);
  const confirmacao = normalizeText(confirmacaoBruta, 120);
  if (senha.length < SENHA_MINIMA) throw erroMc(400, `A senha deve ter pelo menos ${SENHA_MINIMA} caracteres.`);
  if (senha !== confirmacao) throw erroMc(400, "A confirmação da senha não confere.");
  return senha;
}

// Permissões do cliente validadas contra o catálogo; chave desconhecida é recusada
function exigirPermissoesValidas(valor) {
  const resultado = validarPermissoes(valor);
  if (!resultado.ok) throw erroMc(400, resultado.erro);
  return resultado.permissoes;
}

// Retrato do usuário para a auditoria (sem senha)
function retrato(usuario) {
  return { usuario: usuario.usuario, nome: usuario.nome, permissoes: usuario.permissoes, ativo: usuario.ativo };
}

// Usuário é gestor de usuários?
function ehGestor(usuario) {
  return (usuario.permissoes || []).includes(PERMISSAO_GERENCIAR_USUARIOS);
}

// Quantos usuários ativos com usuario.gerenciar existem além do informado
async function outrosGestoresAtivos(client, excetoId) {
  const { rows } = await client.query(
    "SELECT count(*)::int AS n FROM mc_usuarios WHERE ativo AND $1 = ANY(permissoes) AND id <> $2",
    [PERMISSAO_GERENCIAR_USUARIOS, excetoId]
  );
  return rows[0].n;
}

// Relê o ator já dentro do lock: se ele perdeu a permissão enquanto isso, a operação para aqui
async function confirmarAtor(client, ator) {
  const { rows } = await client.query("SELECT id, usuario, permissoes, ativo FROM mc_usuarios WHERE id = $1", [ator.id]);
  const atual = rows[0];
  if (!atual || !atual.ativo || !ehGestor(atual)) throw erroMc(403, "Seu usuário não tem permissão para esta ação.");
  return atual;
}

// Carrega o alvo travando a linha; 404 se não existir
async function carregarAlvo(client, id) {
  const { rows } = await client.query(`SELECT ${COLUNAS_PUBLICAS} FROM mc_usuarios WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw erroMc(404, "Usuário não encontrado.");
  return rows[0];
}

// O assistente de primeiro uso está disponível? Só enquanto não existir nenhum usuário
export async function assistenteDisponivel(client) {
  const { rows } = await client.query("SELECT EXISTS (SELECT 1 FROM mc_usuarios) AS existe");
  return !rows[0].existe;
}

// Cria o primeiro usuário com todas as permissões. Recusa se já existir qualquer usuário --
// a checagem é refeita DENTRO do lock, então dois envios simultâneos nunca criam dois.
export async function criarPrimeiroUsuario(dados) {
  const usuario = normalizarLogin(dados.usuario);
  const nome = normalizarNome(dados.nome);
  const senha = validarSenha(dados.senha, dados.confirmarSenha);
  const hash = hashPassword(senha);
  return tx(async (client) => {
    await travarUsuarios(client);
    if (!(await assistenteDisponivel(client))) {
      throw erroMc(403, "O MyControl já foi configurado. Use a tela de login.");
    }
    const { rows } = await client.query(
      `INSERT INTO mc_usuarios (usuario, nome, senha, permissoes, ultimo_login_em)
       VALUES ($1, $2, $3, $4, now())
       RETURNING ${COLUNAS_PUBLICAS}`,
      [usuario, nome, hash, [...TODAS_PERMISSOES]]
    );
    const criado = rows[0];
    await registrarAuditoria(client, {
      ator: criado,
      acao: "usuario.criar_primeiro",
      entidade: "usuario",
      entidadeId: criado.id,
      depois: retrato(criado),
      motivo: "Assistente de primeiro uso"
    });
    return criado;
  });
}

// Lista todos os usuários (ativos e inativos), para a tela de Configurações > Usuários
export async function listarUsuarios(client) {
  const { rows } = await client.query(`SELECT ${COLUNAS_PUBLICAS} FROM mc_usuarios ORDER BY ativo DESC, nome, usuario`);
  return rows;
}

// Cria um usuário novo com as permissões marcadas
export async function criarUsuario(ator, dados) {
  const usuario = normalizarLogin(dados.usuario);
  const nome = normalizarNome(dados.nome);
  const senha = validarSenha(dados.senha, dados.confirmarSenha);
  const permissoes = exigirPermissoesValidas(dados.permissoes);
  const hash = hashPassword(senha);
  return tx(async (client) => {
    await travarUsuarios(client);
    const atorAtual = await confirmarAtor(client, ator);
    const existe = await client.query("SELECT 1 FROM mc_usuarios WHERE usuario = $1", [usuario]);
    if (existe.rowCount) throw erroMc(409, "Já existe um usuário com esse login.");
    const { rows } = await client.query(
      `INSERT INTO mc_usuarios (usuario, nome, senha, permissoes, criado_por)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUNAS_PUBLICAS}`,
      [usuario, nome, hash, permissoes, atorAtual.id]
    );
    const criado = rows[0];
    await registrarAuditoria(client, {
      ator: atorAtual,
      acao: "usuario.criar",
      entidade: "usuario",
      entidadeId: criado.id,
      depois: retrato(criado)
    });
    return criado;
  });
}

// Edita nome e permissões. Protege: ninguém tira usuario.gerenciar de si mesmo, e o último
// usuário ativo com usuario.gerenciar não pode perder essa permissão.
export async function editarUsuario(ator, id, dados) {
  const nome = normalizarNome(dados.nome);
  const permissoes = exigirPermissoesValidas(dados.permissoes);
  return tx(async (client) => {
    await travarUsuarios(client);
    const atorAtual = await confirmarAtor(client, ator);
    const alvo = await carregarAlvo(client, id);
    const perdeGestao = ehGestor(alvo) && !permissoes.includes(PERMISSAO_GERENCIAR_USUARIOS);
    if (perdeGestao && alvo.id === atorAtual.id) {
      throw erroMc(400, "Você não pode remover de si mesmo a permissão de gerenciar usuários.");
    }
    if (perdeGestao && alvo.ativo && (await outrosGestoresAtivos(client, alvo.id)) === 0) {
      throw erroMc(409, "Este é o último usuário ativo que gerencia usuários: ele não pode perder essa permissão.");
    }
    const { rows } = await client.query(
      `UPDATE mc_usuarios SET nome = $2, permissoes = $3 WHERE id = $1 RETURNING ${COLUNAS_PUBLICAS}`,
      [alvo.id, nome, permissoes]
    );
    const atualizado = rows[0];
    // Nome e permissões viram linhas separadas na auditoria: mudança de permissão é o que se procura depois
    if (alvo.nome !== atualizado.nome) {
      await registrarAuditoria(client, {
        ator: atorAtual,
        acao: "usuario.editar",
        entidade: "usuario",
        entidadeId: alvo.id,
        antes: { nome: alvo.nome },
        depois: { nome: atualizado.nome }
      });
    }
    if (alvo.permissoes.join(",") !== atualizado.permissoes.join(",")) {
      await registrarAuditoria(client, {
        ator: atorAtual,
        acao: "usuario.permissoes",
        entidade: "usuario",
        entidadeId: alvo.id,
        antes: { permissoes: alvo.permissoes },
        depois: { permissoes: atualizado.permissoes }
      });
    }
    return atualizado;
  });
}

// Redefine a senha de um usuário e encerra as sessões abertas dele (a auditoria registra o
// fato, nunca o valor nem o hash)
export async function redefinirSenha(ator, id, dados) {
  const senha = validarSenha(dados.senha, dados.confirmarSenha);
  const hash = hashPassword(senha);
  return tx(async (client) => {
    await travarUsuarios(client);
    const atorAtual = await confirmarAtor(client, ator);
    const alvo = await carregarAlvo(client, id);
    // senha_alterada_em derruba todas as sessões abertas desse usuário (ver requireMcUser)
    await client.query("UPDATE mc_usuarios SET senha = $2, senha_alterada_em = now() WHERE id = $1", [alvo.id, hash]);
    await registrarAuditoria(client, {
      ator: atorAtual,
      acao: "usuario.senha_redefinida",
      entidade: "usuario",
      entidadeId: alvo.id
    });
    return alvo;
  });
}

// Desativa ou reativa. Não existe exclusão física: usuário com registros não pode sumir, e
// desativar já corta o acesso na próxima requisição. Protege o último gestor ativo e a si mesmo.
export async function alterarAtivo(ator, id, ativo) {
  if (typeof ativo !== "boolean") throw erroMc(400, "Informe se o usuário fica ativo ou não.");
  return tx(async (client) => {
    await travarUsuarios(client);
    const atorAtual = await confirmarAtor(client, ator);
    const alvo = await carregarAlvo(client, id);
    if (alvo.ativo === ativo) return alvo;
    if (!ativo && alvo.id === atorAtual.id) throw erroMc(400, "Você não pode desativar o próprio usuário.");
    if (!ativo && ehGestor(alvo) && (await outrosGestoresAtivos(client, alvo.id)) === 0) {
      throw erroMc(409, "Este é o último usuário ativo que gerencia usuários: ele não pode ser desativado.");
    }
    const { rows } = await client.query(`UPDATE mc_usuarios SET ativo = $2 WHERE id = $1 RETURNING ${COLUNAS_PUBLICAS}`, [alvo.id, ativo]);
    await registrarAuditoria(client, {
      ator: atorAtual,
      acao: ativo ? "usuario.reativar" : "usuario.desativar",
      entidade: "usuario",
      entidadeId: alvo.id,
      antes: { ativo: alvo.ativo },
      depois: { ativo }
    });
    return rows[0];
  });
}

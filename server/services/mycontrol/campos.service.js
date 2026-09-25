// Campos configuráveis dos cadastros do MyControl (tela Configurações > Campos) e a validação
// dos valores de um cadastro contra os campos ATIVOS -- sempre no servidor.
//
// Regras de "travado" e "obrigatório fixo" vêm do catálogo no código (campos.catalogo.js),
// nunca do que está gravado no banco: editar a linha na mão não destrava um campo do sistema.
import { tx } from "../../db.js";
import { normalizeText } from "../../utils/http.js";
import { campoDoSistema, entidadeValida, tipoDoUsuarioValido } from "./campos.catalogo.js";
import { registrarAuditoria } from "./mycontrol.schema.js";
import { erroMc } from "./usuarios.service.js";

// Limites de texto por tipo
const MAX_TEXTO = 200;
const MAX_TEXTO_LONGO = 2000;
const MAX_OPCOES = 50;

// Serializa as mudanças de campos (criar com chave única, reordenar) entre requisições simultâneas
async function travarCampos(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('mycontrol:campos'))");
}

// Entidade do pedido é uma das três conhecidas?
export function exigirEntidade(entidade) {
  if (!entidadeValida(entidade)) throw erroMc(400, "Cadastro desconhecido.");
  return entidade;
}

// Junta a linha do banco com as regras do catálogo (o que a tela precisa para travar botões)
function comRegras(linha) {
  const sistema = linha.sistema ? campoDoSistema(linha.entidade, linha.chave) : null;
  return {
    id: linha.id,
    entidade: linha.entidade,
    chave: linha.chave,
    rotulo: linha.rotulo,
    tipo: linha.tipo,
    opcoes: Array.isArray(linha.opcoes) ? linha.opcoes : [],
    obrigatorio: sistema?.obrigatorioFixo ? true : linha.obrigatorio,
    ordem: linha.ordem,
    ativo: sistema?.travado ? true : linha.ativo,
    sistema: Boolean(linha.sistema),
    travado: Boolean(sistema?.travado),
    obrigatorio_fixo: Boolean(sistema?.obrigatorioFixo),
    gerado: Boolean(sistema?.gerado),
    maiusculo: Boolean(sistema?.maiusculo),
    max: sistema?.max || (linha.tipo === "texto_longo" ? MAX_TEXTO_LONGO : MAX_TEXTO),
    coluna: sistema?.coluna || null
  };
}

// Campos não excluídos de uma entidade, na ordem da tela
export async function listarCampos(client, entidade) {
  const { rows } = await client.query(
    "SELECT * FROM mc_campos WHERE entidade = $1 AND excluido_em IS NULL ORDER BY ordem, id",
    [entidade]
  );
  return rows.map(comRegras);
}

// Carrega um campo não excluído travando a linha
async function carregarCampo(client, id) {
  const { rows } = await client.query("SELECT * FROM mc_campos WHERE id = $1 AND excluido_em IS NULL FOR UPDATE", [id]);
  if (!rows[0]) throw erroMc(404, "Campo não encontrado.");
  return rows[0];
}

// Rótulo obrigatório, até 60 caracteres
function normalizarRotulo(valor) {
  const rotulo = normalizeText(valor, 60);
  if (!rotulo) throw erroMc(400, "Informe o nome do campo.");
  return rotulo;
}

// Opções de uma lista: textos não vazios, sem repetição, de 1 a 50
function normalizarOpcoes(valor) {
  if (!Array.isArray(valor)) throw erroMc(400, "Informe as opções da lista.");
  const opcoes = [...new Set(valor.map((item) => normalizeText(item, 60)).filter(Boolean))];
  if (!opcoes.length) throw erroMc(400, "A lista precisa de pelo menos uma opção.");
  if (opcoes.length > MAX_OPCOES) throw erroMc(400, `A lista aceita no máximo ${MAX_OPCOES} opções.`);
  return opcoes;
}

// Chave técnica a partir do rótulo: minúscula, sem acento, só letras/números/sublinhado
function chaveDoRotulo(rotulo) {
  const base = rotulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(base) ? base : `campo_${base || "novo"}`.slice(0, 40);
}

// Retrato do campo para a auditoria
function retratoCampo(campo) {
  return { rotulo: campo.rotulo, tipo: campo.tipo, obrigatorio: campo.obrigatorio, ativo: campo.ativo, opcoes: campo.opcoes, ordem: campo.ordem };
}

// Cria um campo do usuário (o valor dele vai para `dados` do cadastro)
export async function criarCampo(ator, dados) {
  const entidade = exigirEntidade(dados.entidade);
  const rotulo = normalizarRotulo(dados.rotulo);
  const tipo = String(dados.tipo || "");
  if (!tipoDoUsuarioValido(tipo)) throw erroMc(400, "Tipo de campo desconhecido.");
  const opcoes = tipo === "selecao" ? normalizarOpcoes(dados.opcoes) : [];
  const obrigatorio = dados.obrigatorio === true;
  return tx(async (client) => {
    await travarCampos(client);
    // A chave nunca é reaproveitada: conta também os campos excluídos (a linha continua lá)
    const base = chaveDoRotulo(rotulo);
    const { rows: existentes } = await client.query(
      "SELECT chave FROM mc_campos WHERE entidade = $1 AND (chave = $2 OR chave LIKE $3)",
      [entidade, base, `${base}\\_%`]
    );
    const usadas = new Set(existentes.map((linha) => linha.chave));
    let chave = base;
    for (let n = 2; usadas.has(chave); n += 1) chave = `${base}_${n}`;
    const { rows: ordem } = await client.query("SELECT COALESCE(MAX(ordem), 0) + 10 AS proxima FROM mc_campos WHERE entidade = $1", [entidade]);
    const { rows } = await client.query(
      `INSERT INTO mc_campos (entidade, chave, rotulo, tipo, opcoes, obrigatorio, ordem, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [entidade, chave, rotulo, tipo, JSON.stringify(opcoes), obrigatorio, ordem[0].proxima, ator.id]
    );
    await registrarAuditoria(client, { ator, acao: "campo.criar", entidade: "campo", entidadeId: rows[0].id, depois: { entidade, chave, ...retratoCampo(rows[0]) } });
    return comRegras(rows[0]);
  });
}

// Edita rótulo, obrigatoriedade e opções. O tipo nunca muda (os valores já gravados seriam
// reinterpretados); travado/obrigatório fixo seguem o catálogo.
export async function editarCampo(ator, id, dados) {
  return tx(async (client) => {
    const atual = await carregarCampo(client, id);
    const regras = comRegras(atual);
    if (dados.tipo !== undefined && dados.tipo !== atual.tipo) throw erroMc(400, "O tipo de um campo não pode ser alterado. Crie um campo novo.");
    const rotulo = dados.rotulo === undefined ? atual.rotulo : normalizarRotulo(dados.rotulo);
    let obrigatorio = atual.obrigatorio;
    if (dados.obrigatorio !== undefined) {
      if (typeof dados.obrigatorio !== "boolean") throw erroMc(400, "Obrigatório deve ser sim ou não.");
      if (regras.obrigatorio_fixo && dados.obrigatorio === false) throw erroMc(400, "Este campo é sempre obrigatório.");
      obrigatorio = dados.obrigatorio;
    }
    let opcoes = regras.opcoes;
    if (dados.opcoes !== undefined) {
      if (atual.tipo !== "selecao") throw erroMc(400, "Só campos do tipo lista têm opções.");
      opcoes = normalizarOpcoes(dados.opcoes);
    }
    const { rows } = await client.query(
      "UPDATE mc_campos SET rotulo = $2, obrigatorio = $3, opcoes = $4, atualizado_em = now() WHERE id = $1 RETURNING *",
      [id, rotulo, obrigatorio, JSON.stringify(opcoes)]
    );
    await registrarAuditoria(client, { ator, acao: "campo.editar", entidade: "campo", entidadeId: id, antes: retratoCampo(atual), depois: retratoCampo(rows[0]) });
    return comRegras(rows[0]);
  });
}

// Desativa ou reativa (some do formulário; os valores já gravados continuam guardados)
export async function alterarAtivoCampo(ator, id, ativo) {
  if (typeof ativo !== "boolean") throw erroMc(400, "Informe se o campo fica ativo ou não.");
  return tx(async (client) => {
    const atual = await carregarCampo(client, id);
    if (comRegras(atual).travado) throw erroMc(400, "Este campo é do sistema e não pode ser desativado.");
    const { rows } = await client.query("UPDATE mc_campos SET ativo = $2, atualizado_em = now() WHERE id = $1 RETURNING *", [id, ativo]);
    await registrarAuditoria(client, { ator, acao: ativo ? "campo.reativar" : "campo.desativar", entidade: "campo", entidadeId: id, antes: { ativo: atual.ativo }, depois: { ativo } });
    return comRegras(rows[0]);
  });
}

// Exclusão lógica de um campo do usuário: some da tela de Campos, a chave nunca volta a ser usada
// e os valores antigos continuam dentro de `dados` (não se apaga histórico de cadastro)
export async function excluirCampo(ator, id) {
  return tx(async (client) => {
    const atual = await carregarCampo(client, id);
    if (atual.sistema) throw erroMc(400, "Campo do sistema não pode ser excluído. Desative-o se não quiser usar.");
    await client.query("UPDATE mc_campos SET ativo = FALSE, excluido_em = now(), atualizado_em = now() WHERE id = $1", [id]);
    await registrarAuditoria(client, { ator, acao: "campo.excluir", entidade: "campo", entidadeId: id, antes: retratoCampo(atual) });
    return { id };
  });
}

// Nova ordem dos campos de uma entidade: a lista tem que ter exatamente os campos não excluídos
export async function reordenarCampos(ator, dados) {
  const entidade = exigirEntidade(dados.entidade);
  if (!Array.isArray(dados.ids) || !dados.ids.every((id) => Number.isInteger(id))) throw erroMc(400, "Envie a nova ordem dos campos.");
  return tx(async (client) => {
    await travarCampos(client);
    const { rows } = await client.query("SELECT id, ordem FROM mc_campos WHERE entidade = $1 AND excluido_em IS NULL ORDER BY ordem, id", [entidade]);
    const atuais = rows.map((linha) => linha.id);
    const iguais = atuais.length === dados.ids.length && new Set(dados.ids).size === dados.ids.length && dados.ids.every((id) => atuais.includes(id));
    if (!iguais) throw erroMc(409, "A lista de campos mudou. Recarregue a tela e tente de novo.");
    for (const [indice, id] of dados.ids.entries()) {
      await client.query("UPDATE mc_campos SET ordem = $2, atualizado_em = now() WHERE id = $1", [id, (indice + 1) * 10]);
    }
    await registrarAuditoria(client, { ator, acao: "campo.reordenar", entidade: "campo", entidadeId: entidade, antes: { ids: atuais }, depois: { ids: dados.ids } });
    return listarCampos(client, entidade);
  });
}

// ===== Validação dos valores de um cadastro =====

// Valor vazio? (false de sim/não não é vazio)
export function valorVazio(valor) {
  return valor === null || valor === undefined || (typeof valor === "string" && valor.trim() === "");
}

// Normaliza a placa: maiúscula, sem hífen/espaço, nos padrões antigo (AAA9999) ou Mercosul (AAA9A99)
export function normalizarPlaca(valor) {
  const placa = String(valor || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) {
    throw erroMc(400, "Placa inválida. Use o padrão antigo (ABC-1234) ou o Mercosul (ABC1D23).");
  }
  return placa;
}

// Placa para exibir: padrão antigo com hífen (ABC-1234), Mercosul sem (ABC1D23)
export function formatarPlaca(placa) {
  if (!placa) return "";
  return /^[A-Z]{3}[0-9]{4}$/.test(placa) ? `${placa.slice(0, 3)}-${placa.slice(3)}` : placa;
}

// Referência a um arquivo já enviado, da mesma entidade e do papel certo (foto ou assinatura)
async function exigirArquivo(client, entidade, papel, valor, rotulo) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) throw erroMc(400, `${rotulo}: arquivo inválido.`);
  const { rows } = await client.query("SELECT 1 FROM mc_arquivos WHERE id = $1 AND entidade = $2 AND papel = $3", [id, entidade, papel]);
  if (!rows[0]) throw erroMc(400, `${rotulo}: arquivo não encontrado. Envie a imagem de novo.`);
  return id;
}

// Converte e valida um valor conforme o tipo do campo; erro 400 com o rótulo do campo
async function normalizarValor(client, entidade, campo, bruto) {
  const rotulo = campo.rotulo;
  switch (campo.tipo) {
    case "texto":
    case "texto_longo": {
      if (typeof bruto !== "string" && typeof bruto !== "number") throw erroMc(400, `${rotulo}: texto inválido.`);
      let texto = String(bruto).trim();
      if (texto.length > campo.max) throw erroMc(400, `${rotulo}: no máximo ${campo.max} caracteres.`);
      if (campo.maiusculo) texto = texto.toUpperCase();
      return texto;
    }
    case "numero": {
      const numero = typeof bruto === "number" ? bruto : Number(String(bruto).trim().replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(numero)) throw erroMc(400, `${rotulo}: informe um número.`);
      return numero;
    }
    case "data": {
      const texto = String(bruto).trim();
      const data = new Date(`${texto}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(texto) || Number.isNaN(data.getTime()) || data.toISOString().slice(0, 10) !== texto) {
        throw erroMc(400, `${rotulo}: data inválida.`);
      }
      return texto;
    }
    case "selecao": {
      const texto = String(bruto).trim();
      if (!campo.opcoes.includes(texto)) throw erroMc(400, `${rotulo}: escolha uma das opções da lista.`);
      return texto;
    }
    case "sim_nao":
      if (typeof bruto !== "boolean") throw erroMc(400, `${rotulo}: responda sim ou não.`);
      return bruto;
    case "telefone": {
      const digitos = String(bruto).replace(/\D/g, "");
      if (!/^\d{10,11}$/.test(digitos)) throw erroMc(400, `${rotulo}: telefone com DDD (10 ou 11 números).`);
      return digitos;
    }
    case "foto":
      return exigirArquivo(client, entidade, "foto", bruto, rotulo);
    case "assinatura":
      return exigirArquivo(client, entidade, "assinatura", bruto, rotulo);
    case "placa":
      return normalizarPlaca(bruto);
    case "cargo": {
      const id = Number(bruto);
      if (!Number.isInteger(id) || id <= 0) throw erroMc(400, `${rotulo}: escolha um cargo.`);
      const { rows } = await client.query("SELECT ativo FROM mc_cargos WHERE id = $1", [id]);
      if (!rows[0]) throw erroMc(400, `${rotulo}: cargo não encontrado.`);
      if (!rows[0].ativo) throw erroMc(400, `${rotulo}: este cargo está desativado.`);
      return id;
    }
    default:
      throw erroMc(400, `${rotulo}: tipo de campo desconhecido.`);
  }
}

// Valida os valores enviados contra os campos ativos e separa em colunas (campos do sistema) e
// `dados` (campos do usuário). `atual` são os valores já gravados (edição) ou null (criação).
// - chave desconhecida ou de campo excluído: recusada;
// - matrícula: nunca aceita (gerada pelo servidor);
// - campo desativado: ignorado, o valor gravado fica como está;
// - valor igual ao já gravado: não é revalidado (opção removida da lista, cargo desativado...);
// - obrigatório vazio: recusado, citando os rótulos.
export async function validarValores(client, { entidade, campos, entrada, atual }) {
  if (entrada === null || typeof entrada !== "object" || Array.isArray(entrada)) throw erroMc(400, "Envie os valores do cadastro.");
  if (Object.prototype.hasOwnProperty.call(entrada, "matricula")) {
    throw erroMc(400, "A matrícula é gerada pelo sistema e não pode ser informada nem alterada.");
  }
  const porChave = new Map(campos.map((campo) => [campo.chave, campo]));
  const desconhecidas = Object.keys(entrada).filter((chave) => !porChave.has(chave));
  if (desconhecidas.length) throw erroMc(400, `Campo desconhecido: ${desconhecidas.join(", ")}.`);

  const colunas = {};
  const dados = {};
  const faltando = [];
  for (const campo of campos) {
    if (campo.gerado) continue;
    const anterior = atual ? (atual[campo.chave] ?? null) : null;
    let valor = anterior;
    if (campo.ativo && Object.prototype.hasOwnProperty.call(entrada, campo.chave)) {
      const bruto = entrada[campo.chave];
      if (valorVazio(bruto)) valor = null;
      else if (anterior !== null && JSON.stringify(bruto) === JSON.stringify(anterior)) valor = anterior;
      else valor = await normalizarValor(client, entidade, campo, bruto);
    }
    if (campo.ativo && campo.obrigatorio && valorVazio(valor)) faltando.push(campo.rotulo);
    // null em `dados` significa "apagar a chave"; quem grava junta com o que já existe, para não
    // perder valores de campos excluídos (que não estão mais nesta lista)
    if (campo.coluna) colunas[campo.coluna] = valor;
    else dados[campo.chave] = valorVazio(valor) ? null : valor;
  }
  if (faltando.length) throw erroMc(400, `Preencha os campos obrigatórios: ${faltando.join(", ")}.`);
  return { colunas, dados };
}

// Rótulos dos campos obrigatórios ativos que estão vazios (aviso na lista para cadastros antigos)
export function pendenciasDoCadastro(campos, valores) {
  return campos
    .filter((campo) => campo.ativo && campo.obrigatorio && !campo.gerado && valorVazio(valores[campo.chave]))
    .map((campo) => campo.rotulo);
}

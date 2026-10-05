// Rotas da Fase 2 do MyControl: campos configuráveis, cargos, cadastros (colaboradores,
// veículos, ferramentas) e arquivos (fotos e assinaturas).
//
// Só a tabela de rotas e os handlers finos moram aqui; o roteador (mycontrol.routes.js) cuida
// de sessão, permissão da rota, Content-Type obrigatório e tradução de erros. Toda rota daqui
// declara a própria permissão -- a tela só esconde botões.
import { tx } from "../../db.js";
import { readBody, send } from "../../utils/http.js";
import { ENTIDADES, TIPOS_CAMPO, entidadeValida } from "../../services/mycontrol/campos.catalogo.js";
import {
  alterarAtivoCampo,
  criarCampo,
  editarCampo,
  excluirCampo,
  exigirEntidade,
  listarCampos,
  reordenarCampos
} from "../../services/mycontrol/campos.service.js";
import { alterarAtivoCargo, criarCargo, editarCargo, excluirCargo, listarCargos } from "../../services/mycontrol/cargos.service.js";
import { alterarAtivoCadastro, criarCadastro, editarCadastro, listarCadastros } from "../../services/mycontrol/cadastros.service.js";
import {
  carregarArquivo,
  lerBinario,
  lerCorpoImagem,
  limiteImagemBytes,
  salvarArquivo,
  salvarMiniatura
} from "../../services/mycontrol/arquivos.service.js";
import { erroMc } from "../../services/mycontrol/usuarios.service.js";
import { PERMISSOES_REGISTRO } from "../../services/mycontrol/registros.service.js";

// Permissões que abrem algum cadastro
const PERMISSOES_DE_CADASTRO = Object.values(ENTIDADES).map((entidade) => entidade.permissao);

// Quem registra, devolve ou edita registros precisa VER as fotos dos cadastros (colaborador,
// veículo, ferramenta) e enviar/ver as fotos dos próprios registros (Fase 3)
const PERMISSOES_DE_USO = ["registro.registrar", "registro.devolver", "registro.editar"];

// Quem pode chegar às rotas de arquivo; a entidade específica é conferida dentro do handler
const PERMISSOES_DE_ARQUIVO = [...PERMISSOES_DE_CADASTRO, ...PERMISSOES_REGISTRO];

// O usuário tem alguma das permissões?
function temAlguma(usuario, permissoes) {
  return permissoes.some((chave) => (usuario.permissoes || []).includes(chave));
}

// Pode ENVIAR imagem desta entidade? Cadastro: quem o gerencia. Registro: quem registra, devolve
// ou edita registros (fotos de antes/depois). Senão 403.
function exigirEnvioDaEntidade(usuario, entidade) {
  if (entidade === "registro") {
    if (!temAlguma(usuario, PERMISSOES_DE_USO)) throw erroMc(403, "Seu usuário não tem permissão para esta ação.");
    return;
  }
  if (!entidadeValida(entidade)) throw erroMc(404, "Cadastro desconhecido.");
  if (!temAlguma(usuario, [ENTIDADES[entidade].permissao])) throw erroMc(403, "Seu usuário não tem permissão para esta ação.");
}

// Pode VER esta imagem? Foto de cadastro: quem gerencia o cadastro ou quem registra/devolve/edita
// (precisa reconhecer a pessoa e o item). Foto e assinatura de registro: qualquer permissão de
// registro (quem cancela ou exclui também abre o detalhe).
function exigirVisualizacao(usuario, arquivo) {
  const permitidas = arquivo.entidade === "registro"
    ? PERMISSOES_REGISTRO
    : entidadeValida(arquivo.entidade) ? [ENTIDADES[arquivo.entidade].permissao, ...PERMISSOES_DE_USO] : [];
  if (!temAlguma(usuario, permitidas)) throw erroMc(403, "Seu usuário não tem permissão para ver esta imagem.");
}

// ===== Campos (Configurações > Campos) =====

// Campos de uma entidade (inclusive desativados) e os tipos que o usuário pode criar
async function listarCamposRota(req, res, { url }) {
  const entidade = exigirEntidade(url.searchParams.get("entidade"));
  const campos = await tx((client) => listarCampos(client, entidade));
  send(res, 200, { campos, tipos: TIPOS_CAMPO, entidades: ENTIDADES });
}

// ===== Cargos (Configurações > Cargos) =====

// Lista de cargos com contagem de uso
async function listarCargosRota(req, res) {
  send(res, 200, { cargos: await tx((client) => listarCargos(client)) });
}

// ===== Cadastros =====

// Monta as quatro rotas (listar, criar, editar, ativar/desativar) de uma entidade
function rotasDaEntidade(entidade) {
  const { rota, permissao } = ENTIDADES[entidade];
  const base = `^\\/api\\/mycontrol\\/${rota}`;
  return [
    {
      metodo: "GET",
      caminho: new RegExp(`${base}$`),
      permissao,
      // Lista paginada; colaborador leva também os cargos para o seletor do formulário
      handler: async (req, res, { url }) => {
        const resposta = await tx(async (client) => {
          const lista = await listarCadastros(client, entidade, {
            q: url.searchParams.get("q") || "",
            situacao: url.searchParams.get("situacao") || "ativos",
            pagina: url.searchParams.get("pagina") || 1
          });
          if (entidade === "colaborador") {
            const { rows } = await client.query("SELECT id, nome, abreviacao, ativo FROM mc_cargos ORDER BY nome");
            lista.cargos = rows;
          }
          return lista;
        });
        send(res, 200, { ...resposta, limite_imagem_bytes: limiteImagemBytes() });
      }
    },
    {
      metodo: "POST",
      caminho: new RegExp(`${base}$`),
      permissao,
      // Cria o cadastro (colaborador ganha a matrícula no servidor)
      handler: async (req, res, { usuario }) => send(res, 200, { item: await criarCadastro(usuario, entidade, await readBody(req)) })
    },
    {
      metodo: "PATCH",
      caminho: new RegExp(`${base}\\/(\\d{1,9})$`),
      permissao,
      // Edita o cadastro (matrícula recusada)
      handler: async (req, res, { usuario, id }) => send(res, 200, { item: await editarCadastro(usuario, entidade, id, await readBody(req)) })
    },
    {
      metodo: "POST",
      caminho: new RegExp(`${base}\\/(\\d{1,9})\\/ativo$`),
      permissao,
      // Desativa ou reativa
      handler: async (req, res, { usuario, id }) => {
        const corpo = await readBody(req);
        send(res, 200, { item: await alterarAtivoCadastro(usuario, entidade, id, corpo.ativo) });
      }
    }
  ];
}

// ===== Arquivos =====

// Recebe a imagem principal (foto ou assinatura) como corpo binário
async function enviarArquivo(req, res, { usuario, entidade, url }) {
  exigirEnvioDaEntidade(usuario, entidade);
  // Registro só recebe foto enviada; a assinatura dele é sempre a cópia feita pelo servidor
  const papel = entidade !== "registro" && url.searchParams.get("papel") === "assinatura" ? "assinatura" : "foto";
  const buffer = await lerCorpoImagem(req);
  const arquivo = await tx((client) => salvarArquivo(client, { ator: usuario, entidade, papel, buffer }));
  send(res, 200, { arquivo });
}

// Recebe a miniatura de uma foto já enviada
async function enviarMiniatura(req, res, { usuario, entidade, id }) {
  exigirEnvioDaEntidade(usuario, entidade);
  const buffer = await lerCorpoImagem(req, 512 * 1024 + 1);
  send(res, 200, { arquivo: await tx((client) => salvarMiniatura(client, { entidade, id, buffer })) });
}

// Serve a imagem (ou a miniatura com ?miniatura=1) para quem pode vê-la (exigirVisualizacao)
async function servirArquivo(req, res, { usuario, id, url }) {
  const arquivo = await tx((client) => carregarArquivo(client, id));
  if (!arquivo) throw erroMc(404, "Arquivo não encontrado.");
  exigirVisualizacao(usuario, arquivo);
  const { conteudo, mime } = await lerBinario(arquivo, { miniatura: url.searchParams.get("miniatura") === "1" });
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": conteudo.length,
    "Cache-Control": "private, max-age=300",
    // O tipo já foi conferido pelos bytes no envio; nosniff impede o navegador de reinterpretar
    "X-Content-Type-Options": "nosniff"
  });
  res.end(conteudo);
}

// Entidades aceitas nas rotas de envio: os três cadastros e os registros de uso (Fase 3)
const ENTIDADES_NA_URL = [...Object.keys(ENTIDADES), "registro"].join("|");

// Tabela de rotas da Fase 2 (juntada à da Fase 1 no roteador). `parametros` nomeia as capturas
// da URL; `corpo: "imagem"` troca a exigência de JSON pela de imagem (ver arquivos.service.js).
export const ROTAS_CADASTROS = Object.freeze([
  { metodo: "GET", caminho: /^\/api\/mycontrol\/campos$/, permissao: "campos.configurar", handler: listarCamposRota },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/campos$/,
    permissao: "campos.configurar",
    handler: async (req, res, { usuario }) => send(res, 200, { campo: await criarCampo(usuario, await readBody(req)) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/campos\/ordem$/,
    permissao: "campos.configurar",
    handler: async (req, res, { usuario }) => send(res, 200, { campos: await reordenarCampos(usuario, await readBody(req)) })
  },
  {
    metodo: "PATCH",
    caminho: /^\/api\/mycontrol\/campos\/(\d{1,9})$/,
    permissao: "campos.configurar",
    handler: async (req, res, { usuario, id }) => send(res, 200, { campo: await editarCampo(usuario, id, await readBody(req)) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/campos\/(\d{1,9})\/ativo$/,
    permissao: "campos.configurar",
    handler: async (req, res, { usuario, id }) => send(res, 200, { campo: await alterarAtivoCampo(usuario, id, (await readBody(req)).ativo) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/campos\/(\d{1,9})\/excluir$/,
    permissao: "campos.configurar",
    handler: async (req, res, { usuario, id }) => {
      await readBody(req);
      send(res, 200, await excluirCampo(usuario, id));
    }
  },
  { metodo: "GET", caminho: /^\/api\/mycontrol\/cargos$/, permissao: "cargo.gerenciar", handler: listarCargosRota },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/cargos$/,
    permissao: "cargo.gerenciar",
    handler: async (req, res, { usuario }) => send(res, 200, { cargo: await criarCargo(usuario, await readBody(req)) })
  },
  {
    metodo: "PATCH",
    caminho: /^\/api\/mycontrol\/cargos\/(\d{1,9})$/,
    permissao: "cargo.gerenciar",
    handler: async (req, res, { usuario, id }) => send(res, 200, { cargo: await editarCargo(usuario, id, await readBody(req)) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/cargos\/(\d{1,9})\/ativo$/,
    permissao: "cargo.gerenciar",
    handler: async (req, res, { usuario, id }) => send(res, 200, { cargo: await alterarAtivoCargo(usuario, id, (await readBody(req)).ativo) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/cargos\/(\d{1,9})\/excluir$/,
    permissao: "cargo.gerenciar",
    handler: async (req, res, { usuario, id }) => {
      await readBody(req);
      send(res, 200, await excluirCargo(usuario, id));
    }
  },
  ...Object.keys(ENTIDADES).flatMap(rotasDaEntidade),
  {
    metodo: "POST",
    caminho: new RegExp(`^\\/api\\/mycontrol\\/arquivos\\/(${ENTIDADES_NA_URL})$`),
    parametros: ["entidade"],
    corpo: "imagem",
    permissao: PERMISSOES_DE_ARQUIVO,
    handler: enviarArquivo
  },
  {
    metodo: "POST",
    caminho: new RegExp(`^\\/api\\/mycontrol\\/arquivos\\/(${ENTIDADES_NA_URL})\\/(\\d{1,9})\\/miniatura$`),
    parametros: ["entidade", "id"],
    corpo: "imagem",
    permissao: PERMISSOES_DE_ARQUIVO,
    handler: enviarMiniatura
  },
  { metodo: "GET", caminho: /^\/api\/mycontrol\/arquivos\/(\d{1,9})$/, permissao: PERMISSOES_DE_ARQUIVO, handler: servirArquivo }
]);

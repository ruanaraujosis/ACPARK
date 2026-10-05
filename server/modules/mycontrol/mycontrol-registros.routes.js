// Rotas da Fase 3 do MyControl: registro de uso e devolução de veículos e ferramentas.
//
// Cada ação tem a própria permissão, checada no servidor pelo roteador (mycontrol.routes.js)
// antes do handler: registrar, devolver, editar, cancelar e excluir. As listas e o detalhe
// abrem para quem tem QUALQUER permissão de registro. Datas vêm sempre do servidor.
import { tx } from "../../db.js";
import { readBody, send } from "../../utils/http.js";
import { limiteImagemBytes } from "../../services/mycontrol/arquivos.service.js";
import {
  LIMITE_KM_ALTO,
  PERMISSOES_REGISTRO,
  cancelarRegistro,
  carregarRegistro,
  criarRegistro,
  devolverRegistro,
  editarRegistro,
  excluirRegistro,
  listarColaboradoresParaRegistro,
  listarDisponiveis,
  listarEmUso,
  listarHistorico
} from "../../services/mycontrol/registros.service.js";

// Quem registra ou edita precisa escolher item e colaborador
const PERMISSOES_DE_ESCOLHA = ["registro.registrar", "registro.editar"];

// Tabela de rotas da Fase 3 (juntada às outras no roteador)
export const ROTAS_REGISTROS = Object.freeze([
  {
    metodo: "GET",
    caminho: /^\/api\/mycontrol\/registros\/disponiveis$/,
    permissao: "registro.registrar",
    // Itens ativos e livres do tipo pedido (busca por nome, placa, chave ou identificador)
    handler: async (req, res, { url }) => {
      const itens = await tx((client) => listarDisponiveis(client, url.searchParams.get("tipo"), url.searchParams.get("q")));
      send(res, 200, { itens });
    }
  },
  {
    metodo: "GET",
    caminho: /^\/api\/mycontrol\/registros\/colaboradores$/,
    permissao: PERMISSOES_DE_ESCOLHA,
    // Colaboradores ativos (busca por nome ou matrícula), com cargo e assinatura do cadastro
    handler: async (req, res, { url }) => {
      const colaboradores = await tx((client) => listarColaboradoresParaRegistro(client, url.searchParams.get("q")));
      send(res, 200, { colaboradores, limite_imagem_bytes: limiteImagemBytes() });
    }
  },
  {
    metodo: "GET",
    caminho: /^\/api\/mycontrol\/registros\/em-uso$/,
    permissao: PERMISSOES_REGISTRO,
    // O que está com alguém agora
    handler: async (req, res) => send(res, 200, { registros: await tx((client) => listarEmUso(client)), limite_km_alto: LIMITE_KM_ALTO, limite_imagem_bytes: limiteImagemBytes() })
  },
  {
    metodo: "GET",
    caminho: /^\/api\/mycontrol\/registros$/,
    permissao: PERMISSOES_REGISTRO,
    // Histórico paginado (cancelados aparecem; excluídos não)
    handler: async (req, res, { url }) => {
      const filtros = Object.fromEntries(["tipo", "status", "de", "ate", "q", "pagina"].map((chave) => [chave, url.searchParams.get(chave) || ""]));
      send(res, 200, await tx((client) => listarHistorico(client, filtros)));
    }
  },
  {
    metodo: "GET",
    caminho: /^\/api\/mycontrol\/registros\/(\d{1,9})$/,
    permissao: PERMISSOES_REGISTRO,
    // Detalhe de um registro
    handler: async (req, res, { id }) => send(res, 200, { registro: await tx((client) => carregarRegistro(client, id)), limite_km_alto: LIMITE_KM_ALTO, limite_imagem_bytes: limiteImagemBytes() })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/registros$/,
    permissao: "registro.registrar",
    // Registra a retirada (hora do servidor, assinatura copiada do cadastro)
    handler: async (req, res, { usuario }) => send(res, 200, { registro: await criarRegistro(usuario, await readBody(req)) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/registros\/(\d{1,9})\/devolver$/,
    permissao: "registro.devolver",
    // Devolução (foto depois obrigatória; km de volta para veículo)
    handler: async (req, res, { usuario, id }) => send(res, 200, { registro: await devolverRegistro(usuario, id, await readBody(req)) })
  },
  {
    metodo: "PATCH",
    caminho: /^\/api\/mycontrol\/registros\/(\d{1,9})$/,
    permissao: "registro.editar",
    // Edita observação, fotos e colaborador (com auditoria de antes e depois)
    handler: async (req, res, { usuario, id }) => send(res, 200, { registro: await editarRegistro(usuario, id, await readBody(req)) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/registros\/(\d{1,9})\/cancelar$/,
    permissao: "registro.cancelar",
    // Cancela com motivo obrigatório
    handler: async (req, res, { usuario, id }) => send(res, 200, { registro: await cancelarRegistro(usuario, id, await readBody(req)) })
  },
  {
    metodo: "POST",
    caminho: /^\/api\/mycontrol\/registros\/(\d{1,9})\/excluir$/,
    permissao: "registro.excluir",
    // Exclusão lógica com motivo obrigatório
    handler: async (req, res, { usuario, id }) => send(res, 200, await excluirRegistro(usuario, id, await readBody(req)))
  }
]);

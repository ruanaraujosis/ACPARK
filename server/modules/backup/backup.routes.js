// Rotas administrativas de backup/restauracao -- a interface que o instalador (myestoqueConfig.exe
// ou o app desktop) vai chamar. Nenhum passo em terminal: gerar, listar, validar e restaurar tudo
// pela API, autenticado como admin.
import {
  BackupError,
  bancoDestinoTemDados,
  gerarBackupCompleto,
  listarBackups,
  resolverCaminhoBackup,
  restaurarBackup,
  validarArquivoBackup
} from "../../services/backup/backup.service.js";
import { ensureAllRuntimeTables } from "../../services/backup/runtime-schema.service.js";
import { readBody, send } from "../../utils/http.js";

// Traduz os codigos de erro do servico em mensagens curtas e em portugues para a interface
const mensagensAmigaveis = {
  ARQUIVO_INEXISTENTE: "Arquivo de backup não encontrado.",
  ARQUIVO_TRUNCADO: "O arquivo parece truncado ou vazio.",
  FORMATO_INVALIDO: "O arquivo não é um backup válido do PostgreSQL.",
  ARQUIVO_ILEGIVEL: "Não foi possível ler o backup — pode estar corrompido ou de uma versão incompatível.",
  SEM_DADOS: "Esse arquivo não contém dados de pedidos/produtos/PDVs.",
  DESTINO_TEM_DADOS: "O banco já contém dados. Confirme explicitamente para sobrescrever.",
  RESTAURACAO_FALHOU: "A restauração falhou. Nenhum dado foi alterado.",
  BACKUP_FALHOU: "Não foi possível gerar o backup."
};

// Converte um BackupError em resposta HTTP amigavel; erros nao previstos sobem para o handler central
function responderErroBackup(res, error) {
  if (error instanceof BackupError) {
    const status = error.codigo === "DESTINO_TEM_DADOS" ? 409 : 400;
    return send(res, status, {
      error: mensagensAmigaveis[error.codigo] || error.message,
      codigo: error.codigo,
      detalhe: error.detalhe || undefined
    });
  }
  throw error;
}

export async function handleBackupRoutes(req, res, context) {
  const { method, requireUser, url } = context;

  // Lista os backups existentes em backups/ para a tela de restauracao escolher
  if (url.pathname === "/api/admin/backup/listar" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    send(res, 200, { backups: listarBackups() });
    return true;
  }

  // Gera um novo backup completo (estrutura + dados) do banco atual
  if (url.pathname === "/api/admin/backup/gerar" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    try {
      const resultado = await gerarBackupCompleto({
        databaseUrlOrigem: process.env.DATABASE_URL,
        motivo: String(body.motivo || "").trim().slice(0, 200)
      });
      send(res, 200, resultado);
    } catch (error) {
      responderErroBackup(res, error);
    }
    return true;
  }

  // Valida um arquivo de backup sem tocar em banco nenhum -- primeiro passo antes de restaurar
  if (url.pathname === "/api/admin/backup/validar" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    try {
      const caminho = resolverCaminhoBackup(body.caminho);
      const validacao = validarArquivoBackup(caminho);
      send(res, 200, validacao);
    } catch (error) {
      responderErroBackup(res, error);
    }
    return true;
  }

  // Confere se o banco atual ja tem dados -- a interface usa isso para decidir se pede confirmacao
  if (url.pathname === "/api/admin/backup/destino-tem-dados" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const estado = await bancoDestinoTemDados(process.env.DATABASE_URL);
    send(res, 200, estado);
    return true;
  }

  // Restaura o backup no banco deste servidor. Sobrescrever um banco com dados exige
  // confirmarSobrescrita=true explicito no corpo da requisicao -- sem isso, e recusado.
  if (url.pathname === "/api/admin/backup/restaurar" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const body = await readBody(req);
    try {
      const caminho = resolverCaminhoBackup(body.caminho);
      const resultado = await restaurarBackup({
        caminhoArquivo: caminho,
        databaseUrlDestino: process.env.DATABASE_URL,
        confirmarSobrescrita: body.confirmarSobrescrita === true,
        ensureAllRuntimeTables
      });
      send(res, 200, resultado);
    } catch (error) {
      responderErroBackup(res, error);
    }
    return true;
  }

  return false;
}

// Fotos e assinaturas dos cadastros do MyControl.
//
// O binário vai para o MESMO serviço de storage das fotos de avaria (driver e limites de
// storage.config.js; tipo real conferido pelos bytes em validateImage) e o banco guarda só a
// chave em mc_arquivos -- nunca base64. O cadastro aponta para o id de mc_arquivos.
//
// PROTEÇÃO CONTRA ENVIO DE OUTRO SITE (equivalente ao "JSON obrigatório" das outras rotas): o
// upload é o corpo binário da imagem com Content-Type image/jpeg, image/png ou image/webp.
// Um formulário ou fetch "simples" de outra origem só consegue mandar text/plain,
// form-urlencoded ou multipart; qualquer outro tipo exige preflight de CORS, e o servidor não
// responde CORS -- então uma página maliciosa não consegue enviar arquivo com o cookie de quem
// está logado. A rota recusa (415) qualquer tipo fora dessa lista.
import crypto from "node:crypto";
import { getStorageService } from "../storage/storage.service.js";
import { getStorageConfig } from "../storage/storage.config.js";
import { erroMc } from "./usuarios.service.js";

// Tipos aceitos no cabeçalho do upload (o tipo real ainda é conferido pelos bytes)
export const TIPOS_IMAGEM = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

// Miniatura é pequena de propósito: acima disso não é miniatura
const LIMITE_MINIATURA_BYTES = 512 * 1024;

// Content-Type do pedido é uma imagem aceita?
export function tipoDeImagemAceito(req) {
  const tipo = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  return TIPOS_IMAGEM.includes(tipo);
}

// Limite do upload: o mesmo UPLOAD_MAX_IMAGE_MB das fotos de avaria
export function limiteImagemBytes() {
  return getStorageConfig().maxImageBytes;
}

// Lê o corpo binário com teto: passou do limite, corta a conexão (413) em vez de acumular memória
export async function lerCorpoImagem(req, limite = limiteImagemBytes()) {
  const partes = [];
  let total = 0;
  for await (const pedaco of req) {
    total += pedaco.length;
    if (total > limite) {
      req.destroy();
      throw erroMc(413, "Imagem grande demais. Envie uma foto menor.");
    }
    partes.push(Buffer.from(pedaco));
  }
  return Buffer.concat(partes);
}

// Salva a imagem principal (foto ou assinatura) e registra em mc_arquivos
export async function salvarArquivo(client, { ator, entidade, papel, buffer }) {
  const salvo = await getStorageService().saveImage({ buffer, originalName: papel, folder: `mycontrol/${entidade}` });
  const { rows } = await client.query(
    `INSERT INTO mc_arquivos (entidade, papel, storage_key, mime, tamanho, largura, altura, sha256, criado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, entidade, papel, mime, tamanho`,
    [entidade, papel, salvo.storageKey, salvo.mimeType, salvo.sizeBytes, salvo.width, salvo.height, salvo.sha256, ator.id]
  );
  return rows[0];
}

// Anexa a miniatura (gerada no navegador) a uma foto já enviada da mesma entidade
export async function salvarMiniatura(client, { entidade, id, buffer }) {
  if (buffer.length > LIMITE_MINIATURA_BYTES) throw erroMc(413, "Miniatura grande demais.");
  const { rows } = await client.query("SELECT id, entidade, papel, miniatura_key FROM mc_arquivos WHERE id = $1 FOR UPDATE", [id]);
  const arquivo = rows[0];
  if (!arquivo || arquivo.entidade !== entidade || arquivo.papel !== "foto") throw erroMc(404, "Foto não encontrada.");
  // A miniatura é gravada uma vez só, logo após a foto: trocar depois permitiria a lista mostrar
  // uma imagem diferente da foto de verdade de um cadastro já salvo
  if (arquivo.miniatura_key) throw erroMc(409, "Esta foto já tem miniatura. Envie a foto de novo para trocar.");
  const salvo = await getStorageService().saveImage({ buffer, originalName: "miniatura", folder: `mycontrol/${entidade}/miniaturas` });
  await client.query("UPDATE mc_arquivos SET miniatura_key = $2, miniatura_mime = $3 WHERE id = $1", [id, salvo.storageKey, salvo.mimeType]);
  return { id };
}

// Copia a assinatura do cadastro do colaborador para um registro de uso. É uma cópia REAL: objeto
// novo no storage (pasta única por cópia, então nem dois registros compartilham o arquivo) e
// linha própria em mc_arquivos com papel assinatura_registro. Trocar a assinatura do cadastro
// depois cria outro arquivo lá e não toca nesta cópia.
export async function copiarAssinaturaParaRegistro(client, { ator, assinaturaId }) {
  const original = await carregarArquivo(client, assinaturaId);
  if (!original || original.papel !== "assinatura") throw erroMc(400, "O colaborador não tem assinatura no cadastro. Atualize o cadastro antes de registrar.");
  const storage = getStorageService();
  const conteudo = await storage.readFile(original.storage_key);
  const salvo = await storage.saveImage({ buffer: conteudo, originalName: "assinatura", folder: `mycontrol/registro/assinaturas/${crypto.randomUUID()}` });
  const { rows } = await client.query(
    `INSERT INTO mc_arquivos (entidade, papel, storage_key, mime, tamanho, largura, altura, sha256, criado_por)
     VALUES ('registro', 'assinatura_registro', $1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [salvo.storageKey, salvo.mimeType, salvo.sizeBytes, salvo.width, salvo.height, salvo.sha256, ator.id]
  );
  return rows[0].id;
}

// Carrega o registro de um arquivo (sem ler o binário)
export async function carregarArquivo(client, id) {
  const { rows } = await client.query("SELECT * FROM mc_arquivos WHERE id = $1", [id]);
  return rows[0] || null;
}

// Lê o binário do storage (a miniatura, se pedida e existente; senão a imagem principal)
export async function lerBinario(arquivo, { miniatura = false } = {}) {
  const usarMiniatura = miniatura && arquivo.miniatura_key;
  const conteudo = await getStorageService().readFile(usarMiniatura ? arquivo.miniatura_key : arquivo.storage_key);
  return { conteudo, mime: usarMiniatura ? arquivo.miniatura_mime : arquivo.mime };
}

// Gera um backup COMPLETO do banco (estrutura + dados), usado para mover a operacao de maquina
// ou como rede de seguranca antes de uma mudanca de estrutura.
//
// Wrapper fino sobre server/services/backup/backup.service.js -- a mesma implementacao e usada
// pela rota HTTP (server/modules/backup/backup.routes.js).
//
// Uso: node tools/gerar-backup-completo.mjs [--motivo "texto curto"]
import "../server/env.js";
import { gerarBackupCompleto } from "../server/services/backup/backup.service.js";

const argMotivo = process.argv.indexOf("--motivo");
const motivo = argMotivo !== -1 ? (process.argv[argMotivo + 1] || "") : "";

const resultado = await gerarBackupCompleto({ databaseUrlOrigem: process.env.DATABASE_URL, motivo });
console.log(JSON.stringify(resultado, null, 2));

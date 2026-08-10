// Carrega as variaveis de ambiente do projeto.
//
// Importante: `dotenv/config` sozinho le apenas o arquivo `.env`, que NAO existe
// neste projeto — as configuracoes ficam em `.env.local`. Sem isso, DATABASE_URL
// ficava vazia e a conexao caia no fallback legado do `.streamlit/secrets.toml`
// (o banco antigo da nuvem), mesmo com o `.env.local` correto.
//
// Tambem resolve os caminhos a partir da raiz do projeto, e nao do diretorio
// atual, para funcionar igual quando rodado como servico do Windows ou por
// scripts de tools/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const raizProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// dotenv nunca sobrescreve o que ja existe no ambiente: quem definir primeiro, vence.
// A ordem abaixo faz o .env.local ter prioridade sobre o .env.
dotenv.config({ path: path.join(raizProjeto, ".env.local") });
dotenv.config({ path: path.join(raizProjeto, ".env") });

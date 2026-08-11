# MyEstoque

Sistema de gestão de estoque e pedidos para PDVs (pontos de venda) e Almoxarifado (depósito central), com integração opcional com a OMIE (ERP). Frontend em JS puro (ES modules, sem bundler), backend em Node.js `http` nativo, banco PostgreSQL.

## Requisito permanente: sistema como aplicativo local instalável

**Não pergunte de novo sobre isso — é um requisito fixo do projeto:**

- O sistema deve rodar como um **aplicativo local instalável**, não como "acessar um site pelo navegador". O usuário não deve precisar digitar URL, abrir navegador manualmente, nem iniciar servidor nenhuma vez — tudo isso já deve estar pronto.
- **Servidor**: sempre ativo como serviço do Windows (NSSM, serviço `MyEstoque`), inicia sozinho no boot da máquina, sem exigir login nem ação do usuário. Ver [DEPLOY_LOCAL.md](DEPLOY_LOCAL.md).
- **"Aplicativo"**: app desktop próprio em Electron, na pasta `desktop-app/` — janela própria sem abas nem barra de endereço, ícone gerado da logo do sistema (`public/logo-print.png` → `desktop-app/icone.ico` via `gerar-icone.ps1`). Distribuído como instalador NSIS (`desktop-app/dist/MyEstoque Setup 1.0.0.exe`), que cria atalhos na área de trabalho e no menu Iniciar.
- O app é só a casca: **não inicia servidor nenhum**, só abre a interface. O endereço do servidor é configurável pelo menu (salvo por máquina, padrão `http://192.168.1.207:5173`), então um único instalador serve Almoxarifado e PDVs. Ver seção 6 do [DEPLOY_LOCAL.md](DEPLOY_LOCAL.md) para instalar e recompilar.
- **Comunicação em tempo real entre PDVs e Almoxarifado é obrigatória e não pode regredir.** Hoje é via Server-Sent Events (`public/js/services/order-alerts.js` + `server/services/order-alerts/order-alerts.events.js`), com fallback de polling a cada 12s. Qualquer mudança de infraestrutura (rede, deploy, hospedagem) precisa preservar isso — já foi confirmado que funciona bem (ou melhor) num servidor local único e sempre ativo comparado ao ambiente serverless usado no passado.
- Qualquer ferramenta disponível pode ser usada para evoluir isso (compilar `.exe`, gerar ícones, criar serviços do Windows, etc.) — o objetivo final é sempre: **instalável, local, sem passos manuais, tempo real preservado**.

## Stack e estrutura

- **Backend**: `server/index.js` orquestra módulos por domínio em `server/modules/*` (rotas) e `server/services/*` (regras de negócio, integrações, storage). Sem framework — `http` nativo do Node.
- **Frontend**: `public/app.js` é o arquivo principal (grande, ~9200 linhas) com as views/telas. Peças já extraídas para `public/js/**` (state, api client, ui helpers, auth, alerts). Sem bundler — Tailwind, xlsx.js e fontes são carregados via `<script>`/`<link>` em `public/index.html`, hoje **hospedados localmente** em `public/vendor/` e `public/fonts/` (não são mais CDN).
- **Banco**: PostgreSQL, 38 tabelas em produção. A fonte da verdade da estrutura é **`db/estrutura.dump`** (versionado, gerado por `npm run dump:gerar`, validado por `npm run dump:validar`); `db/estrutura.sql` é a mesma coisa em texto, só para revisar diffs no Git. O `server/schema.sql` é **legado e incompleto** — declara 37 das 38 tabelas (não cria `pedido_auditoria`, que nasce em runtime) e não reproduz índices/constraints/defaults com fidelidade. Nunca recrie um banco só por ele. Depois de qualquer restore é **obrigatório** rodar `ALTER TABLE ... OWNER TO myestoque_app` em todas as tabelas e sequences: 14 tabelas têm RLS ligada e zero políticas (herança do Supabase), então quem não é dono lê zero linhas e o sistema sobe sem enxergar dado nenhum. Ver [DEPLOY_LOCAL.md](../docs/DEPLOY_LOCAL.md).
- **Backup completo**: `node tools/gerar-backup-completo.mjs --motivo "..."` gera estrutura+dados em `backups/` (pasta ignorada pelo Git — contém dados reais) junto com um `.json` de manifesto com os totais. Rode sempre antes de qualquer mudança de estrutura.
- **Restauração de backup**: `server/services/backup/backup.service.js` (`validarArquivoBackup`, `bancoDestinoTemDados`, `restaurarBackup`) é o serviço que o instalador vai usar — nunca rodar `pg_restore` cru na mão. Recusa arquivo inválido antes de tocar em banco, exige `confirmarSobrescrita: true` explícito se o destino já tem dados, reatribui dono automaticamente, e roda `ensureAllRuntimeTables()` (`server/services/backup/runtime-schema.service.js`) para recuperar tabelas de runtime que backups antigos não tinham. Validar com `npm run backup:validar-restauracao` — sempre contra banco descartável, nunca produção.
- **Credenciais do banco**: via `DATABASE_URL` no `.env.local`. É sempre obrigatória — não existe mais fallback para outro banco; se `server/db.js` não encontrar `DATABASE_URL`, ele recusa subir (erro explícito), em vez de cair silenciosamente em outra conexão.
- **Carregamento do `.env`**: use sempre `import "./env.js"` (`server/env.js`), nunca `dotenv/config` direto. O `dotenv/config` lê só o arquivo `.env`, que não existe neste projeto — a configuração fica em `.env.local`. Isso já causou o sistema inteiro rodar no banco da nuvem sem ninguém perceber. O `server/env.js` resolve os caminhos a partir da raiz do projeto, então funciona igual no serviço do Windows e em scripts de `tools/`.
## Deploy

- **Único caminho de hospedagem: rede local (LAN).** O projeto não usa mais Vercel nem Supabase — foram removidos definitivamente do código, config e docs (não há `vercel.json`, `api/index.js` nem adapter de Supabase no repositório). Veja [DEPLOY_LOCAL.md](../docs/DEPLOY_LOCAL.md). O servidor roda como serviço do Windows (NSSM, nome do serviço `MyEstoque`) — sempre ativo, inicia sozinho no boot, ninguém precisa iniciar nada manualmente. Banco é PostgreSQL local (usuário `myestoque_app`).
- `NODE_ENV=production` é seguro no local: o cookie de sessão só fica `secure` se `FORCE_SECURE_COOKIES=true` — não depende de `NODE_ENV` (isso foi corrigido de propósito para não quebrar login em HTTP puro na LAN).
- Integração OMIE: sincronização é **oportunista** — só funciona quando há internet, nunca deve travar o resto do sistema quando não há. Variável correta é `OMIE_SCHEDULER_ENABLED` (não `OMIE_AUTO_SCHEDULER`, que é nome antigo/morto).

## Comandos

- `npm run dev` — inicia o servidor (`node server/index.js`), porta padrão 5173.
- `npm test` / `node tests/server-routes.test.js` — testes principais.
- `npm run test:sequential` — roda todos os `tests/*.test.js` um a um.
- `npm run format` / `format:check` — Prettier.

## Convenções deste projeto

- **Comentar o código**: o usuário pediu explicitamente que todo o código tenha comentários curtos (uma linha, em português, acima de funções/rotas/blocos não óbvios) — isso é diferente do padrão geral de "sem comentários" e vale só para este projeto.
- Comentários e mensagens de erro voltadas ao usuário: em português.
- Cuidado ao criar pastas com `node_modules` symlinkado dentro do repo (já causou um bug de crash em uma suíte de testes, resolvido removendo a pasta problemática).
- Há um Skill do projeto em `.claude/skills/myestoque-ops/` com comandos operacionais prontos (checar saúde, reiniciar serviço, rodar testes, refazer migração do banco).
- Há um hook em `.claude/settings.json` que roda a suíte de testes automaticamente antes de qualquer `git commit` e bloqueia o commit se algo falhar.

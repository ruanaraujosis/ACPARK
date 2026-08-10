---
name: myestoque-ops
description: Operational tasks for the MyEstoque LAN deployment on this machine — check service/DB health, run the test suite, restart the server after backend code changes, or redo the local Postgres migration from scratch. Use when the user asks to check if the system is up, restart it, run its tests, or redeploy locally.
---

# MyEstoque — operação local

Este projeto roda como serviço do Windows (NSSM, nome `MyEstoque`), sempre ativo, banco PostgreSQL local. Veja [DEPLOY_LOCAL.md](../../DEPLOY_LOCAL.md) para o guia completo de infraestrutura e [CLAUDE.md](../../CLAUDE.md) para contexto geral do projeto.

## Checar se o sistema está no ar

```bash
curl -s http://127.0.0.1:5173/api/health
```
Deve responder `{"ok":true,"db":true}`. Se `db:false` ou erro de conexão, o Postgres local pode estar parado — verificar `Get-Service postgresql-x64-17`.

## Ver status do serviço

```powershell
Get-Service MyEstoque
```

## Reiniciar o servidor (necessário depois de mudanças em arquivos `server/**`)

Arquivos estáticos (`public/**`) são servidos direto do disco a cada requisição — não precisa reiniciar para eles. Mudanças em `server/**` (rotas, lógica de backend) só entram em vigor depois de reiniciar o processo, porque os módulos ES são carregados uma vez na inicialização.

```powershell
Restart-Service MyEstoque
Start-Sleep -Seconds 2
curl http://127.0.0.1:5173/api/health
```

Reiniciar o serviço requer PowerShell como Administrador — se não tiver, peça para o usuário rodar.

## Rodar a suíte de testes

```bash
cd "C:\Users\User\Documents\MyEstoque"
npm run test:sequential
```
Roda todos os `tests/*.test.js`. Deve dar 24/24 (sem falhas pré-existentes conhecidas no momento em que este skill foi escrito).

## Refazer a migração do banco local do zero

Só necessário se o banco local `myestoque` for corrompido/perdido e precisar recriar a partir de um backup (`.dump`). Ver seção "Restaurar o banco a partir de um dump" em [DEPLOY_LOCAL.md](../../../docs/DEPLOY_LOCAL.md) — **importante**: restaurar sempre schema+dados a partir de um dump real (`pg_dump`/`pg_restore` completo), nunca só `server/schema.sql`, porque esse arquivo está desatualizado em relação a tabelas/colunas criadas em tempo de execução pelo próprio código (`ensureXxxTable()` nos arquivos de rotas). Depois de restaurar, sempre rodar `REASSIGN`/`ALTER TABLE ... OWNER TO myestoque_app` em todas as tabelas, senão políticas de RLS herdadas do banco de origem podem deixar as tabelas inacessíveis para o usuário da aplicação.

## Credenciais

- Senha do Postgres local (`myestoque_app` e `postgres` superuser): não estão neste repositório por segurança — pedir ao usuário se precisar, ou usar as já configuradas em `.env.local` (`DATABASE_URL`).
- Nunca escrever senhas reais diretamente em comandos de terminal (Bash/PowerShell) — usar um script `.mjs`/`.env` que leia o valor, e rodar o script via `node caminho.mjs`. Colocar a senha literal na linha de comando do terminal é bloqueado pela política de segurança do harness.

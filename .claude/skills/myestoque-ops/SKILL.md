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

**Nunca reinicie o serviço desta máquina por conta própria quando ela for a produção real** — peça ao usuário, explique o impacto (sistema fora do ar por poucos segundos) e só prossiga com confirmação explícita dele.

```powershell
Restart-Service MyEstoque
Start-Sleep -Seconds 2
curl http://127.0.0.1:5173/api/health
```

Desde que a ACL do serviço foi ajustada (ver seção 1.1 do [DEPLOY_LOCAL.md](../../../docs/DEPLOY_LOCAL.md)), esse comando não exige mais PowerShell como Administrador — funciona em conta comum. Se o comando falhar com "Não é possível abrir o serviço", a ACL ainda não foi aplicada nesta máquina; peça para o usuário rodar como Administrador (comando na mesma seção).

Além disso, o classificador de segurança do Claude Code bloqueia `Restart-Service`/`sc.exe sdset` mesmo com elevação — são ações que exigem confirmação explícita do usuário a cada vez, não só permissão de sistema.

## Rodar a suíte de testes

```bash
cd "C:\Users\User\Documents\MyEstoque"
npm run test:sequential
```
Roda todos os `tests/*.test.js`. O placar sobe conforme testes são adicionados — confira o resumo impresso ao final (`Aprovados: N / Arquivos executados: N`), não um número fixo aqui.

## Gerar backup completo antes de mexer na estrutura

```bash
node tools/gerar-backup-completo.mjs --motivo "descreva por que"
```

Grava em `backups/` (fora do Git — contém dados reais). Obrigatório antes de qualquer migração de estrutura na produção.

## Refazer a migração do banco local do zero

Só necessário se o banco local `myestoque` for corrompido/perdido e precisar recriar a partir de um backup (`.dump`). Ver seção "Estrutura do banco: o dump versionado é a fonte da verdade" em [DEPLOY_LOCAL.md](../../../docs/DEPLOY_LOCAL.md) — **importante**: a fonte da verdade da estrutura é `db/estrutura.dump` (versionado, gerado por `npm run dump:gerar`), não `server/schema.sql`, que é legado e incompleto. Depois de restaurar, sempre rodar `ALTER TABLE ... OWNER TO myestoque_app` em todas as tabelas e sequences, senão políticas de RLS herdadas do banco de origem deixam as tabelas inacessíveis para o usuário da aplicação. `npm run dump:validar` automatiza essa validação inteira num banco temporário.

## Credenciais

- Senha do Postgres local (`myestoque_app` e `postgres` superuser): não estão neste repositório por segurança — pedir ao usuário se precisar, ou usar as já configuradas em `.env.local` (`DATABASE_URL`).
- Nunca escrever senhas reais diretamente em comandos de terminal (Bash/PowerShell) — usar um script `.mjs`/`.env` que leia o valor, e rodar o script via `node caminho.mjs`. Colocar a senha literal na linha de comando do terminal é bloqueado pela política de segurança do harness.

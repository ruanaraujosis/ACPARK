---
name: myestoque-git
description: Informações de Git e GitHub deste projeto — conta ativa do gh CLI, dono do repositório, nome legado ACPARK, branches em uso e convenções de commit/push. Use antes de qualquer operação de git/GitHub (push, PR, clone, transferência de repo, checar remote) para não usar a conta errada ou assumir dados desatualizados.
---

# MyEstoque — Git e GitHub

## Repositório

- **Nome no GitHub**: `ACPARK` (nome legado, de antes do projeto se chamar MyEstoque — **não é
  engano**, não renomear sem pedir).
- **Dono atual**: `ruanaraujosis`. Remote: `https://github.com/ruanaraujosis/ACPARK.git`.
- Repositório é **público**. Ver [myestoque-seguranca](../myestoque-seguranca/SKILL.md) para o que
  isso implica (segredos nunca versionados, senhas de seed antigo já públicas no histórico).
- Branch padrão: `main`.
- Transferido em 2026-08-18 da conta antiga `ruanaraujosenacgo-afk` para `ruanaraujosis` (transfer
  nativo do GitHub, histórico/branches preservados). Se algum comando `gh`/`git` falhar com 403 ou
  "not found" contra `ruanaraujosenacgo-afk/ACPARK`, é sinal de comando ou URL desatualizado — o dono
  correto hoje é `ruanaraujosis`.

## Conta do `gh` CLI nesta máquina

Só `ruanaraujosis` fica autenticada nesta máquina — é a dona do repositório e deve ser sempre a conta
ativa para push/PR/API contra `ACPARK`. A conta antiga (`ruanaraujosenacgo-afk`) foi removida dos
colaboradores do repositório e deslogada do `gh` CLI local em 2026-08-18 (já não tem nenhum vínculo
com o projeto).

Antes de qualquer operação que precise de permissão de escrita (push, criar PR, `gh api` mutando
algo), confirme a conta ativa:

```bash
gh auth status
```

Se `ruanaraujosis` não estiver marcada `Active account: true`, troque antes de prosseguir:

```bash
gh auth switch --hostname github.com --user ruanaraujosis
```

Git usa o `gh` como credential helper para `https://github.com`, então trocar a conta ativa do `gh`
também troca qual conta o `git push`/`git fetch` usa — não precisa reconfigurar remote nem token à
parte.

## Branches

Além de `main`, o repositório costuma ter branches de trabalho no padrão `codex/<descrição>` (gerados
por sessões anteriores de agente) e branches de feature como `feat/<descrição>`. Para ver o estado
atual, sempre confira ao vivo em vez de assumir uma lista fixa (branches mudam com frequência):

```bash
git branch -a
```

## Convenções de commit e push

- Só criar commits quando o usuário pedir explicitamente — nunca committar proativamente.
- Há um hook em `.claude/settings.json` que roda a suíte de testes automaticamente antes de qualquer
  `git commit` e bloqueia o commit se algo falhar. Não usar `--no-verify` para contornar; investigar a
  falha.
- Nunca fazer `push --force` sem confirmação explícita do usuário a cada vez.
- Segredos: `.gitignore` cobre `.env*` — nunca remover essa cobertura nem commitar um `.env*` mesmo
  que o usuário peça "só dessa vez".

## Transferir/mudar de dono de novo (se precisar no futuro)

Só o dono atual pode iniciar a transferência (`gh api repos/<dono-atual>/ACPARK/transfer -X POST -f
new_owner=<novo-dono>`). Se o destino for conta de usuário (não organização), a transferência fica
**pendente até o destino aceitar** — o corpo de resposta da API continua mostrando o dono antigo até
o aceite; isso não é falha. Confirmar o aceite consultando de novo:
`gh api repos/<novo-dono>/ACPARK --jq .owner.login`.

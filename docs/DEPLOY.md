# Deploy na Vercel

## Variaveis de ambiente

Configure estas variaveis no painel da Vercel em **Project Settings > Environment Variables**:

- `DATABASE_URL`: conexao PostgreSQL em formato URL.
- `JWT_SECRET`: segredo longo para assinar sessoes de login.
- `NODE_ENV`: `production`.
- `SCHEMA_SYNC`: opcional, `true` se voce quiser que o schema rode automaticamente fora da Vercel.

Exemplo de `JWT_SECRET`: use uma frase/chave longa e exclusiva, sem compartilhar.

Para a `DATABASE_URL`, prefira a URL de **pooler** do seu provedor de Postgres, se ele oferecer uma. Em ambiente serverless, ela evita excesso de conexoes e tende a ser mais estavel que a conexao direta do banco.
Na Vercel, o schema nao roda automaticamente por padrao. Se o banco ja estiver criado, deixe assim. Se quiser ligar a sincronizacao automatica fora da Vercel, use `SCHEMA_SYNC=true`.

## Publicacao

1. Envie o projeto para um repositorio Git.
2. Na Vercel, clique em **Add New > Project**.
3. Importe o repositorio.
4. Framework preset: **Other**.
5. Build command: deixe vazio.
6. Output directory: deixe vazio.
7. Adicione as variaveis de ambiente.
8. Clique em **Deploy**.

## Teste da conexao

Depois do deploy, abra:

`/api/health`

Se estiver tudo certo, a resposta deve trazer algo como:

```json
{ "ok": true, "db": true }
```

Se retornar erro, revise principalmente `DATABASE_URL` e se o projeto da Vercel recebeu as variaveis no ambiente correto.

## Acesso interno

O sistema continua protegido por login. Nao existe cadastro publico: apenas PDVs criados pelo Almoxarifado e o usuario do Almoxarifado conseguem entrar.

Para uma camada extra, ative **Deployment Protection** na Vercel se quiser bloquear a pagina antes mesmo do login do sistema.

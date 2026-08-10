# Storage das fotos de avarias

Este projeto nao deve migrar fotos de avarias para `STORAGE_DRIVER=local` em producao/Vercel.
O disco local e util para desenvolvimento, mas nao e duravel no deploy.

## Bucket criado

Bucket privado criado no Supabase:

```text
avarias-fotos
```

Configuracao aplicada no bucket:

- `public = false`
- limite de arquivo: `8 MB`
- MIME types: `image/jpeg`, `image/png`, `image/webp`

## Variaveis de producao

Configure no ambiente de producao com Supabase Storage:

```env
STORAGE_DRIVER=supabase
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=configure-apenas-no-servidor
STORAGE_BUCKET=avarias-fotos
UPLOAD_MAX_IMAGE_MB=8
UPLOAD_MAX_IMAGES_PER_ITEM=12
```

`SUPABASE_SERVICE_ROLE_KEY` nunca deve ir para o frontend.

Para S3/R2 compativel, use:

```env
STORAGE_DRIVER=s3
STORAGE_ENDPOINT=https://endpoint-s3-compativel
STORAGE_BUCKET=nome-do-bucket
STORAGE_REGION=auto
STORAGE_ACCESS_KEY=chave-de-acesso
STORAGE_SECRET_KEY=chave-secreta
UPLOAD_MAX_IMAGE_MB=8
UPLOAD_MAX_IMAGES_PER_ITEM=12
```

`STORAGE_DRIVER` aceita `supabase`, `s3` ou `r2`.

## Verificacao antes de migrar

Rode primeiro:

```bash
npm run storage:check
```

O comando envia uma imagem pequena, le de volta, compara o conteudo e remove o arquivo de teste.
Se falhar, nao execute a migracao.

Tambem rode:

```bash
npm run production:check
```

Esse comando verifica banco, JWT e storage sem imprimir segredos.

## Simulacao da migracao

```bash
npm run migrate:avaria-photos
```

Esse modo nao grava arquivos nem altera dados. Ele apenas informa quantas fotos legadas seriam migradas.

## Migracao definitiva

Depois de backup e storage validado:

```bash
node tools/migrate-avaria-photos.js --apply
```

O script e idempotente: se a foto ja tiver sido migrada para o item com o mesmo `sha256`, ela nao e duplicada.

## O que a migracao nao faz

- Nao apaga o campo legado `fotos`.
- Nao remove base64 antigo.
- Nao exclui arquivos.
- Nao finaliza devolucoes.
- Nao altera status.

## Rollback

Como o campo legado `fotos` permanece intacto, o rollback imediato e:

1. Voltar `STORAGE_DRIVER` para o valor anterior.
2. Ignorar registros em `devolucao_avaria_fotos`.
3. Restaurar o backup JSON em `.codex-temp/db-backups/`, se algum dado operacional tiver sido alterado manualmente.

Remocao de base64 antigo so deve acontecer em uma etapa futura, apos validacao de relatorios, historico, impressao e anexos.

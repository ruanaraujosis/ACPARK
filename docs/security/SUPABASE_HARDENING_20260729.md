# ACPARK Supabase Hardening - 2026-07-29

Este documento registra a auditoria e o plano de homologacao para corrigir os alertas dos Supabase Advisors sem alterar diretamente a producao.

## Escopo

- Nao aplicar alteracoes diretamente no Supabase de producao.
- Nao publicar no Vercel automaticamente.
- Criar migracoes reversiveis para homologacao.
- Preservar backend, pedidos, estoque, avarias, alertas, OMIE e Storage.
- Arquivar estruturas legadas antes de remover definitivamente.

## Como o ACPARK acessa o Supabase

| Consumidor | Mecanismo | Variaveis | Observacao |
| --- | --- | --- | --- |
| Frontend | Rotas HTTP do ACPARK | Nenhuma chave Supabase encontrada no frontend | Nao usa `supabase-js` no navegador. |
| Servidor Node | PostgreSQL direto via `pg` | `DATABASE_URL` | Backend valida sessao, perfil e PDV nas rotas. |
| Storage de fotos | REST Storage no backend | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_BUCKET` | Chave elevada fica no servidor. |
| Jobs OMIE | Banco via backend | `DATABASE_URL` | Jobs sao internos. |
| Scripts locais | Banco/Storage via servidor ou env local | `DATABASE_URL`, `SUPABASE_*` quando necessario | Nao devem expor chaves. |
| Realtime | Nao identificado | N/A | Nenhum uso ativo encontrado. |
| Edge Functions | Nao identificado | N/A | Nenhum uso ativo encontrado. |
| RPC | Funcoes SQL antigas | `registrar_movimentacao_orion` | Legado do fluxo Orion direto; deve ser bloqueado/arquivado. |

## Variaveis localizadas

- `DATABASE_URL`: usada por `server/db.js`.
- `SUPABASE_URL`: usada pelo adapter de Storage no backend.
- `SUPABASE_SERVICE_ROLE_KEY`: usada pelo adapter de Storage no backend.
- `STORAGE_BUCKET`: usada pelo adapter de Storage.

Nao foram encontradas referencias ativas a:

- `SUPABASE_ANON_KEY`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `POSTGRES_URL`
- `sb_secret_`
- `sb_publishable_`

## Protecao de chaves

Resultado da varredura:

- Nenhuma chave real foi encontrada no codigo-fonte.
- `.env`, `.env.local` e equivalentes estao cobertos por `.gitignore`.
- `.env.example` contem nomes e placeholders.
- `SUPABASE_SERVICE_ROLE_KEY` aparece apenas em codigo de backend, documentacao e testes com valor falso.
- O frontend nao le variaveis Supabase.

Plano de rotacao:

1. Criar nova chave secreta especifica para o backend/Storage.
2. Configurar em homologacao.
3. Testar login, pedidos, avarias, fotos, Storage e OMIE.
4. Configurar no Vercel em producao.
5. Publicar em janela controlada.
6. Monitorar erros 401, 403, 500 e falhas de upload.
7. Revogar chave antiga somente depois da validacao.

## Storage

Bucket auditado:

| Bucket | Publico | Limite | MIME types |
| --- | --- | --- | --- |
| `avarias-fotos` | Nao | 8 MB | `image/jpeg`, `image/png`, `image/webp` |

Decisao:

- Manter bucket privado.
- Nao criar politica publica em `storage.objects`.
- Continuar upload/leitura pelo backend.
- Validar autorizacao nas rotas antes de salvar ou entregar fotos.

## Advisors de seguranca

### RLS desativado

Tabelas publicas identificadas sem RLS:

- `categorias`
- `devolucao_avaria_itens`
- `pdv_categorias`
- `devolucao_avaria_fotos`
- `estoque_avarias`
- `devolucao_avaria_historico`
- `pedido_idempotencia`
- `devolucao_idempotencia`
- `devolucoes_avaria`
- `omie_jobs`
- `pedido_rascunhos`
- `pedido_impressao_jobs`
- `pedido_impressao_historico`
- `product_integration_mappings`
- `omie_stock_locations`
- `pdv_stock_location_mappings`
- `stock_movements`
- `stock_snapshots`
- `stock_movement_items`
- `stock_reconciliations`
- `stock_reconciliation_items`
- `pedido_operacao_idempotencia`
- `pedido_historico`
- `stock_refresh_queue`
- `product_sync_temperature`
- `order_alert_sounds`
- `user_order_alert_preferences`
- `produto_categorias`

### RLS ativo sem politica

Essas tabelas ja estao com RLS ativo e sem acesso para `anon`/`authenticated`. A decisao e manter bloqueio para navegador:

- `integration_attempts`
- `integration_audit_logs`
- `integration_credentials`
- `integration_jobs`
- `integration_metrics`
- `integration_runtime_state`
- `integration_sync_state`
- `integration_webhooks`
- `integrations`
- `security_hardening_backup_privileges`

### Politicas permissivas

Politicas amplas encontradas e planejadas para remocao:

- `authenticated CRUD estoque_pdv`
- `authenticated CRUD logs_atividades`
- `authenticated CRUD pedidos`
- `authenticated CRUD produtos`
- `authenticated CRUD solicitacoes`
- `authenticated CRUD vendas_orion`

Decisao:

- Como o ACPARK nao usa Supabase diretamente no navegador, o acesso direto por `anon` e `authenticated` sera bloqueado.
- Regras por PDV, almoxarifado e administrador continuam obrigatoriamente no backend.
- Nao criar politicas `USING (true)` para silenciar advisor.

## Inventario resumido por tabela

| Tabela | Classificacao | Modulo | Acesso esperado | RLS atual | Acao |
| --- | --- | --- | --- | --- | --- |
| `pdvs` | Operacional | Login/PDV/Admin | Backend | Ativo | Manter bloqueado ao navegador |
| `produtos` | Operacional | Produtos/Estoque/Pedidos | Backend | Ativo com politica ampla | Remover CRUD amplo |
| `estoque_pdv` | Operacional | Estoque/Pedidos | Backend | Ativo com politica ampla | Remover CRUD amplo |
| `pedidos` | Operacional | Pedidos | Backend | Ativo com politica ampla | Remover CRUD amplo |
| `solicitacoes` | Legada/operacional | Estoque antigo | Backend | Ativo com politica ampla | Remover CRUD amplo |
| `logs_atividades` | Auditoria | Logs | Backend | Ativo com politica ampla | Bloquear navegador |
| `categorias` | Operacional | Categorias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `pdv_categorias` | Operacional | PDV/Categorias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `produto_categorias` | Operacional | Produtos/Categorias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `pedido_rascunhos` | Interna | Rascunho de pedido | Backend | Desativado | Ativar RLS e bloquear navegador |
| `pedido_idempotencia` | Interna | Idempotencia pedidos | Backend | Desativado | Ativar RLS e bloquear navegador |
| `pedido_operacao_idempotencia` | Interna | Operacoes pedido | Backend | Desativado | Ativar RLS e bloquear navegador |
| `pedido_historico` | Auditoria | Historico pedidos | Backend | Desativado | Ativar RLS e bloquear navegador |
| `devolucoes_avaria` | Operacional | Avarias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `devolucao_avaria_itens` | Operacional | Avarias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `devolucao_avaria_fotos` | Operacional | Fotos avarias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `devolucao_avaria_historico` | Auditoria | Avarias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `devolucao_idempotencia` | Interna | Avarias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `estoque_avarias` | Operacional | Avarias | Backend | Desativado | Ativar RLS e bloquear navegador |
| `integrations` | Integracao | Central APIs | Backend | Ativo sem politica | Justificado como interno |
| `integration_credentials` | Credenciais | Central APIs | Backend | Ativo sem politica | Justificado como interno |
| `integration_jobs` | Fila | OMIE | Backend | Ativo sem politica | Justificado como interno |
| `integration_attempts` | Auditoria | OMIE | Backend | Ativo sem politica | Justificado como interno |
| `integration_webhooks` | Webhooks | OMIE | Backend | Ativo sem politica | Justificado como interno |
| `integration_audit_logs` | Auditoria | Integracoes | Backend | Ativo sem politica | Justificado como interno |
| `integration_metrics` | Observabilidade | Integracoes | Backend | Ativo sem politica | Justificado como interno |
| `integration_runtime_state` | Interna | Integracoes | Backend | Ativo sem politica | Justificado como interno |
| `integration_sync_state` | Interna | Integracoes | Backend | Ativo sem politica | Justificado como interno |
| `omie_jobs` | Fila legada | OMIE antigo | Backend | Desativado | Ativar RLS e revisar legado |
| `omie_stock_locations` | Integracao | OMIE | Backend | Desativado | Ativar RLS e bloquear navegador |
| `product_integration_mappings` | Integracao | OMIE | Backend | Desativado | Ativar RLS e bloquear navegador |
| `pdv_stock_location_mappings` | Integracao | OMIE | Backend | Desativado | Ativar RLS e bloquear navegador |
| `stock_movements` | Integracao/auditoria | OMIE/Estoque | Backend | Desativado | Ativar RLS e bloquear navegador |
| `stock_movement_items` | Integracao/auditoria | OMIE/Estoque | Backend | Desativado | Ativar RLS e bloquear navegador |
| `stock_snapshots` | Integracao/auditoria | OMIE/Estoque | Backend | Desativado | Ativar RLS e bloquear navegador |
| `stock_reconciliations` | Integracao/auditoria | OMIE | Backend | Desativado | Ativar RLS e bloquear navegador |
| `stock_reconciliation_items` | Integracao/auditoria | OMIE | Backend | Desativado | Ativar RLS e bloquear navegador |
| `stock_refresh_queue` | Fila | OMIE | Backend | Desativado | Ativar RLS e bloquear navegador |
| `product_sync_temperature` | Interna | OMIE | Backend | Desativado | Ativar RLS e bloquear navegador |
| `order_alert_sounds` | Operacional | Alertas | Backend | Desativado | Ativar RLS e bloquear navegador |
| `user_order_alert_preferences` | Operacional | Alertas | Backend | Desativado | Ativar RLS e bloquear navegador |
| `pedido_impressao_jobs` | Legada | Print-agent removido | Nenhum | Desativado | Arquivar em homologacao |
| `pedido_impressao_historico` | Legada | Print-agent removido | Nenhum | Desativado | Arquivar em homologacao |
| `vendas_orion` | Legada | Orion direto antigo | Nenhum | Ativo com politica ampla | Bloquear e arquivar em homologacao |

## Funcoes, triggers e views

Funcoes `SECURITY DEFINER` no schema `public`:

- Nenhuma encontrada.

Funcoes legadas identificadas:

- `registrar_movimentacao_orion`
- `processar_baixa_estoque_orion`

Trigger legada identificada:

- `trg_baixa_estoque_orion` em `vendas_orion`

Views expostas no schema `public`:

- Nenhuma view publica retornada pela auditoria.

## Estruturas antigas

### Print-agent

Tabelas encontradas:

- `pedido_impressao_jobs`: estimativa de 10 registros.
- `pedido_impressao_historico`: estimativa de 42 registros.

Codigo local:

- Testes garantem que o backend e schema local nao tenham referencias ativas a essas tabelas.

Acao:

- Arquivar por rename em homologacao.
- Monitorar.
- Remover definitivamente somente com aprovacao posterior.

### Orion direto

Tabela encontrada:

- `vendas_orion`: estimativa de 0 registros.

Dependencias:

- Trigger `trg_baixa_estoque_orion`.
- Funcao `registrar_movimentacao_orion`.
- Funcao `processar_baixa_estoque_orion`.

Acao:

- Revogar execucao publica da funcao.
- Remover trigger em homologacao.
- Arquivar tabela por rename.
- Nao apagar ate homologacao confirmar que nao ha dependencias.

## Advisors de performance

Prioridades:

1. Criar indices para foreign keys sem cobertura.
2. Remover indice duplicado confirmado em `product_integration_mappings`.
3. Nao remover indices apenas por "unused index" sem tempo de observacao.

## Migrações criadas

- `server/migrations/20260729_001_security_inventory.sql`
- `server/migrations/20260729_002_enable_rls_internal_tables.sql`
- `server/migrations/20260729_003_replace_permissive_policies.sql`
- `server/migrations/20260729_004_revoke_browser_internal_access.sql`
- `server/migrations/20260729_005_secure_functions_and_views.sql`
- `server/migrations/20260729_006_add_missing_fk_indexes.sql`
- `server/migrations/20260729_007_archive_legacy_print_tables.sql`
- `server/migrations/20260729_008_archive_orion_table.sql`

## Plano de homologacao

1. Criar backup completo do banco de producao.
2. Restaurar backup em ambiente de homologacao ou branch Supabase.
3. Aplicar `20260729_001_security_inventory.sql`.
4. Executar testes funcionais atuais.
5. Aplicar `002`, `003` e `004`.
6. Testar login, dashboard, produtos, pedidos, estoque, avarias, fotos, alertas e OMIE.
7. Aplicar `005`.
8. Testar que o fluxo Orion direto nao existe mais e que OMIE continua somente leitura.
9. Aplicar `006`.
10. Validar performance basica e advisors.
11. Aplicar `007` e `008`.
12. Monitorar sistema sem tabelas legadas nos nomes antigos.
13. Rodar advisors novamente.
14. Aprovar janela de producao somente depois.

## Execucao local da homologacao

Crie um arquivo local, nao versionado:

```text
.env.homologation.local
```

Com variaveis exclusivas da homologacao:

```text
HOMOLOGATION_DATABASE_URL=postgres://usuario:senha@host-homologacao:5432/banco?sslmode=require
HOMOLOGATION_SUPABASE_URL=https://projeto-homologacao.supabase.co
HOMOLOGATION_SUPABASE_SERVICE_ROLE_KEY=chave-servidor-da-homologacao
```

Antes de aplicar qualquer etapa:

```text
npm run homologation:check
npm run test:sequential
```

Aplicar uma migracao por vez:

```text
npm run homologation:apply -- 20260729_001_security_inventory.sql
npm run test:sequential
```

Repetir a sequencia para cada migracao, sempre parando em caso de erro. O script bloqueia automaticamente o projeto de producao configurado em `SUPABASE_PRODUCTION_PROJECT_REF` (ver `.env.example`).

## Testes por perfil

- `anon`: nao deve ler ou escrever tabelas publicas do ACPARK.
- `authenticated`: nao deve ter CRUD direto generico.
- PDV A: acessa apenas dados via backend e apenas do proprio PDV.
- PDV B: nao acessa dados do PDV A.
- Almoxarifado: acessa operacoes permitidas via backend.
- Administrador: acessa rotas administrativas via backend.
- Backend: continua operando via `DATABASE_URL`.
- Storage: upload/leitura de fotos continua pelo backend.

## Plano de rollback

- Cada migracao contem comentarios de rollback.
- Para grants, usar `security_hardening_backup_privileges_20260729`.
- Para tabelas legadas, renomear `archive_*_20260729` de volta ao nome original.
- Para Orion direto, recriar trigger somente se houver decisao formal de restaurar o fluxo antigo.
- Para indices, remover apenas os indices criados na migracao `006`.

## Riscos restantes

- Confirmar em homologacao qual usuario do banco esta em `DATABASE_URL` e se ele e afetado por RLS.
- O schema local ainda possui `codigo_orion` em `pdvs`; isso pode ser dado historico, mas deve ser revisado separadamente.
- Algumas estruturas OMIE ainda estao em fase de leitura/transicao; nao ativar modo OMIE automaticamente.
- Advisors de "RLS ativo sem politica" podem permanecer como justificativa quando a tabela for interna.

## Referencias

- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Supabase Database Advisors: https://supabase.com/docs/guides/database/database-advisors
- Supabase Storage Access Control: https://supabase.com/docs/guides/storage/security/access-control

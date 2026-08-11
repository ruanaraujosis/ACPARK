# Integrações ACPARK

## Arquitetura Oficial

```text
ORION -> OMIE -> ACPARK
```

O Orion integra diretamente com o OMIE para vendas, cancelamentos e devoluções de venda. O ACPARK não recebe eventos do Orion, não processa vendas e não envia baixas de venda ao OMIE.

O ACPARK usa o OMIE como fonte oficial de produtos, locais, saldos e movimentações. O estoque local permanece como espelho operacional.

## Variáveis De Ambiente

- `INTEGRATION_ENCRYPTION_KEY`: chave usada para criptografar credenciais salvas na Central de Integrações.
- `OMIE_TIMEOUT_MS`: tempo limite das chamadas de leitura.
- `OMIE_BASE_URL`: valor sugerido para novas integrações, normalmente `https://app.omie.com.br/api/v1`.

As credenciais `app_key` e `app_secret` devem ser salvas na Central de Integrações. Elas não são devolvidas pela API e não devem aparecer em logs.

## Central De Integrações

A tela administrativa permite cadastrar várias integrações pelo botão `+ Adicionar integração`.

Tipos iniciais:

- `OMIE`: ERP e estoque.
- `OUTRA`: integração personalizada.

Cada integração guarda:

- nome;
- provedor;
- tipo;
- ambiente;
- url base;
- empresa vinculada;
- status;
- modo de estoque;
- última sincronização;
- último teste de conexão;
- credenciais mascaradas.

O modo de estoque inicia como `MANUAL`. Esta etapa não ativa o modo `OMIE` automaticamente.

## Chamadas OMIE Implementadas

As chamadas são centralizadas em `server/services/integrations/omie/omie.client.js`.

Leituras validadas na documentação oficial do OMIE:

- Produtos: `POST /geral/produtos/`, chamada `ListarProdutos`.
- Locais de estoque: `POST /estoque/local/`, chamada `ListarLocaisEstoque`.
- Saldos: `POST /estoque/consulta/`, chamada `ListarPosEstoque`.
- Movimentos: `POST /estoque/consulta/`, chamada `ListarMovimentoEstoque`.

Referências oficiais:

- O portal lista `Produtos`, `Consulta Estoque`, `Movimento Estoque` e `Locais de Estoque` nos serviços de compras/estoque.
- `ListarProdutos` usa `pagina`, `registros_por_pagina`, `apenas_importado_api` e `filtrar_apenas_omiepdv`.
- `ListarLocaisEstoque` usa `nPagina` e `nRegPorPagina`.
- `ListarPosEstoque` usa `nPagina`, `nRegPorPagina`, `dDataPosicao`, `cExibeTodos` e `codigo_local_estoque`.
- `ListarMovimentoEstoque` usa `nPagina`, `nRegPorPagina`, `codigo_local_estoque`, `idProd`, `dDtInicial`, `dDtFinal` e `lista_local_estoque`.

Existe também o serviço separado `POST /estoque/movestoque/` com a chamada `ListarMovimentos`. Ele foi documentado como alternativa, mas a implementação atual usa `ListarMovimentoEstoque` em `/estoque/consulta/`, porque esse método retorna o conjunto necessário para saldos por produto/local.

O formato segue o padrão OMIE:

```json
{
  "call": "ListarProdutos",
  "app_key": "...",
  "app_secret": "...",
  "param": [
    {
      "pagina": 1,
      "registros_por_pagina": 50
    }
  ]
}
```

## Paginação

Produtos usam os campos `pagina` e `registros_por_pagina`.

Saldos e movimentos usam também os aliases `nPagina` e `nRegPorPagina`, porque os serviços de estoque do OMIE documentam esse padrão.

O processador lê até `total_de_paginas`, `nTotPaginas` ou equivalente retornado pelo OMIE. Movimentos usam uma pequena janela temporal recente e deduplicação por `omie_movement_id` ou chave determinística quando o OMIE não devolver um identificador único.

## Jobs De Leitura

Tipos de job:

- `SYNC_OMIE_PRODUCTS`
- `SYNC_OMIE_LOCATIONS`
- `SYNC_OMIE_STOCK`
- `SYNC_OMIE_STOCK_ITEM`
- `SYNC_OMIE_MOVEMENTS`
- `SYNC_OMIE_FULL`
- `RECONCILE_OMIE_STOCK`

Status:

- `PENDENTE`
- `PROCESSANDO`
- `CONCLUIDO`
- `CONCLUIDO_COM_ALERTAS`
- `ERRO_TEMPORARIO`
- `ERRO_CONFIGURACAO`
- `ERRO_AUTENTICACAO`
- `ERRO_DADOS`
- `AGUARDANDO_REPROCESSAMENTO`
- `CANCELADO`

O botão `Sincronizar agora` apenas cria o job. O botão `Processar próximo job` executa leitura controlada para validação local. Nenhuma chamada de escrita no OMIE é feita nesta etapa.

## Execução Automática

O scheduler automático enfileira jobs quando a integração OMIE está ativa e o `stock_mode` está em `MANUAL` ou `TRANSICAO`.

Intervalos iniciais:

- movimentos: 15 segundos;
- saldos mapeados: 30 segundos;
- produtos: 5 minutos;
- locais: 10 minutos;
- reconciliação rápida: 1 minuto.

O servidor Node roda continuamente (serviço do Windows, sempre ativo), então o timer interno roda a cada 5 segundos por padrão — é o único caminho de agendamento usado. A rota `/api/cron/omie-sync`, protegida por `CRON_SECRET`, continua existindo como gatilho externo opcional, mas não é necessária nesta implantação local.

Variáveis:

- `OMIE_SCHEDULER_ENABLED=true`
- `OMIE_SCHEDULER_TICK_MS=5000`
- `CRON_SECRET=...`

Os intervalos podem ser sobrescritos em `integrations.sync_intervals`.

## Incremental, Prioridade E Rate Limit

Movimentos usam cursor em `integration_sync_state`:

- `last_success_at`;
- `last_attempt_at`;
- `last_movement_id`;
- `last_page`;
- `last_cursor`;
- `overlap_start_at`.

A consulta incremental aplica sobreposição temporal de 2 minutos. A deduplicação usa o identificador do OMIE quando existir, ou uma chave determinística documentada no código.

Prioridades:

- `CRITICA`: saldo afetado por movimento;
- `ALTA`: movimentos incrementais e saldos ativos;
- `NORMAL`: produtos e locais;
- `BAIXA`: reconciliação.

O cliente OMIE possui limitador conservador por integração e circuit breaker:

- `CLOSED`;
- `OPEN`;
- `HALF_OPEN`.

Após falhas consecutivas, o circuito abre e evita chamadas repetidas até a recuperação controlada.

## Atualização Direcionada De Saldo

Quando um movimento é importado, o ACPARK cria uma entrada consolidada em `stock_refresh_queue`.

Chave de agrupamento:

```text
integration_id + omie_product_id + omie_location_id
```

A janela inicial é de 1000 ms. Depois é criado o job `SYNC_OMIE_STOCK_ITEM`, que consulta apenas o produto/local afetado.

## Interface Em Tempo Quase Real

A interface administrativa escuta eventos por SSE:

- `integration.status.updated`;
- `integration.job.updated`;
- `stock.updated`;
- `stock.movement.imported`;
- `stock.reconciliation.created`;
- `product.updated`.

Quando a Central de Integrações está aberta, ela atualiza os dados sem recarregar a página inteira.

## Saúde E Métricas

Endpoint administrativo:

```text
GET /api/admin/integrations/health
```

Métricas registradas:

- `omie_request_duration_ms`;
- `movement_sync_latency_ms`;
- `stock_refresh_latency_ms`;
- `job_queue_wait_ms`;
- `jobs_processed_total`;
- `jobs_failed_total`;
- `duplicate_events_total`;
- `stale_stock_items_total`.

## Mapeamento Dos PDVs

Primeiro execute `SYNC_OMIE_LOCATIONS`. Depois vincule manualmente:

```text
PDV ACPARK -> local de estoque OMIE
```

O ACPARK não cadastra identificador de PDV do Orion, pois o vínculo Orion-OMIE é externo ao ACPARK.

## Atualização De Saldos

Campos operacionais:

```text
saldo_omie
quantidade_reservada_acpark
saldo_disponivel_acpark = saldo_omie - quantidade_reservada_acpark
ultima_sincronizacao
sincronizacao_status
```

O saldo sincronizado substitui o saldo OMIE anterior. Ele nunca é somado ao saldo antigo.

Reservas internas do ACPARK são preservadas.

## Movimentos Do Orion

Quando uma venda, cancelamento ou devolução do Orion já estiver no OMIE, o ACPARK apenas importa o movimento.

Ao importar:

- registra `stock_movements`;
- classifica origem quando houver evidência no documento, referência, descrição ou código de origem;
- atualiza relatórios;
- não cria job de escrita;
- não envia nova baixa;
- não duplica movimento.

Sem evidência clara, a origem fica como `ORIGEM_NAO_IDENTIFICADA`.

Operações oficiais do OMIE como `operacao = 12`, `cancelamento = S` e `devolucao = S` são usadas como evidência quando retornadas pela API.

## Reconciliação

O job `RECONCILE_OMIE_STOCK` cria divergências em `stock_reconciliation_items`.

Tipos iniciais:

- `SALDO_DESATUALIZADO`
- `RESERVA_MAIOR_QUE_SALDO`
- `SALDO_NEGATIVO`

Divergências não explicadas não são corrigidas automaticamente.

## Webhooks

A estrutura `/api/webhooks/omie` permanece disponível para registrar eventos assinados e enfileirar processamento. Até validação em uma conta real, não foi assumido webhook específico de estoque. Se o OMIE não disponibilizar webhook adequado para estoque no ambiente contratado, a sincronização dependerá do polling incremental curto.

## Operações Futuras

Transferências de pedidos e baixas de avarias reais no OMIE ficam para uma etapa separada. Quando forem ativadas, deverão ser idempotentes e ter status operacional separado do status de integração.

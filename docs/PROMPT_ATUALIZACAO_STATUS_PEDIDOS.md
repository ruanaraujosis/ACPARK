# Prompt de atualização — etapas de status dos pedidos

Documento gerado em 05/08/2026 depois da rodada de testes ponta a ponta do ciclo de status.
A primeira parte é o **prompt pronto para colar** na próxima sessão de trabalho; abaixo dele fica o
registro do que foi verificado, corrigido e do que ficou em aberto.

---

## Prompt pronto para usar

> Contexto: no MyEstoque (servidor local, serviço Windows `MyEstoque`, Postgres local), o ciclo de
> status do pedido é **Pendente → Em Andamento → Aguardando Retirada → Finalizado**, movimentado por
> dois caminhos: o quadro Kanban (`PATCH /api/admin/orders/status`) e o painel do pedido
> (`POST /api/admin/order-flow` + `POST /api/admin/order-withdrawal`). Em 05/08/2026 foram corrigidos
> quatro defeitos nessas etapas (card que chegava em Aguardando Retirada sem quantidade liberada e
> travava a retirada; volta de etapa que não desfazia a liberação nem limpava as datas; liberação
> acima do solicitado gerando estoque negativo; regras de transição diferentes entre as duas rotas).
> O teste ponta a ponta `npm run test:status` cobre esse ciclo com um pedido real de teste e está
> passando 44/44, e a suíte `npm run test:sequential` está 25/25.
>
> Tarefas desta atualização:
>
> 1. **Sobra de liberação parcial.** Hoje, ao liberar 4 de 10 e confirmar a retirada, o pedido é
>    finalizado com `quantidade_solicitada = 10` e `quantidade_liberada = 4`, e as 6 unidades
>    restantes simplesmente somem — não viram pendência nem novo pedido. Definir o comportamento
>    correto (manter a sobra em Em Andamento como saldo aberto, gerar pedido complementar, ou
>    finalizar mesmo e apenas registrar a diferença) e implementar, com teste no
>    `tools/e2e-status-pedidos.mjs`.
> 2. **Estoque central negativo.** Há 327 produtos com `qtd_total < 0` (pior caso −1087), todos
>    `origem = manual` / `stock_mode = MANUAL`, e todos com pedidos já finalizados. Investigar a
>    origem (carga inicial sem saldo × baixas de retirada), decidir a política — bloquear a retirada
>    quando não há saldo central, permitir com aviso, ou apenas corrigir a carga — e criar um script
>    de correção em `tools/` para zerar/ajustar os saldos negativos com relatório do que foi alterado.
> 3. **Histórico de mudanças de status.** Só as movimentações do Kanban gravam em `pedido_auditoria`;
>    as transições feitas pelo painel (`order-flow`) e a confirmação de retirada não gravam nada.
>    Unificar: toda mudança de etapa deve registrar quem moveu, de onde para onde e quando, e a tela
>    do pedido deve mostrar essa linha do tempo.
> 4. **Tempo real das etapas.** Hoje o SSE (`server/services/order-alerts/order-alerts.events.js`)
>    só publica `NEW_PENDING_ORDER`. Publicar também as mudanças de etapa, para o PDV ver o pedido
>    andando sem depender do polling de 12s — sem regredir o fallback de polling.
>
> Regras do projeto: comentários curtos em português acima de funções/rotas/blocos não óbvios;
> mensagens de erro em português; rodar `npm run test:sequential` e `npm run test:status` antes de
> concluir; depois de mexer em `server/**`, reiniciar o serviço (`Restart-Service MyEstoque` em
> PowerShell como Administrador), porque os módulos ES só são carregados na inicialização.

---

## O que foi testado

Teste ponta a ponta em `tools/e2e-status-pedidos.mjs` (`npm run test:status`): cria categoria,
produto e PDV exclusivos do teste, roda o ciclo inteiro com pedidos reais e apaga tudo no final —
nenhum dado de produção é tocado. Cobre 44 verificações:

- criação do pedido pelo PDV e nascimento em Pendente;
- ciclo completo pelo quadro Kanban, incluindo idas e voltas entre as três colunas ativas;
- ciclo completo pelo painel do pedido com liberação parcial;
- confirmação de retirada com assinatura, baixa no estoque central e entrada no estoque do PDV;
- bloqueio de retirada repetida, de finalização sem assinatura e de pulo direto para Finalizado;
- reabertura de pedido finalizado com estorno das duas pontas do estoque;
- concorrência otimista (versão desatualizada → HTTP 409) e pedido inexistente (HTTP 404);
- coerência do status entre a visão do PDV, a lista do Almoxarifado e o histórico.

## O que foi corrigido

| # | Defeito | Correção |
|---|---------|----------|
| 1 | Arrastar o card de Em Andamento para Aguardando Retirada gravava o status mas deixava `quantidade_liberada = 0`; a retirada era recusada com "só pode ser confirmada para produtos com quantidade liberada" e o pedido travava na coluna. | O Kanban passa a liberar a quantidade solicitada quando nenhuma liberação foi informada, preservando (limitada ao solicitado) a quantidade já digitada no painel. A resposta devolve `quantidade_liberada` e a tela avisa quanto foi liberado. |
| 2 | Voltar o card de etapa mantinha a quantidade liberada e as datas `liberado_em`/`pronto_retirada_em`/`release_mode`, deixando pedidos "Pendente" com liberação registrada. | Voltar para Em Andamento ou Pendente zera a quantidade liberada e limpa as datas da etapa abandonada, nas duas rotas. |
| 3 | Liberar mais do que o solicitado era aceito (999 de 3) e a retirada baixava tudo do estoque central, deixando saldo negativo. | `order-flow` recusa com HTTP 400 e mensagem clara; o campo de quantidade na tela ganhou `max` e validação antes do envio. |
| 4 | O Kanban permitia Aguardando Retirada → Pendente, mas o painel recusava a mesma movimentação — regras diferentes para a mesma ação. | Os mapas de transição das duas rotas foram alinhados. |

Arquivos alterados: `server/modules/pedidos/pedidos.routes.js`, `public/app.js`,
`tests/server-routes.test.js` (assertiva atualizada para a nova regra), `tests/order-status-flow.test.js`
(novo), `tools/e2e-status-pedidos.mjs` (novo), `package.json` (script `test:status`).

## Em aberto (entra no prompt acima)

1. Sobra da liberação parcial não vira pendência.
2. 327 produtos com estoque central negativo (dado histórico, concentrado em 23–30/07/2026, quando
   houve 120 linhas liberadas acima do solicitado — caminho hoje bloqueado).
3. Auditoria de status só existe para o Kanban.
4. SSE não publica mudança de etapa, só pedido novo.

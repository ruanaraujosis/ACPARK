# Integrações externas

Arquitetura da Central de Integrações do MyEstoque. A OMIE é o primeiro provider registrado,
não um caso especial: o núcleo é agnóstico e foi feito para receber outras APIs.

## Ideia central

Um **provider** é um manifesto que se descreve: quais credenciais exige, quais operações
oferece, com que frequência cada uma roda e em que prioridade. Todo o resto do sistema — a
fila, o agendador, as rotas e a tela — lê apenas esse manifesto.

Ligar uma API nova é:

1. criar `server/services/integrations/providers/<nome>/`;
2. exportar um manifesto no mesmo formato do OMIE;
3. acrescentar uma linha em `providers/index.js`.

Nada mais. Rotas, fila, agendador, eventos em tempo real e a aba Integrações passam a
enxergar a integração nova sem alteração nenhuma. Isso é travado por
`tests/integrations-architecture.test.js`.

## Estrutura

```text
server/services/integrations/
  core/                      # nada aqui conhece nenhuma API específica
    provider-registry.js     # registro dos providers + catálogo público para a UI
    integration.repository.js# CRUD de integrations/credentials, sanitização para a API
    integration.security.js  # AES-256-GCM das credenciais
    integration.events.js    # SSE de status/jobs
    job.queue.js             # fila genérica (enfileirar, reservar, concluir, falhar, podar)
    job.runner.js            # executa um job resolvendo provider + capacidade
    scheduler.js             # agenda por capacidade, respeitando intervalos
    sync-state.js            # cursor incremental por integração + capacidade
    http.client.js           # POST JSON com timeout e validação de resposta
    errors.js                # IntegrationError + classificação de falha
  providers/
    index.js                 # registro dos providers disponíveis
    omie/
      index.js               # manifesto do provider
      omie.api.js            # chamada à API da OMIE
      omie.mappers.js        # tradução de payloads (funções puras)
      omie.operacoes.js      # escrita — preservada, NÃO ligada (ver abaixo)
      tarefas/               # um arquivo por capacidade
```

## Formato do manifesto

```js
export const providerExemplo = {
  id: "EXEMPLO",
  rotulo: "Exemplo",
  descricao: "...",
  tipoPadrao: "ERP_ESTOQUE",
  urlBasePadrao: "https://api.exemplo.com/v1",
  ambientes: ["PRODUCAO", "HOMOLOGACAO"],
  credenciais: [
    {
      chave: "token",
      rotulo: "Token",
      obrigatoria: true,
      ajuda: "Onde encontrar.",
    },
  ],
  capacidades: [
    {
      id: "PRODUTOS",
      rotulo: "Produtos",
      descricao: "...",
      prioridade: "NORMAL", // CRITICA | ALTA | NORMAL | BAIXA
      intervaloPadraoMs: 3600000,
      automatica: true, // false = só sob demanda
      manual: true, // false = não aparece como botão na tela
      executar: async (contexto) => ({/* resumo */}),
    },
  ],
  async testarConexao({ integracao, segredos, fetchImpl }) {
    /* leitura mínima */
  },
};
```

O `contexto` entregue ao `executar` traz `client` (transação pg), `integracao`, `segredos`,
`payload`, `estado` (cursor), `fetchImpl` e `enfileirar(capacidade, payload, opcoes)` — que
permite a uma capacidade agendar outra.

O retorno é um resumo livre, gravado em `integration_jobs.result`. Duas chaves têm efeito:
`alerta` marca o job como `CONCLUIDO_COM_ALERTAS`, e `cursor` avança o `integration_sync_state`.

## Data de corte — recomeço limpo

**21/08/2026, 14:36 (horário local)** é a data em que a operação recomeçou do zero.

Tudo anterior a ela é histórico, preservado em backup fora da pasta do sistema
(`C:\Users\User\Backups\MyEstoque\myestoque-myestoque-20260821-140556.dump`, restauração
validada em banco descartável antes de qualquer exclusão). Tudo posterior é a operação nova.

O que o corte apagou:

| Tabela                       | Registros                        |
| ---------------------------- | -------------------------------- |
| `pedidos`                    | 2.788                            |
| `pedido_auditoria`           | 711                              |
| `pedido_idempotencia`        | 419                              |
| `pedido_rascunhos`           | 1                                |
| `integration_stock_launches` | 80 (77 simulados + 3 cancelados) |
| `integration_jobs`           | 1.506                            |

**Os 80 lançamentos foram descartados, não enviados.** Nenhum deles chegou à OMIE, então não
havia divergência a compensar — eram anteriores ao fator de conversão e à recontagem. O motivo
está registrado em `integration_audit_logs`, ação `LANCAMENTOS_DESCARTADOS`, e esse registro
sobrevive à limpeza de propósito.

### Só produto vinculado à OMIE

O rótulo `produtos.origem` mentia: 4.468 produtos marcados como `manual` já tinham vínculo em
`product_integration_mappings`, porque a sincronização os casou por SKU em vez de duplicar.
O rótulo foi corrigido para `omie` nesses 4.468.

Os **2** produtos realmente sem vínculo (`69712` PAINEL LED e `7896020619093` LANÇA AGUA) foram
**desativados, não apagados** — têm linha em `estoque_pdv`, e apagar produto referenciado
quebraria o histórico de estoque.

Daqui em diante o cadastro vem só da OMIE.

### Pendência conhecida: categorias sem permissão

560 produtos ativos têm categoria que nenhum PDV pode pedir — todos com vínculo OMIE. São
famílias que a sincronização trouxe da OMIE e que ainda não constam em `pdv_categorias`:
MATERIAL DE MANUTENÇÃO (249), sem categoria (182), EQUIPAMENTOS (42), FERRAMENTAS (38),
MATERIAL ELETRICO (29) e outras 20.

Parte disso é correto — item de manutenção do parque não é pedido por PDV. Mas os **182 sem
categoria** não têm família na OMIE, então nem a sincronização os classifica: ficam invisíveis
até alguém preencher a família no ERP.

Conceder permissão de categoria muda o que cada PDV pode pedir, então é decisão do operador,
nunca da sincronização.

## Fluxo de estoque

```text
OMIE (local ALMOXARIFADO) ──► produtos.qtd_total      (estoque central)
                                      │
                      liberação de pedido (confirmar retirada)
                                      ▼
                              estoque_pdv.quantidade  (estoque do PDV)
```

O estoque central é da OMIE: o saldo importado **substitui** `qtd_total`, nunca soma. Foi a
ausência disso que deixou o estoque central desta instalação somar **−13.373** — as liberações
debitavam há meses e nada repunha.

Qual local da OMIE é o almoxarifado é uma configuração da integração
(`configuracao.local_almoxarifado`), escolhida na tela. Não é adivinhado.

O estoque de cada PDV é creditado pela confirmação de retirada do pedido, em
`server/modules/pedidos/pedidos.routes.js`.

## Cadastro de produtos

**Só produto ativo entra no catálogo.** Um item inativo na OMIE que nunca existiu aqui é
ignorado — nem o vínculo é criado. Um item que já existe e passa a inativo na OMIE é
**desativado** aqui (`ativo = false`), não ignorado: se fosse só ignorado, o PDV continuaria
conseguindo pedir item descontinuado.

Por isso a importação **não** usa o filtro `inativo: "N"` da API, embora ele exista e funcione
(reduz de 5.054 para 4.424 registros). Filtrar na origem deixaria o sistema cego para
desativações: o produto simplesmente sumiria da resposta e continuaria ativo aqui para sempre.

**A família da OMIE vira a categoria do produto.** `descricao_familia` alimenta
`produtos.categoria`, `produto_categorias` e, quando necessário, a tabela `categorias`.

Duas proteções que valem entender antes de mexer:

- **Categoria existente é reaproveitada quando difere só por acento ou caixa.** As categorias
  do MyEstoque saíram das famílias da OMIE, mas com grafia divergente: `CONVENIENCIA` aqui e
  `CONVENIÊNCIA` lá, `MATERIAL DE ESCRITORIO` contra `MATERIAL DE ESCRITÓRIO`. Como
  `pdv_categorias` amarra o que cada PDV pode pedir **pelo nome da categoria**, criar a
  variante acentuada como categoria nova tiraria os produtos de baixo da permissão existente
  e eles sumiriam da tela do PDV.
- **Categoria já preenchida não é sobrescrita.** Um produto classificado à mão como `PALETAS`
  não é movido para a família `SOBREMESAS` pela sincronização — isso mudaria quem pode pedi-lo.
  Alinhar categoria com família é decisão do operador, não efeito colateral do cadastro.

## Movimentações

`MOVIMENTOS` lê o **local do almoxarifado** e cada local vinculado a um PDV. O almoxarifado é
onde está o movimento de verdade — 2.093 em 90 dias nesta conta, contra zero nos locais de PDV.
Antes a tarefa só olhava locais de PDV, então, com zero vínculos, ela concluía sem importar
nada e o sistema ficava sem trilha de auditoria.

O movimento do almoxarifado entra com `pdv_id` nulo, porque não é de PDV. Um PDV vinculado ao
próprio local do almoxarifado é lido uma vez só, senão cada movimento entraria duplicado.

**Só movimento de local de PDV agenda `SALDO_ITEM`.** O almoxarifado não precisa: a capacidade
`ESTOQUE_ALMOXARIFADO` já reescreve o catálogo inteiro a cada 15 minutos. Enfileirar um job de
prioridade `CRITICA` por produto movimentado seria trabalho repetido — e, numa primeira carga
de 7 dias (461 movimentos medidos), encheria a fila de jobs de prioridade máxima que tomariam
a vez de todo o resto.

## Fator de conversão: pedido em embalagem, estoque em unidade

**Regra base, não negociável: o estoque é sempre guardado na menor unidade.** A embalagem é só
a forma de pedir. Motivo: a baixa de venda que o sistema de vendas lança no local do PDV é em
unidade; guardar saldo em embalagem faria o saldo lido do ERP nunca fechar, e liberação parcial
produziria fração.

O PDV pede **2 fardos**; o sistema lê no cadastro que o fardo tem **15**; grava **30 unidades**.
A multiplicação acontece na **criação do item**, nunca depois — se o número em
`pedidos.quantidade_solicitada` fosse às vezes embalagem e às vezes unidade, nenhuma tela,
relatório ou transferência saberia qual dos dois está lendo.

### De onde vem o fator

Da **característica do produto no ERP**. O nome da característica é **configuração**
(`configuracao.caracteristica_fator`, padrão `UNIDADES_POR_EMBALAGEM`), nunca fixo no código —
renomear no ERP só exige ajustar a configuração. Há também
`configuracao.caracteristica_embalagem`, opcional, com o nome da embalagem (FARDO, CAIXA) para
a tela exibir "2 fardos = 30 un"; sem ela, a tela fala genericamente.

**A característica NÃO vem no `ListarProdutos`.** Conferido contra a API: o campo existe com
`exibir_caracteristicas: "S"`, mas voltou `null` em 100 de 100 produtos. Só `ConsultarProduto`
traz, e ele é por produto. Por isso a capacidade `FATORES` lê em lotes de 60, com pausa a cada
10 chamadas, agenda a própria continuação e só relê quem passou de 7 dias — a OMIE já devolveu
_"Consumo redundante detectado, aguarde 53 segundos"_ nesta conta.

### Validação do conteúdo — estrita de propósito

Só **inteiro puro e positivo** é aceito. `"15 un"`, `"15,0"`, `"fd c/ 15"`, `"1,5"`, `"0"` e
`"-15"` são **recusados, nunca adivinhados**: o campo é texto livre no ERP, e um fator errado
multiplica o pedido inteiro em silêncio. O produto fica marcado `INVALIDO` e entra na lista de
pendências (`/api/admin/integrations/fatores`), para correção **no ERP**.

Produto **sem** a característica fica `UNITARIO` (fator 1, vendido por unidade) — que é o
estado normal enquanto o cadastro do ERP ainda está sendo preenchido.

### Releitura depois de configurar o ERP

O ciclo normal só relê um produto passados 7 dias. Isso é certo para regime, mas atrapalha
durante o preenchimento das características: quem configura hoje não quer esperar uma semana.

O botão **"Reler todos"** na aba Integrações dispara um mutirão que percorre o catálogo inteiro
em lotes, encadeando sozinho. O instante de início viaja no payload de todas as continuações:
sem essa referência, cada lote deixaria os produtos "frescos", a conta de restantes zeraria na
primeira volta e a releitura pararia no lote 1.

**Cada continuação leva um número de lote no payload.** A fila deduplica por
_(integração, capacidade, payload)_ e considera jobs em `PROCESSANDO` — ou seja, encontraria o
próprio job que está pedindo a continuação e devolveria ele. Medido em produção antes da
correção: a varredura andava 60 produtos a cada 30 minutos em vez de encadear, o que daria
~36 horas para 4.306 produtos.

Pedir **por embalagem** um produto com fator inválido é recusado com mensagem clara; pedir o
mesmo produto **em unidade** continua funcionando — o cadastro torto não paralisa a operação.

### Liberação e estoque mínimo

A liberação é **em unidade**: o almoxarifado pode liberar 8 de um fardo de 15. A tela mostra o
equivalente em embalagem como informação (`38 un (2 x 15 + 8)`), mas o campo é unidade.

**Estoque mínimo e máximo são em unidade.** A reposição automática usa esses campos — um número
cadastrado pensando em fardo gera pedido com fator errado. Revisar junto com a recontagem.

### Onde o fator mora

Nas colunas `fator_conversao`, `fator_status`, `fator_conteudo_bruto`, `embalagem` e
`fator_lido_em` de `product_integration_mappings` — no vínculo, não em `produtos`, porque é dado
que vem do ERP. Desligando a integração, o fator sai junto em vez de deixar um número órfão.

## Capacidades da OMIE

| Capacidade             | O que faz                                                                       | Intervalo padrão |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------- |
| `PRODUTOS`             | Importa o cadastro e mantém o vínculo SKU ↔ produto OMIE. **Não escreve saldo** | 1 h              |
| `FATORES`              | Lê o fator de conversão (unidades por embalagem) do cadastro                    | 30 min           |
| `LOCAIS`               | Importa os locais de estoque                                                    | 6 h              |
| `ESTOQUE_ALMOXARIFADO` | Saldo do local do almoxarifado → estoque central                                | 15 min           |
| `SALDOS`               | Saldo dos locais vinculados → estoque dos PDVs                                  | sob demanda ⚠    |
| `SALDO_ITEM`           | Atualiza um produto/local específico                                            | sob demanda      |
| `MOVIMENTOS`           | Importa movimentações do almoxarifado e dos locais vinculados                   | 5 min            |
| `TRANSFERENCIAS`       | **Escrita**: envia a transferência Almoxarifado → PDV                           | 5 min            |
| `RECONCILIACAO`        | Registra divergências para revisão                                              | 12 h             |

Cadastro e saldo têm **donos diferentes de propósito**: `PRODUTOS` cuida do cadastro e
`ESTOQUE_ALMOXARIFADO` do saldo. O `quantidade_estoque` do `ListarProdutos` vem zerado nesta
conta enquanto o local ALMOXARIFADO acusa o saldo real, então se as duas tarefas escrevessem
saldo a última a rodar venceria e o estoque central ficaria oscilando entre o número certo e zero.

> ⚠ **`SALDOS` está desligado do relógio até a integração de vendas existir.**
>
> Situação medida em 20/08/2026:
>
> | Local                                    | Movimentações em 90 dias | Produtos com saldo |
> | ---------------------------------------- | ------------------------ | ------------------ |
> | ALMOXARIFADO                             | 2.093                    | 3.969              |
> | CABANA / PARK / MOUNTAIN PARK / CENTRAL  | 1 a 2, todas em 13/08    | 1 a 2              |
> | DECK / COZINHA / RESTAURANTE / PARK HALL | 0                        | 0 a 42             |
>
> As transferências ALMOXARIFADO → PDV **começaram a ser lançadas na OMIE** (as entradas de
> 13/08 são o início). A baixa de venda ainda **não** — a integração do sistema de vendas com
> a OMIE está planejada, não feita.
>
> Enquanto só a entrada é lançada, o saldo de PDV na OMIE só cresce e não reflete o consumo,
> enquanto o MyEstoque tem 14.651 unidades acumuladas pela liberação de pedido. Ligar `SALDOS`
> agora substituiria meses de estoque por alguns dias de transferência.
>
> **Ligue `SALDOS` (mude `automatica` para `true` no manifesto) quando as duas condições
> valerem:**
>
> 1. todas as saídas do almoxarifado para PDV passarem a ser lançadas na OMIE; e
> 2. o sistema de vendas estiver integrado, dando baixa no local do PDV que vendeu.
>
> A partir daí a OMIE passa a ser fonte da verdade dos dois lados e o `estoque_pdv` se
> reconcilia sozinho. A tarefa já está pronta e testada para esse dia.

Os intervalos podem ser sobrescritos por integração em `integrations.sync_intervals`,
usando o id da capacidade como chave.

## Ordem de configuração

1. Cadastrar a integração com App Key e App Secret, e usar **Testar conexão**.
2. Rodar **Produtos** (o catálogo vem paginado; o job agenda a própria continuação).
3. Rodar **Locais de estoque**.
4. Escolher, na configuração da integração, qual local é o **almoxarifado**.
5. Rodar **Estoque do almoxarifado** — é o que enche o estoque central.
6. Vincular cada PDV ao seu local na seção "Vínculo PDV × local de estoque". O vínculo é
   um-para-um nos dois sentidos: um local não pode alimentar dois PDVs, senão o mesmo saldo
   entraria duas vezes. (Atenção: a OMIE tem um único local `DECK` para os dois PDVs
   DECK INFERIOR e DECK SUPERIOR, e nenhum local para MIRANTE.)
7. **Saldos** e **Movimentos** só importam para PDVs vinculados — sem o vínculo não há para
   qual PDV gravar, e adivinhar seria pior do que não importar.

## Escrita: transferência Almoxarifado → PDV

**Gatilho único: a confirmação de retirada.** Ela gera a transferência do local do Almoxarifado
para o local do PDV solicitante, na quantidade efetivamente retirada.

Um único lançamento, não dois: a OMIE resolve transferência com `IncluirAjusteEstoque` de
`tipo: "TRF"`, usando `codigo_local_estoque` como origem e `codigo_local_estoque_destino` como
destino (confirmado na documentação do serviço AjusteEstoque). Dois lançamentos separados
(SAI + ENT) poderiam ficar pela metade — se o segundo falhasse, o estoque sumiria da origem sem
aparecer no destino, e ninguém saberia sem conferir os dois locais.

### Matriz de responsabilidade

| Local        | Movimento                                 | Quem lança na OMIE |
| ------------ | ----------------------------------------- | ------------------ |
| Almoxarifado | Saída por transferência para o PDV        | **MyEstoque**      |
| Almoxarifado | Compras, notas, inventário, ajustes       | Fora do MyEstoque  |
| PDV          | Entrada por transferência do Almoxarifado | **MyEstoque**      |
| PDV          | Baixa por venda                           | Sistema de vendas  |
| PDV          | Entrada por devolução de venda            | Sistema de vendas  |

O MyEstoque envia **movimento, nunca saldo absoluto** — escrever saldo apagaria os lançamentos
do sistema de vendas. O tipo `SLD` (ajuste de saldo) está travado por teste.

### Modo simulação

`configuracao.modo_escrita` nasce em `SIMULACAO`: o payload é montado, gravado para conferência
e **nada é enviado**. Configuração ausente, vazia ou com valor desconhecido nunca significa
"pode enviar" — só `REAL` explícito libera. A trava é do núcleo (`core/escrita.js`) e vale para
qualquer capacidade que declare `escrita: true`, em qualquer provider.

### Nunca bloquear o usuário

A retirada conclui no MyEstoque independentemente da OMIE. O lançamento entra na fila
(`integration_stock_launches`) e é enviado quando houver internet. `stock-launches.service.js`
engole o próprio erro de propósito: falhar em registrar um lançamento não pode derrubar a
transação do pedido — a retirada já aconteceu.

### Idempotência e compensação

A chave é `PEDIDO-{código}-ITEM-{item}-{evento}-V{versão}`. A versão entra de propósito:
reabrir e finalizar de novo precisa gerar lançamento **novo**, não ser barrado como repetido.
A mesma chave viaja no `cod_int_ajuste`, então a OMIE também deduplica do lado dela.

**Reabrir um pedido finalizado gera compensação** — o movimento inverso, com chave própria.
Reusar a chave do original faria a OMIE recusar o estorno como repetido, e o estoque ficaria
errado nos dois sistemas. Se o lançamento original ainda não tinha sido enviado, ele é
**cancelado** em vez de compensado: não se estorna o que nunca entrou.

Compensação é o caminho que ficou valendo; a reabertura **não** é bloqueada.

### Precedência entre escrita e leitura

Ao confirmar a retirada o MyEstoque credita `estoque_pdv` como valor **provisório**. Quando a
leitura de saldos de PDV for ligada, o saldo vindo da OMIE **substitui** esse provisório
(substitui, nunca soma), porque lá ele já é entrada menos vendas.

## Direção dos dados

A leitura é a única direção ligada por padrão; a escrita existe mas nasce em simulação. O Orion integra direto com a OMIE para vendas,
cancelamentos e devoluções; o MyEstoque apenas importa esses movimentos e nunca devolve baixa
de venda.

`providers/omie/omie.operacoes.js` guarda o formato de payload e a regra de idempotência do
ajuste de estoque, em funções puras. **Nenhuma capacidade aponta para ele** — não existe
caminho de código que escreva na OMIE. Quando a baixa de avaria for ativada, ela entra como
uma capacidade normal, usando a mesma fila das leituras.

## Comportamento da fila

- **Sem duplicação**: job igual (mesma integração, capacidade e payload) ainda não finalizado
  é reaproveitado em vez de gerar outro.
- **Prioridade**: `CRITICA` (100) > `ALTA` (80) > `NORMAL` (50) > `BAIXA` (20).
- **Falha temporária** (rede, timeout, 5xx) volta para a fila com espera crescente — 30 s,
  1 min, 2 min… até o teto de 15 min, em no máximo 8 tentativas.
- **Falha de configuração, autenticação ou dados** para num status final e espera correção.
  Repetir não resolveria e só encheria a tabela.
- **Poda automática**: a cada hora o agendador remove jobs finalizados antigos, mantendo os
  mais recentes de cada tipo.

## Variáveis de ambiente

| Variável                         | Para que serve                                                      |
| -------------------------------- | ------------------------------------------------------------------- |
| `INTEGRATIONS_SCHEDULER_ENABLED` | Liga o agendador (aceita `OMIE_SCHEDULER_ENABLED` como nome antigo) |
| `INTEGRATIONS_SCHEDULER_TICK_MS` | Intervalo do tick, padrão 15 s                                      |
| `OMIE_TIMEOUT_MS`                | Tempo limite das chamadas à OMIE                                    |
| `INTEGRATION_ENCRYPTION_KEY`     | Chave AES das credenciais. Obrigatória, sem fallback                |
| `CRON_SECRET`                    | Protege `/api/cron/integrations-sync`, gatilho externo opcional     |

Credenciais de API **não** ficam em `.env`: são cadastradas pela tela e gravadas
criptografadas em `integration_credentials`.

## Rotas

Todas exigem sessão de admin.

```text
GET  /api/admin/integrations/providers          catálogo (a tela se monta a partir dele)
GET  /api/admin/integrations                    integrações + credenciais mascaradas
POST /api/admin/integrations                    cria/atualiza
POST /api/admin/integrations/test               testa conexão
POST /api/admin/integrations/sync               dispara uma capacidade
GET  /api/admin/integrations/jobs               fila
POST /api/admin/integrations/jobs/process-next  processa o próximo
POST /api/admin/integrations/jobs/process       processa um job específico
POST /api/admin/integrations/jobs/retry         reabre um job parado (exige motivo)
GET  /api/admin/integrations/health             cursores, circuito e resumo da fila
GET  /api/admin/integrations/locations          locais importados
GET|POST /api/admin/integrations/location-mappings   vínculo PDV × local
GET  /api/admin/integrations/reconciliations    divergências pendentes
GET  /api/admin/integrations/events             SSE
```

## Migração da arquitetura anterior

```bash
npm run integracoes:migrar
```

Roda em simulação. Com `--executar`, corrige a `url_base`, converte os escopos antigos de
`integration_sync_state` para os ids de capacidade atuais e poda a fila.

## Assistente de fator: levantamento da API (22/08/2026)

O catálogo tem **4.431 produtos ativos vinculados e apenas 2 com fator preenchido** no ERP —
preencher 4.429 características à mão não é trabalho realista. Daí a ideia de derivar o fator
do histórico de compras. Este levantamento mediu, contra a API real, se isso é possível.

### Onde está a evidência documental

Três serviços foram testados nesta conta:

| Serviço             | Endpoint                   | Registros nesta conta                                            |
| ------------------- | -------------------------- | ---------------------------------------------------------------- |
| Pedidos de Compra   | `produtos/pedidocompra/`   | **zero** (`PesquisarPedCompra` responde "Não existem registros") |
| Nota de Entrada     | `produtos/notaentrada/`    | **1**, de 10/07/2025, com `produtos: []` e totais zerados        |
| Recebimento de NF-e | `produtos/recebimentonfe/` | **4.778**                                                        |

**A única fonte utilizável é o Recebimento de NF-e.** Pedido de compra e nota de entrada não são
usados na operação — projetar em cima deles seria construir sobre um cadastro vazio.

### O campo que carrega o fator

Cada item de `ListarRecebimentos` traz **dois pares quantidade/unidade**: o que o fornecedor
faturou e o que efetivamente entrou no estoque.

| Campo                                      | Onde               | Significado                                                      |
| ------------------------------------------ | ------------------ | ---------------------------------------------------------------- |
| `itensCabec.nQtdeNFe` / `cUnidadeNfe`      | nota do fornecedor | 2 CX                                                             |
| `itensAjustes.nQtdeRecebida` / `cUnidade`  | entrada no estoque | 24 UN                                                            |
| `itensCabec.nIdProduto`                    | —                  | código OMIE do produto: o elo com `product_integration_mappings` |
| `itensCabec.cEAN`                          | —                  | EAN da nota; **não serve de chave**                              |
| `cabec.cNumeroNFe`, `dEmissaoNFe`, `cNome` | —                  | a nota, a data e o fornecedor que sustentam a sugestão           |

A razão `nQtdeRecebida / nQtdeNFe` **é** o fator, e é documental: quem digitou a entrada
declarou que aquela caixa tinha aquela quantidade. Não é semelhança de nome nem palpite de
mercado — é o acordo com o fornecedor, registrado numa nota fiscal com número e data.

**Casar por `nIdProduto`, nunca por `cEAN`.** Numa amostra de 60 recebimentos, o EAN da nota
casou com apenas 12 de 147 produtos: o campo vem vazio com frequência e, quando vem, costuma ser
o EAN da embalagem do fornecedor (`17894904084224`), não o da unidade que o PDV pede.

### Unidades diferentes são a regra, não a exceção

Na amostra de 60 recebimentos (223 itens), **90 itens tinham unidade diferente entre nota e
estoque e 82 tinham quantidade diferente** — ou seja, o sinal existe em cerca de um terço dos
itens. Pares mais comuns: `UN -> UN` (63), `CX -> 1UN` (28), `KG -> KG` (28), `CX -> KG` (15),
`DP -> UN` (6).

Exemplos reais, cada um uma linha de nota fiscal:

```
LIMP MULTIUSO AZULIM 500ML     2 CX  -> 24 1UN   fator 12
ALCOOL LIQ 70% UZU CLEAN 1LT   6 CX  -> 72 1UN   fator 12
SALG G ENR DE SALSICHA         2 PCT -> 60 1UN   fator 30
ACUCAR REFINADO CARAVELAS 1KG  2 FD  -> 20 KG    fator 10
BANANA TERRA 20 KG             3 CX  -> 60 KG    fator 20
```

Note que o fator sai **na unidade de estoque do próprio produto**: para a banana o "fator 20"
significa 20 kg por caixa, porque o estoque dela é em kg. Isso é consistente com a regra base —
o estoque continua na menor unidade, seja ela unidade ou quilo.

### Escrever a característica de volta é possível

O serviço `geral/prodcaract/` expõe `IncluirCaractProduto`, `AlterarCaractProduto`,
`ConsultarCaractProduto`, `ExcluirCaractProduto` e `ListarCaractProduto`. Campos do request:
`nCodProd`, `nCodCaract`, `cConteudo`. **Não é preciso planilha de importação.**

A característica é um cadastro global com código próprio — `UNIDADES_POR_EMBALAGEM` já existe
nesta conta com `nCodCaract` 11277558200. A gravação tem que ser
**`ListarCaractProduto` primeiro, depois `Alterar` ou `Incluir`**: incluir sobre uma
característica que já existe é erro, e sobrescrever cegamente apagaria um valor que alguém
conferiu à mão.

`ListarCaractProduto` **exige o código do produto** (`nCodProd`), então não substitui a
varredura por produto que a capacidade `FATORES` já faz — mas aceita filtro por data de
alteração (`dDtAltDe`/`dDtAltAte`), útil para releitura incremental.

### Cobertura medida: 1.600 dos 4.778 recebimentos

Amostra de um terço do histórico, casando por `nIdProduto` contra os 4.431 produtos ativos:

|                                          |           |
| ---------------------------------------- | --------- |
| itens com as duas quantidades            | 7.028     |
| itens sem `nIdProduto` (não casáveis)    | 773       |
| itens de produtos do nosso cadastro      | 4.841     |
| **produtos nossos com alguma evidência** | **1.257** |
| — evidência consistente, fator > 1       | 205       |
| — evidência conflitante                  | 10        |
| — sempre comprado avulso (fator 1)       | 1.042     |

Força da evidência nos 205 consistentes: **142 apoiados por 4 ou mais notas**, 34 por 2 ou 3,
e **29 por uma nota só**. Um terço do histórico já resolve 205 produtos — o histórico completo
deve chegar a algumas centenas, longe dos 4.429, mas muito acima dos 2 de hoje.

**O grosso do catálogo não terá sugestão, e isso é o resultado correto.** 1.042 produtos só
aparecem comprados avulso: para eles fator 1 não é palpite, é o que a nota diz. E os produtos
que nunca foram comprados no período simplesmente não têm evidência — ficam pendentes.

### Por que o conflito não é ruído

Dos 215 produtos com fator > 1, **10 têm evidência conflitante — e cada conflito é informação
verdadeira, não erro de leitura**:

```
BALAS (sku 029)            x120(32 notas) x118(15) x100(14) x135(2) x125(1)
PIRULITO (sku 223)         x50(5) x5(4) x42(4)
RED BULL SIX PACK          x6 em "16 CX006", x4 em "9 DP"
BATATA INGLESA 25 KG       x25 em "4 SC -> 100 KG", x20 em "1 CX -> 20 KG"
PIMENTAO VERDE KG          x10 e x20 (caixas de peso diferente) e x1 (comprado a granel)
```

`BALAS` e `PIRULITO` são cadastros **genéricos**, usados para produtos diferentes a cada compra:
não existe um fator para eles. Os demais são produtos comprados em **mais de um formato de
embalagem** — caixa de 6 e display de 4, saco de 25 kg e caixa de 20 kg. Isso confirma a regra
do briefing pelo avesso: a quantidade por embalagem é propriedade do acordo com o fornecedor,
então um mesmo produto pode ter mais de uma resposta certa, e **nenhuma delas pode ser eleita
automaticamente**.

Duas armadilhas que a derivação precisa tratar:

- **34 dos 205 consistentes também já foram comprados avulso.** A leitura correta da evidência
  não é "este produto vale 12", é "quando comprado em embalagem, a embalagem tem 12". Não
  invalida a sugestão, mas a tela precisa mostrar as duas linhas.
- **11 dos 205 têm a mesma unidade nos dois lados** (`1 UN -> 12 UN`). A razão está certa, mas o
  rótulo mente: quem digitou usou "UN" para o display. Como o rótulo de unidade não é confiável,
  **só a razão entre as quantidades vale como evidência** — nunca o texto da unidade.

### Custo e limites

A API permite **240 requisições por minuto**, até 4 simultâneas em consultas, e **nenhuma
simultânea em inclusão/alteração** — a gravação das características tem que ser serial.
Requisição repetida é recusada com _"Consumo redundante detectado"_ e só libera após 60s.

`ListarRecebimentos` aceita **100 registros por página**: os 4.778 recebimentos cabem em
**48 chamadas** (~10s cada, ~8 minutos de varredura completa). Depois da primeira carga,
`dtAltDe`/`dtAltAte` permitem varredura incremental. O histórico inteiro cabe num job só.

## Assistente de fator: derivação, conferência e gravação

O assistente lê o histórico de compra, monta **sugestões com a nota que as sustenta**, e grava no
ERP **apenas o que uma pessoa aprovou**. Ele não decide nada sozinho.

Onde mora: núcleo genérico em `core/fator-evidencia.js` (regras) e `core/fator-evidencia.repository.js`
(tabelas `integration_factor_evidence` e `integration_factor_decisions`); leitura da API em
`providers/omie/tarefas/evidencia-compra.js` (capacidade `EVIDENCIA_COMPRA`) e gravação em
`providers/omie/tarefas/escrita-fator.js` (capacidade `ESCRITA_FATOR`, `escrita: true`).
Migração: `node tools/migrar-evidencia-fator.mjs --executar`.

### A evidência é a razão entre duas quantidades

Cada item de `ListarRecebimentos` traz o que o fornecedor faturou (`nQtdeNFe`/`cUnidadeNfe`) e o
que entrou no estoque (`nQtdeRecebida`/`cUnidade`). A razão é o fator, com número de nota, data e
fornecedor atrás. O elo é `nIdProduto`, **nunca o EAN**.

**Só a razão vale. O rótulo da unidade não.** Medido: 14 linhas de fator > 1 têm o mesmo rótulo
dos dois lados (`2 UN -> 52 UN` no CHOC LACTA OREO, `20 CX -> 120 CX` no DEL VAL). Quem digitou
usou o rótulo da embalagem para os dois campos. Descartar essas linhas pelo texto perderia
evidência boa, então o texto vira só um aviso na tela.

### Classificação — e por que "avulso" não prova nada

| Situação             | O que significa                      | Vai para                                             |
| -------------------- | ------------------------------------ | ---------------------------------------------------- |
| `SUGERIDO`           | um único fator > 1 observado         | fila de conferência                                  |
| `CONFLITO_EMBALAGEM` | dois fatores > 1, ambos legítimos    | conferência, com escolha entre as opções             |
| `CADASTRO_GENERICO`  | três ou mais fatores > 1, sem padrão | fila de correção de cadastro, **sem fator**          |
| `SO_AVULSO`          | todas as notas 1:1                   | conferência, sugerindo 1 **sem rótulo de confiança** |
| `SEM_EVIDENCIA`      | nenhuma nota no período              | pendente, sem sugestão                               |

Confiança sai do número de notas concordando: **4 ou mais** = alta, **2 a 3** = média, **1** =
evidência única.

**O produto de referência mostra por que "avulso" não prova nada.** O `7894900531008`
(ÁGUA COM GÁS) tem duas linhas de evidência:

```
x1  em 21 notas   10 CX -> 10 UNID    "AGUA CRYSTAL C/G 500ML"   até 22/12/2025
x15 em  9 notas   10 CX -> 150 UN     "AGUA COM GAS"             a partir de 13/05/2026
```

O almoxarifado **passou a converter em 2026**; antes disso anotava a quantidade recebida igual à
faturada. O assistente acerta o fator (15, confiança alta, com "também comprado avulso em 21
notas" ao lado), porque só fator > 1 vira sugestão.

Mas repare no que teria acontecido se as 9 notas convertidas não existissem: **21 notas
concordando em 1:1**, para um produto cujo fator real é 15. Isso aconteceu de fato durante o
desenvolvimento, quando uma varredura incompleta parou antes das páginas de 2026 — e o produto
apareceu como `SO_AVULSO` com "confiança alta" no fator 1. Por isso `SO_AVULSO` **nunca recebe
rótulo de confiança**, por mais notas que tenha: ali a contagem mede quantas vezes ninguém
converteu, não o quanto se sabe.

Esse mesmo episódio é a razão de a varredura precisar terminar: **número parcial de páginas
produz classificação errada, não apenas incompleta.**

### Duas armadilhas medidas contra os dados reais

1. **Descrição divergente entre notas NÃO classifica.** A primeira versão tratava "as notas
   descrevem produtos diferentes" como prova de cadastro genérico. Medido: cada fornecedor
   escreve o nome do mesmo produto de um jeito, e o critério jogou **42 produtos** na fila
   errada — COCA COLA ZERO, H2OH, TODDYNHO e a própria BATATA INGLESA, vários deles com **um
   único fator observado**, que por definição não tem dispersão nenhuma. Hoje a classificação
   sai só da dispersão dos fatores, e o nome divergente vira aviso (`nomesDivergem`) na tela.

2. **Uma página que falha não pode matar as seguintes.** A página 37 de 48 estoura o timeout de
   15 segundos (recebimento com muitos itens). A primeira versão dava `break`, e como a
   continuação também parava ali, **as 11 páginas seguintes nunca eram lidas — em execução
   nenhuma**. Hoje a página falha é registrada, a varredura segue, e o cursor avança pelas
   páginas _tentadas_; três falhas seguidas (aí sim, internet caída) param o lote. Na
   retentativa a página 37 passou de primeira.

**A varredura só é idempotente começando da página 1**, que é quando a evidência anterior é
apagada. Retomar no meio soma contagem em cima da existente e infla a força das sugestões — o
botão da tela sempre começa do 1 por isso.

### A planilha de fardos como terceira fonte

`CONTROLE ESTOQUE DE BEBIDAS POR FARDO`, duas abas (abril e junho). Coluna A é o **nome de
operação**, coluna B são as unidades por fardo. Importada pela tela (`Importar planilha de
fardos`): o arquivo é lido **no navegador**, com a mesma biblioteca já usada na importação de
produtos — o servidor recebe linhas, nunca um `.xlsx`, e não ganha dependência de leitor de Excel.

Só **inteiro positivo** vira fator. `UND`, `LT`, `FRD`, `cx` são cabeçalho de seção ou item
controlado por unidade — mesmo critério estrito do resto do sistema.

**As duas abas não concordam, ao contrário do que parece.** Medido na planilha real: 103 linhas,
72 com fator, e **16 divergências** — todas do mesmo tipo, `1` em abril e `N` em junho:

```
CERV. AMSTEL / ANTARTICA / HEINEKEN / ORIGINAL (600ml)   1  x  24
BALY 2L (4 sabores), MONSTER, RED BULL                   1  x   6
RED BULL ZERO / MAÇÃ / MELÃO / POMELO / TROPICAL         1  x   4
```

A aba de junho passou a registrar o tamanho do fardo onde a de abril contava por unidade. O
cabeçalho de seção **não explica** a diferença: `CERVEJA 600 ml → UND` é igual nas duas abas.

Regra de reconciliação, deliberadamente mais fina que "as abas têm de bater":

- **aba sem número não é discordância** — significa que aquela aba não foi preenchida naquele
  período. Foi o caso de `GUARANÁ LT`, cabeçalho de seção em abril e linha com 12 em junho: o
  número vale;
- **dois números diferentes sim** — a planilha se contradiz, e vira conflito. A média (12,5 para
  o `1 × 24`) seria um número que nenhuma das duas abas afirma.

### O vínculo com o cadastro é textual — e erra

A planilha é chaveada por nome de operação, o cadastro por SKU. `sugerirVinculos` ordena
candidatos por palavras em comum, e a tela mostra os três melhores com a porcentagem.

**Nenhum vínculo é criado automaticamente, e o motivo é medido:** o primeiro candidato de
`ÁGUA MINERAL GÁSOSA 500ML` foi `AGUA MINERAL SEM GAS 500ML` — o produto **oposto** — porque
divide três palavras com ele e só uma com `AGUA COM GAS`, que é o certo. Das 103 linhas, 31 não
recebem candidato nenhum, o que é preferível a receber um errado.

### Como as três fontes se combinam

| Situação                                     | Resultado                                                 |
| -------------------------------------------- | --------------------------------------------------------- |
| notas e planilha no mesmo número             | `CONFIANCA.MAXIMA`                                        |
| notas e planilha em números diferentes       | **a planilha prevalece** — decisão do usuário             |
| só planilha, sem nota                        | sugere, como `EVIDENCIA_UNICA`                            |
| notas 1:1 e planilha > 1                     | a **planilha carrega o número**, e a confiança segue nula |
| planilha divergente entre abas               | não sugere nada                                           |
| descrição do produto (`CX C/12`, `DP12X28G`) | confirma, **nunca promove sozinha**                       |

**A planilha prevalece sobre as notas, por decisão do usuário** (23/08/2026): ela é a contagem
física do almoxarifado, enquanto a nota reflete como o fornecedor faturou e como quem lançou o
recebimento digitou. Caso real: `FANTA LARANJA` tem notas com ×1, ×6 e ×12 — formatos diferentes
ao longo do tempo — e a planilha diz 6; sem essa regra o produto ficava travado em conflito
esperando uma escolha que a planilha já responde.

Duas exceções deliberadas, porque "a planilha está certa" não as alcança:

- **planilha que se contradiz entre as próprias abas** não tem um número para prevalecer (as 16
  linhas do tipo `1 × 24`);
- **cadastro genérico** não é resolvido pela planilha: ali o problema é um código servindo
  produtos diferentes, e carimbar um fator só esconderia isso.

**Atenção a "planilha 1 contra nota > 1".** Linha de seção `UND` costuma significar "contamos
por unidade", não "a embalagem tem 1". Medido: `TODDYNHO` (planilha 1, nota ×27), `GROWLER CHOPP
O2` (1 contra ×6) e `XAROPE CERESER GROSELHA` (1 contra ×6) passam a sugerir fator 1. São poucos
e ficam visíveis na tela com o número da nota ao lado (`divergeDasNotas`).

O caso "notas 1:1 e planilha maior" existe por causa da água com gás: até 2025 quem lançava o
recebimento não convertia, e 21 notas registraram 1:1 para um produto de fator 15. A planilha
vem da contagem física do almoxarifado, então ela é que carrega o número — ainda a confirmar.

Validado contra os dados reais, com o vínculo simulado (nada gravado):

```
7894900531008  AGUA COM GAS      9 notas ×15 + planilha 15  -> MAXIMA
106.1          COCA COLA 310ML  66 notas ×15 + planilha 15  -> MAXIMA
0019229        RED BULL          notas ×6/×4, planilha divergente -> CONFLITO
```

**A planilha é a prova de que inferir por nome é proibido:** `COCA COLA LT` = 15 e
`COCA COLA ZERO LT` = 6; `CERV. ANTARTICA` = 15, `AMSTEL` = 12, `HEINEKEN` = 8. Mesma marca,
mesma lata, fator diferente — qualquer heurística de nome erraria metade.

### Gravação

**A característica é identificada por CÓDIGO, nunca por nome.** O request de inclusão aceita
`nCodCaract` ou `cCodIntCaract`; `cNomeCaract` **não existe** nele. Como o nome é configuração e
o código não pode ser cravado no programa, o job **descobre** o `nCodCaract` consultando um
produto que já tenha a característica preenchida (`fator_status = 'DEFINIDO'`) e falha com
mensagem explícita se não achar — em vez de mandar payload inválido e descobrir isso produto a
produto. Isso só apareceu na simulação: os 22 primeiros payloads teriam sido recusados.

`ListarCaractProduto` → `AlterarCaractProduto` se já existe, `IncluirCaractProduto` se não.
Incluir sobre existente é erro na API, e sobrescrever às cegas apagaria valor conferido à mão.
Serial, uma por vez: a API não aceita simultaneidade em gravação.

Nasce em `SIMULACAO` pela mesma trava genérica das transferências (`core/escrita.js`). Em
simulação o payload é montado e **gravado na auditoria**, mas a decisão continua `APROVADA` —
se virasse `ESCRITA`, ligar o modo real depois não encontraria mais ninguém para gravar.

Reexecutar é inofensivo: `listarAprovadasNaoEscritas` só pega `APROVADA`, e quando o conteúdo no
ERP já é o aprovado o item é marcado sem gastar chamada. **Provado com escrita real** em
23/08/2026: a `COCA COLA 310ML` foi gravada, reexecutada, e a segunda passada devolveu
`gravados: 0, já iguais: 1, operacao: NENHUMA` — sem duplicar característica nem alterar
conteúdo.

O payload aceita `payload.apenas` com um id de produto, que é como a virada de simulação para
real grava **um único** produto para conferência antes de soltar o lote.

**Primeira carga real (23/08/2026):** 24 produtos de confiança máxima, gravados em 23s a
~110 req/min. 21 inclusões, zero falhas, três já corretos no ERP. Depois da gravação, a
releitura pela capacidade `FATORES` trouxe os 24 de volta como `DEFINIDO` — o ERP continua
sendo o cadastro único, e o assistente só preencheu.

Auditoria por produto em `integration_factor_decisions`: valor anterior, operação usada, payload,
resposta, quem aprovou, quando, e a **evidência congelada no momento da aprovação** — a varredura
seguinte pode mudar a evidência, e a auditoria precisa dizer em que base se decidiu naquele dia.

## Valor unitário da transferência

A OMIE exige `valor` diferente de zero no ajuste, mesmo num `TRF`, que só move quantidade entre
dois locais e não altera saldo financeiro nem custo médio. `valorUnitarioDoProduto()` resolve o
valor em quatro fontes, nesta ordem:

| Ordem | Fonte                                                  | `fonte_valor` | Por que nessa posição                                                                          |
| ----- | ------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------- |
| 1     | `product_integration_mappings.price_manual`            | `MANUAL`      | Decisão humana explícita; vence o ERP (a HEINEKEN veio 16 do cadastro e foi corrigida para 20) |
| 2     | `product_integration_mappings.price`                   | `CADASTRO`    | Veio do próprio ERP na sincronização                                                           |
| 3     | Última nota de compra em `integration_factor_evidence` | `NOTA`        | Documental, mas pode estar desatualizada                                                       |
| 4     | `VALOR_SIMBOLICO` = R$ 0,01                            | `SIMBOLICO`   | Último recurso, só para o ajuste ser aceito                                                    |

O piso de R$ 0,01 foi autorizado pelo usuário em 26/08/2026: antes dele, produto sem preço
ficava em `ERRO` para sempre e, por ser o mais antigo da fila, ocupava as primeiras vagas de
toda leitura — 44 lançamentos chegaram a travar a fila inteira.

`fonte_valor` é gravado no `payload` do lançamento mas **nunca vai na chamada** — `corpo` vira
`params` da API crua, e um campo desconhecido ali faz a OMIE recusar o ajuste. Para auditar
quanto saiu com valor simbólico, filtre por `payload->>'fonte_valor' = 'SIMBOLICO'`.

O resumo da tarefa traz `com_valor_simbolico`, então dá para acompanhar se a cobertura de preço
está melhorando sem consultar o banco.

## Armadilhas conhecidas

Cada uma custou tempo e está travada por teste:

- **URL sem barra final** — a OMIE responde 301, o `fetch` segue o redirecionamento virando
  GET, a resposta vem em HTML e o JSON vazio parece "nenhum resultado". `resolverUrl()` sempre
  põe a barra e `normalizarUrlBase()` reduz a base à raiz da API; o cliente HTTP trata
  redirecionamento como erro de configuração.
- **Resposta não-JSON** nunca vira `{}`. Corpo em HTML ou JSON inválido é erro explícito, com
  trecho da resposta no diagnóstico.
- **Id de capacidade é gravado literal** na fila. A versão anterior normalizava o escopo e
  colapsava todos os tipos num só, fazendo saldos, locais e movimentos jamais rodarem.
- **O agendador respeita intervalo por capacidade.** Sem isso, o tick enfileira tudo a cada
  15 segundos: a instalação chegou a 102 mil jobs em 25 dias sem importar nada.
- **Entidades HTML** vêm escapadas nas descrições da OMIE (`6&QUOT;`). São desfeitas no
  mapeamento, senão o nome chega torto na tela, na planilha e na impressão.
- **Os campos de `ListarMovimentoEstoque` não seguem o padrão húngaro** da documentação. A
  lista vem em `movProdutoListar` e cada item usa `idMov`, `idProd`, `dtMov`, `qtde`, `tipo`
  (em minúsculo) e `codOrigem` — não `nCodMovimento`/`nQtde`/`dData`. Conferido contra a
  resposta real; mapear pelos nomes da documentação grava movimento com tudo nulo.
- **Erro de credencial não é retentável.** Repetir uma chave inválida só gasta rate limit.
- **`IncluirAjusteEstoque` recusa valor zero** — _"O «Valor» informado deve ser diferente de
  zero"_. Só aparece no envio real; em simulação o payload passa. Medido: 1.334 dos 4.435
  mapeamentos têm preço zero no cadastro, então o caso é a regra, não a exceção.
- **Preço humano não pode morar em `product_integration_mappings.price`.** A sincronização de
  produtos faz `price = EXCLUDED.price` a cada rodada, então qualquer valor corrigido à mão
  duraria até a próxima sincronização e sumiria em silêncio. Por isso existe `price_manual`,
  coluna deliberadamente **fora** daquele upsert.

- **Consulta idêntica repetida em menos de 60s é recusada** com _"Consumo redundante detectado"_.
  Não atrapalha um lote (cada produto é uma consulta diferente), mas derruba a conferência feita
  logo depois de gravar o mesmo produto — espace a releitura.
- **Uma página que falha não pode abortar a varredura.** Medido: a página 37 de 48 do histórico
  de compra estoura o timeout de 15s, e o `break` original deixava as 11 seguintes inalcançáveis
  em toda execução. Falha isolada pula e registra; três seguidas param.
- **Compra sempre 1:1 na nota não prova fator 1.** Quando quem lança o recebimento não converte,
  a nota registra a mesma quantidade dos dois lados. O produto de referência tem 21 notas assim
  (e 9 convertidas, de 2026, que dão o fator real 15). Nenhuma sugestão de fator 1 pode ganhar
  rótulo de confiança por isso.
- **Varredura parcial classifica errado, não só incompleto.** Com as páginas de 2026 faltando, o
  produto de referência aparecia como "só compra avulsa, confiança alta" no fator 1 — sendo 15.

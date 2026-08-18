# Diagnostico e plano de modernizacao

## Stack atual

> Nota: este documento é um snapshot histórico da auditoria original. A stack evoluiu desde então —
> o deploy é hoje em rede local (LAN), sem Vercel nem Supabase; ver [DEPLOY_LOCAL.md](DEPLOY_LOCAL.md).

- Frontend: HTML estatico, CSS proprio, Tailwind via CDN e JavaScript ES modules em `public/app.js`.
- Backend/API: Node.js com `http` nativo em `server/index.js`.
- Banco: PostgreSQL acessado pelo pacote `pg` em `server/db.js`.
- Autenticacao: cookie HTTP-only com JWT assinado no servidor.
- Deploy: servidor local (LAN), sempre ativo como serviço do Windows.
- Build: sem bundler; `npm run build` apenas confirma que nao ha build necessario.

## Arquivos principais

- Layout, navegacao, telas, estado e chamadas HTTP: `public/app.js`.
- Estilos, responsividade e impressao: `public/styles.css`.
- HTML base e dependencias CDN: `public/index.html`.
- Rotas, regras de negocio e consultas SQL: `server/index.js`.
- Conexao Postgres e senha: `server/db.js`.
- Estrutura do banco e indices existentes: `server/schema.sql`.

## Problemas encontrados

1. `public/app.js` concentra telas, estado, renderizacao, regras de UI e chamadas de API em mais de 2400 linhas.
2. `server/index.js` concentra todas as rotas e regras de negocio em mais de 1000 linhas.
3. O frontend usa muitas atribuicoes com `innerHTML`; ha escape manual em varios pontos, mas o padrao aumenta risco de regressao se algum dado novo entrar sem sanitizacao.
4. Nao existem testes automatizados para fluxos criticos como login, pedidos, liberacao, estoque e permissoes.
5. O layout ainda tinha limitadores globais de largura no app principal, reduzindo o aproveitamento em telas grandes.
6. A integracao com Supabase usa SQL direto, o que e bom para controle no servidor, mas exige validacao rigorosa e indices adequados.
7. Ha cache global `no-store`, seguro para dados internos, mas sem estrategia de cache seletivo para dados pouco sensiveis.

## Estrategia recomendada

1. Preservar a stack atual por enquanto, evitando migração grande sem necessidade.
2. Modularizar de forma incremental:
   - `public/js/api.js` para `request`, carregamento e tratamento de erro.
   - `public/js/ui.js` para `table`, `toast`, `statusPill` e helpers de renderizacao.
   - `public/js/state.js` para estado, refresh automatico e cache local.
   - `server/routes/*` para separar rotas por dominio.
   - `server/services/*` para regras de estoque, pedidos, categorias e importacao.
3. Reforcar validacao de entrada no backend antes de ampliar recursos.
4. Melhorar responsividade por camadas, começando pelo shell/layout principal.
5. Adicionar testes de API para os fluxos de maior risco antes de refatorar regras de negocio.
6. Criar migrations somente para mudancas de banco realmente necessarias, mantendo rollback.

## Primeira etapa aplicada

- Layout principal deixou de depender de containers centrais estreitos.
- `html`, `body`, `#app` e shell principal passam a ocupar 100% da largura e no minimo 100vh.
- Tabelas ganharam reforco contra overflow horizontal.
- Filtros e menus flutuantes ganharam comportamento mais seguro em telas pequenas.
- Cards, botoes e abas receberam ajustes mobile-first para toque e legibilidade.
- Login recebeu ajuste de tipografia mobile para evitar estouro interno em telas de 320 px.

## Segunda etapa aplicada

- Criado `public/js/ui.js` para centralizar utilitarios puros de interface.
- `public/app.js` agora importa `esc`, `statusPill`, `table` e `downloadCsv`.
- Essa extracao e pequena, nao altera dados, rotas, banco ou regras de negocio.
- O objetivo e iniciar a modularizacao sem reescrever o sistema inteiro.

## Terceira etapa aplicada

- Criado `server/utils/http.js` para respostas JSON, leitura segura do corpo da requisicao e normalizacao de textos/categorias.
- Criado dominio `server/modules/estoque/` com rotas de produtos do PDV e estoque por PDV.
- Criado dominio `server/modules/pedidos/` com criacao de pedido, pedidos do PDV, liberacao, exclusao e historico.
- `server/index.js` passou a orquestrar esses dominios, reduzindo duplicacao sem alterar contratos HTTP.
- Criados testes de contrato em `tests/server-routes.test.js` para proteger rotas criticas sem depender do banco.

## Quarta etapa aplicada

- Iniciada a modularizacao estrutural de `public/app.js`, sem alterar comportamento visual, endpoints ou payloads.
- `public/index.html` ja carregava `app.js` como JavaScript Module, entao a estrutura de imports foi preservada.
- Responsabilidades encontradas em `public/app.js` antes da etapa:
  - estado global da aplicacao;
  - carregamento global;
  - atualizacao automatica;
  - cliente HTTP;
  - login, logout e restauracao de sessao;
  - importacao/exportacao de planilhas;
  - pedidos do PDV;
  - dashboard;
  - estoque central e categorias;
  - estoque dos PDVs;
  - liberacao e impressao de pedidos;
  - ORION;
  - historico;
  - configuracoes e gerenciamento de PDVs.
- Estados compartilhados identificados:
  - usuario autenticado;
  - PDVs;
  - produtos;
  - categorias;
  - carrinho;
  - view atual;
  - carregamento global;
  - auto refresh;
  - pedidos pendentes ja impressos no `localStorage`.
- Chamadas HTTP mapeadas e preservadas:
  - `/api/auth/me`, `/api/auth/login`, `/api/auth/logout`;
  - `/api/public/pdvs`, `/api/bootstrap`;
  - `/api/pdv/products`, `/api/pdv/order`, `/api/pdv/orders`;
  - `/api/admin/products`, `/api/admin/products/import`;
  - `/api/admin/categories`, `/api/admin/category-products`;
  - `/api/admin/stock`, `/api/admin/orders`, `/api/admin/order-flow`;
  - `/api/admin/integrations`, `/api/admin/omie/jobs`, `/api/admin/history`, `/api/admin/dashboard`, `/api/admin/pdvs`, `/api/admin/config`.
- Eventos principais mapeados:
  - menu lateral e logout;
  - formulario de login;
  - formularios de pedido, estoque, produto, categoria, PDV, seguranca e APIs;
  - filtros de dashboard, historico, liberacao e pedidos;
  - botoes de adicionar/remover produtos;
  - acoes de editar, ativar/inativar, excluir, imprimir e liberar.
- Arquivos criados:
  - `public/js/state/app-state.js`;
  - `public/js/api/api-client.js`;
  - `public/js/ui/loading.js`;
  - `public/js/ui/notifications.js`;
  - `public/js/ui/auto-refresh.js`;
  - `public/js/utils/formatters.js`;
  - `public/js/utils/spreadsheets.js`;
  - `public/js/modules/auth/auth.js`;
  - `public/js/modules/pedidos/pending-print.js`.
- Funcoes movidas:
  - estado `app` e `state` para `state/app-state.js`;
  - `request` para `api/api-client.js`;
  - loading global para `ui/loading.js`;
  - `toast` para `ui/notifications.js`;
  - `startAutoRefresh` e `stopAutoRefresh` para `ui/auto-refresh.js`;
  - datas, mes e quantidade pendente para `utils/formatters.js`;
  - leitura/importacao de planilhas e `spreadsheetText` para `utils/spreadsheets.js`;
  - `renderLogin` e restauracao de sessao para `modules/auth/auth.js`;
  - controle de impressao automatica de pendentes para `modules/pedidos/pending-print.js`.
- Variaveis globais removidas ou controladas fora do arquivo principal:
  - `app`;
  - `state`;
  - `loadingState`;
  - `autoRefreshState`;
  - chave e lista de pedidos pendentes ja impressos.
- `public/app.js` passou de aproximadamente 2500 linhas para 2182 linhas nesta etapa.
- Pontos que permaneceram no arquivo principal:
  - roteamento das views;
  - shell/layout autenticado;
  - telas de estoque central, estoque PDV, dashboard, pedidos, liberacao, ORION, historico e configuracoes.
- Comportamentos que precisam permanecer equivalentes:
  - login/logout/restauracao de sessao;
  - chamada de todos os endpoints existentes;
  - importacao e exportacao de planilhas;
  - filtros, buscas e abas;
  - modais e paineis;
  - auto refresh;
  - impressao automatica de pedido pendente;
  - exibicao de mensagens de sucesso e erro.

## Validacao executada

- Servidor local iniciado em `http://127.0.0.1:5173/`.
- Validado carregamento da pagina local com cache-buster `20260713-21`.
- Validado sem overflow horizontal global em 320, 375, 768, 1024, 1366 e 1920 px.
- Validado sem erros de console nessas larguras.
- `public/app.js`, `public/js/ui.js` e `server/index.js` passaram em verificacao de sintaxe.
- `npm run build` executado com sucesso.
- Login com credencial seed exibida na tela nao confirmou acesso local; possivelmente a senha real do banco foi alterada.
- `server/index.js`, `server/modules/estoque/*`, `server/modules/pedidos/*` e `server/utils/http.js` passaram em verificacao de sintaxe.
- Testes de contrato executados diretamente com o runtime local: 3 testes aprovados.
- Servidor local reiniciado em `http://127.0.0.1:5173/`; pagina inicial respondeu 200 e rotas protegidas movidas responderam 401 sem login.
- `public/app.js` e todos os modulos em `public/js/**` passaram em verificacao de sintaxe.
- `http://127.0.0.1:5173/` respondeu 200 apos a modularizacao do frontend.
- `http://127.0.0.1:5173/app.js` respondeu 200.
- Validacao no navegador local: tela de login carregou, `#app` foi renderizado, `app.js` esta como `type="module"` e o console nao registrou erros.

## Pendencias para proximas etapas

- Separar mais partes de `public/app.js` em modulos menores por dominio: produtos/categorias, estoque PDV, pedidos, liberacao, historico e configuracoes.
- Continuar separando `server/index.js` por dominios: produtos, categorias, PDVs, dashboard, configuracoes e ORION.
- Adicionar testes automatizados.
- Revisar indices com dados reais e consultas mais usadas.
- Considerar paginacao server-side em listas grandes.
- Revisar RLS e politicas no Supabase caso as tabelas estejam expostas pela Data API.

## Roteiro manual recomendado

1. Recarregar `http://127.0.0.1:5173/` com cache desabilitado.
2. Conferir se a tela de login aparece sem erros no console.
3. Testar login de Almoxarifado.
4. Testar logout e retorno para a tela de login.
5. Testar restauracao de sessao ao recarregar a pagina.
6. Abrir Dashboard, Estoque central, Categorias, Estoque PDVs, Liberacao, Historico, ORION e Configuracoes.
7. Conferir filtros, buscas, paineis e modais principais.
8. Testar importacao/exportacao de planilha em ambiente controlado.
9. Testar criacao de pedido como PDV.
10. Testar chegada do pedido em Liberacao e impressao automatica quando aplicavel.

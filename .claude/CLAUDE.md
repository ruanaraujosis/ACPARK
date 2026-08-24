# MyEstoque

Sistema de gestão de estoque e pedidos para PDVs (pontos de venda) e Almoxarifado (depósito central), com integração opcional com a OMIE (ERP). Frontend em JS puro (ES modules, sem bundler), backend em Node.js `http` nativo, banco PostgreSQL.

## Requisito permanente: sistema como aplicativo local instalável

**Não pergunte de novo sobre isso — é um requisito fixo do projeto:**

- O sistema deve rodar como um **aplicativo local instalável**, não como "acessar um site pelo navegador". O usuário não deve precisar digitar URL, abrir navegador manualmente, nem iniciar servidor nenhuma vez — tudo isso já deve estar pronto.
- **Servidor**: sempre ativo como serviço do Windows (NSSM, serviço `MyEstoque`), inicia sozinho no boot da máquina, sem exigir login nem ação do usuário. Ver [DEPLOY_LOCAL.md](DEPLOY_LOCAL.md).
- **"Aplicativo"**: app desktop próprio em Electron, na pasta `desktop-app/` — janela própria sem abas nem barra de endereço, ícone gerado da logo do sistema (`public/logo-print.png` → `desktop-app/icone.ico` via `gerar-icone.ps1`). Distribuído como instalador NSIS (`desktop-app/dist/MyEstoque Setup 1.0.0.exe`), que cria atalhos na área de trabalho e no menu Iniciar.
- O app é só a casca: **não inicia servidor nenhum**, só abre a interface. O endereço do servidor é configurável pelo menu (salvo por máquina, padrão `http://192.168.1.207:5173`), então um único instalador serve Almoxarifado e PDVs. Ver seção 6 do [DEPLOY_LOCAL.md](DEPLOY_LOCAL.md) para instalar e recompilar.
- **Comunicação em tempo real entre PDVs e Almoxarifado é obrigatória e não pode regredir.** Hoje é via Server-Sent Events (`public/js/services/order-alerts.js` + `server/services/order-alerts/order-alerts.events.js`), com fallback de polling a cada 12s. Qualquer mudança de infraestrutura (rede, deploy, hospedagem) precisa preservar isso — já foi confirmado que funciona bem (ou melhor) num servidor local único e sempre ativo comparado ao ambiente serverless usado no passado.
- Qualquer ferramenta disponível pode ser usada para evoluir isso (compilar `.exe`, gerar ícones, criar serviços do Windows, etc.) — o objetivo final é sempre: **instalável, local, sem passos manuais, tempo real preservado**.

## Stack e estrutura

- **Backend**: `server/index.js` orquestra módulos por domínio em `server/modules/*` (rotas) e `server/services/*` (regras de negócio, integrações, storage). Sem framework — `http` nativo do Node.
- **Frontend**: `public/app.js` é o arquivo principal (grande, ~9200 linhas) com as views/telas. Peças já extraídas para `public/js/**` (state, api client, ui helpers, auth, alerts). Sem bundler — Tailwind, xlsx.js e fontes são carregados via `<script>`/`<link>` em `public/index.html`, hoje **hospedados localmente** em `public/vendor/` e `public/fonts/` (não são mais CDN).
- **Banco**: PostgreSQL, 38 tabelas em produção. A fonte da verdade da estrutura é **`db/estrutura.dump`** (versionado, gerado por `npm run dump:gerar`, validado por `npm run dump:validar`); `db/estrutura.sql` é a mesma coisa em texto, só para revisar diffs no Git. O `server/schema.sql` é **legado e incompleto** — declara 37 das 38 tabelas (não cria `pedido_auditoria`, que nasce em runtime) e não reproduz índices/constraints/defaults com fidelidade. Nunca recrie um banco só por ele. Depois de qualquer restore é **obrigatório** rodar `ALTER TABLE ... OWNER TO myestoque_app` em todas as tabelas e sequences: 14 tabelas têm RLS ligada e zero políticas (herança do Supabase), então quem não é dono lê zero linhas e o sistema sobe sem enxergar dado nenhum. Ver [DEPLOY_LOCAL.md](../docs/DEPLOY_LOCAL.md).
- **Backup completo**: `node tools/gerar-backup-completo.mjs --motivo "..."` gera estrutura+dados em `backups/` (pasta ignorada pelo Git — contém dados reais) junto com um `.json` de manifesto com os totais. Rode sempre antes de qualquer mudança de estrutura.
- **Restauração de backup**: `server/services/backup/backup.service.js` (`validarArquivoBackup`, `bancoDestinoTemDados`, `restaurarBackup`, `gerarBackupCompleto`, `listarBackups`) é o serviço que o instalador vai usar — nunca rodar `pg_restore`/`pg_dump` cru na mão. Recusa arquivo inválido antes de tocar em banco, exige `confirmarSobrescrita: true` explícito se o destino já tem dados, reatribui dono automaticamente, e roda `ensureAllRuntimeTables()` (`server/services/backup/runtime-schema.service.js`) para recuperar tabelas de runtime que backups antigos não tinham. Exposto pela API em `server/modules/backup/backup.routes.js` (`/api/admin/backup/*`, admin-only) — a restauração sempre mira o `DATABASE_URL` do próprio processo, nunca um destino escolhido pelo cliente. Validar com `npm run backup:validar-restauracao` — sempre contra banco descartável, nunca produção.
- **Assistente de primeiro uso**: `server/modules/setup/setup.routes.js` (`/api/setup/status`, `/api/setup/senha-admin`) + `public/js/modules/setup/setup.js`. Único par de rotas do sistema que responde sem sessão — gate é `senha_almoxarifado` ausente em `configuracoes` (sem seed, então a ausência já é o sinal de instalação nova). `senha-admin` se recusa a rodar de novo assim que a senha existe, mesmo chamada direto. Interceptado em `initializeAuth()` (`public/js/modules/auth/auth.js`) antes da checagem normal de sessão. PDV e importação de produtos reaproveitam as rotas admin já existentes (`/api/admin/pdvs`, `/api/admin/products/import`) via login automático logo após o passo 1 — não duplicam lógica.
- **Credenciais do banco**: via `DATABASE_URL` no `.env.local`. É sempre obrigatória — não existe mais fallback para outro banco; se `server/db.js` não encontrar `DATABASE_URL`, ele recusa subir (erro explícito), em vez de cair silenciosamente em outra conexão.
- **Carregamento do `.env`**: use sempre `import "./env.js"` (`server/env.js`), nunca `dotenv/config` direto. O `dotenv/config` lê só o arquivo `.env`, que não existe neste projeto — a configuração fica em `.env.local`. Isso já causou o sistema inteiro rodar no banco da nuvem sem ninguém perceber. O `server/env.js` resolve os caminhos a partir da raiz do projeto, então funciona igual no serviço do Windows e em scripts de `tools/`.
## Deploy

- **Único caminho de hospedagem: rede local (LAN).** O projeto não usa mais Vercel nem Supabase — foram removidos definitivamente do código, config e docs (não há `vercel.json`, `api/index.js` nem adapter de Supabase no repositório). Veja [DEPLOY_LOCAL.md](../docs/DEPLOY_LOCAL.md). O servidor roda como serviço do Windows (NSSM, nome do serviço `MyEstoque`) — sempre ativo, inicia sozinho no boot, ninguém precisa iniciar nada manualmente. Banco é PostgreSQL local (usuário `myestoque_app`).
- `NODE_ENV=production` é seguro no local: o cookie de sessão só fica `secure` se `FORCE_SECURE_COOKIES=true` — não depende de `NODE_ENV` (isso foi corrigido de propósito para não quebrar login em HTTP puro na LAN).
- Integrações externas: sincronização é **oportunista** — só funciona quando há internet, nunca deve travar o resto do sistema quando não há. Variável correta é `INTEGRATIONS_SCHEDULER_ENABLED` (aceita o nome antigo `OMIE_SCHEDULER_ENABLED`; `OMIE_AUTO_SCHEDULER` nunca existiu).

## Integrações externas (arquitetura refeita em 18/08/2026)

A Central de Integrações é **agnóstica de provider**. A OMIE é o primeiro provider registrado, não um caso especial. Referência completa: [docs/INTEGRACOES.md](../docs/INTEGRACOES.md).

- **Núcleo** em `server/services/integrations/core/` — registro de providers, fila genérica de jobs, agendador, cursor incremental, cliente HTTP, cripto de credenciais e SSE. **Nada aqui pode conhecer uma API específica**; há teste de arquitetura que falha se alguém acoplar.
- **Providers** em `server/services/integrations/providers/<nome>/`. Cada um exporta um manifesto declarando credenciais, capacidades (com intervalo e prioridade) e `testarConexao`. Ligar uma API nova = pasta + uma linha em `providers/index.js`. Rotas, fila, agendador e a aba Integrações se adaptam sozinhos, porque a tela se monta a partir de `/api/admin/integrations/providers`.
- **Fluxo de estoque**: OMIE (local do almoxarifado) → `produtos.qtd_total` (estoque central, substitui e nunca soma); confirmação de retirada do pedido → `estoque_pdv.quantidade`. Qual local é o almoxarifado é configuração da integração (`configuracao.local_almoxarifado`), nunca adivinhada. `PRODUTOS` cuida só do cadastro e **não escreve saldo** — o `quantidade_estoque` do `ListarProdutos` vem zerado nesta conta enquanto o local ALMOXARIFADO tem o saldo real; se as duas tarefas escrevessem saldo, a última a rodar venceria.
- **A capacidade `SALDOS` (estoque dos PDVs) fica fora do relógio até a integração de vendas existir.** As transferências ALMOXARIFADO → PDV começaram a ser lançadas na OMIE em 13/08/2026, mas a baixa de venda ainda não: a integração do sistema de vendas com a OMIE está planejada, não feita. Enquanto só a entrada é lançada, o saldo de PDV na OMIE só cresce, e o MyEstoque tem 14.651 unidades acumuladas pela liberação — ligar `SALDOS` trocaria meses de estoque por dias de transferência. Ligue (`automatica: true`) quando as saídas do almoxarifado forem todas lançadas na OMIE **e** as vendas derem baixa no local do PDV. A tarefa já está pronta e testada.
- **Cadastro de produtos**: só produto **ativo** entra; inativo que já existe é desativado aqui (não ignorado, senão o PDV segue pedindo item descontinuado). O filtro `inativo: "N"` da API existe e funciona, mas **não é usado de propósito** — filtrar na origem cega o sistema para desativações. A `descricao_familia` da OMIE vira `produtos.categoria`; categoria existente é reaproveitada quando difere só por acento/caixa (`CONVENIENCIA` vs `CONVENIÊNCIA`), porque `pdv_categorias` amarra permissão pelo nome — e categoria já preenchida nunca é sobrescrita.
- **Escrita na OMIE: só a transferência Almoxarifado → PDV**, disparada pela confirmação de retirada, via `IncluirAjusteEstoque` com `tipo: "TRF"` (um lançamento, não dois). Nunca venda, devolução, compra, inventário ou saldo absoluto — `SLD` está travado por teste. Nasce em `modo_escrita: SIMULACAO` (monta payload, não envia); só `REAL` explícito libera, e a trava é genérica no núcleo (`core/escrita.js`, capacidade com `escrita: true`). A retirada **nunca** é bloqueada pela integração: o lançamento vai para `integration_stock_launches` e drena quando houver internet. Reabrir pedido finalizado gera **compensação** com chave própria (reabertura não é bloqueada); se o original ainda não saiu, ele é cancelado em vez de compensado.
- **Migração do banco**: `npm run integracoes:migrar` (simulação por padrão, `--executar` aplica) corrige `url_base`, converte escopos antigos e poda a fila.

Quatro armadilhas que já custaram caro e estão travadas por teste — não desfaça nenhuma sem entender o motivo:

1. **URL sempre com barra final.** Sem ela a OMIE responde 301, o `fetch` segue virando GET, vem HTML, e o JSON vazio parece "nenhum resultado". Isso deixou a instalação 25 dias "sincronizando com sucesso" e importando zero produtos.
2. **Resposta não-JSON é erro, nunca `{}`.** Foi o `.json().catch(() => ({}))` que escondeu o item 1.
3. **O id da capacidade é gravado literal na fila.** A versão anterior normalizava o escopo e colapsava tudo num tipo só, então saldos, locais e movimentos jamais rodaram.
4. **O agendador respeita o intervalo de cada capacidade.** Sem isso o tick enfileira tudo a cada 15s: 102 mil jobs em 25 dias.

## Performance (decisões medidas, não intuídas)

Três otimizações feitas com medição antes/depois — se for mexer nesses pontos, meça de novo em vez de assumir:

- **Reposição automática por intervalo**: `processAutoOrders()` rodava a *cada* requisição autenticada (transação + varredura de 42 mil linhas de `estoque_pdv`, ~17ms). Agora é limitada por `AUTO_ORDER_INTERVAL_MS` (padrão 60s) e protegida contra execução concorrente. Medido: 31,7ms → 13,7ms de mediana por requisição autenticada. A funcionalidade foi verificada de ponta a ponta contra banco descartável (pedido criado, quantidade certa, sem duplicar).
- **Categorias juntadas em memória**: `string_agg` + `array_agg` com `ORDER BY` interno forçavam duas ordenações e custavam ~230ms para 4,5 mil produtos, em toda carga de página. `listarProdutosComCategorias()` faz duas consultas simples e junta com um `Map`. A ordenação continua vindo do banco (`ORDER BY sku_produto, categoria`), então o resultado é byte a byte idêntico — isso foi conferido linha a linha contra a versão antiga. Medido: 225ms → 98ms.
- **gzip nível 1 + cache de estáticos**: `send()` e os estáticos comprimem quando o cliente aceita e o corpo passa de 2 KB. **Nível 1 é proposital**: medido com o payload real de 646 KB do `/api/bootstrap`, reduz 85% gastando 6ms de CPU; o nível 9 gastaria 31ms para ganhar só mais 13 KB — numa LAN de 1 Gbps isso deixaria a resposta *mais lenta* do que não comprimir. Bootstrap: 646 KB → 96 KB na rede. `.woff2`/`.png`/`.jpg` não são comprimidos (já são). **SSE nunca passa pelo `send()`** — comprimir/bufferizar o `text/event-stream` quebraria o tempo real.
- Estáticos com `?v=` agora vão com `immutable` (antes era `no-store` em tudo, o que rebaixava ~1,9 MB a cada abertura). O `index.html` continua `no-store`, porque é ele que aponta para as URLs versionadas.

## Comandos

- `npm run dev` — inicia o servidor (`node server/index.js`), porta padrão 5173.
- `npm test` / `node tests/server-routes.test.js` — testes principais.
- `npm run test:sequential` — roda todos os `tests/*.test.js` um a um.
- `npm run format` / `format:check` — Prettier.

## Convenções deste projeto

- **Comentar o código**: o usuário pediu explicitamente que todo o código tenha comentários curtos (uma linha, em português, acima de funções/rotas/blocos não óbvios) — isso é diferente do padrão geral de "sem comentários" e vale só para este projeto.
- Comentários e mensagens de erro voltadas ao usuário: em português.
- Cuidado ao criar pastas com `node_modules` symlinkado dentro do repo (já causou um bug de crash em uma suíte de testes, resolvido removendo a pasta problemática).
- Há um Skill do projeto em `.claude/skills/myestoque-ops/` com comandos operacionais prontos (checar saúde, reiniciar serviço, rodar testes, refazer migração do banco).
- Há um Skill do projeto em `.claude/skills/myestoque-git/` com informações de Git/GitHub (dono atual do repositório, conta certa do `gh` CLI a usar, nome legado `ACPARK`, convenções de commit/push).
- Há um hook em `.claude/settings.json` que roda a suíte de testes automaticamente antes de qualquer `git commit` e bloqueia o commit se algo falhar.

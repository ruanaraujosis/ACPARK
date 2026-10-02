---
name: myestoque-seguranca
description: Auditoria de segurança do MyEstoque — autenticação de Almoxarifado/PDV, isolamento entre PDVs, injeção SQL, credenciais da OMIE, exposição no repositório público do GitHub e limites de upload. Use quando pedirem para revisar/validar segurança, antes de expor qualquer coisa na rede, depois de mexer em login/sessão/rotas admin, ou ao adicionar rota nova.
---

# MyEstoque — segurança

Este projeto roda na LAN, em HTTP puro, com o repositório **público no GitHub**. O modelo de ameaça
realista é: (a) alguém já dentro da rede do parque, (b) qualquer pessoa lendo o repositório, e
(c) um usuário de PDV legítimo tentando fazer mais do que deveria. Não é um sistema exposto à
internet — não infle severidade tratando como se fosse, mas também não descarte (a) e (b).

Complementa (não substitui) o agente `myestoque-reviewer`, que cuida de convenções e regras de
negócio. Segurança é responsabilidade desta skill.

## Antes de auditar: o que já foi verificado e está limpo

Auditado em 2026-08-11 (backend completo + histórico do Git). **Não refaça do zero** — confirme que
não regrediu e foque no que mudou desde então.

- **SQL injection nas rotas HTTP: nenhuma.** Todas as queries usam parâmetros `$1`. As únicas
  interpolações são constantes internas (`brasiliaNow`, `skuColumn` de lista fixa).
- **Autenticação sólida**: pbkdf2-sha256 com 260k iterações, `timingSafeEqual`, sem enumeração de
  usuário (mesma mensagem para PDV inexistente e senha errada), rate limit de **3 tentativas/5min**
  por IP (decisão do usuário em 02/10/2026; era 8) em `server/utils/limite-login.js`, cobrindo admin,
  PDV, MyControl e toda reconfirmação de senha. Testado contra JWT forjado e `alg=none` — ambos
  rejeitados.
- **Isolamento entre PDVs correto**: rotas `/api/pdv/*` sempre usam `user.pdvId` da sessão, nunca
  `pdvId` do cliente. As rotas que aceitam `pdvId` por query são todas `/api/admin/*` com gate de
  admin (legítimo: o almoxarifado consulta qualquer PDV).
- **Autorização por rota**: toda `/api/admin/*` tem gate (`requireUser(...,"admin")` ou checagem
  inline `user.role !== "admin"`). Nenhuma rota administrativa desprotegida.
- **Credenciais da OMIE não vazam**: `sanitizeIntegration` é whitelist e nunca inclui
  `encrypted_value`; erros da OMIE persistem só `faultstring`.
- **Upload valida por magic bytes**, não pela extensão; chave do arquivo é o `sha256` (o nome
  enviado pelo cliente nunca entra no caminho); `safePath` barra traversal.
- **PGPASSWORD via env em 100% dos `spawnSync`** — a senha nunca vai na linha de comando. Há teste
  travando isso.
- **Nenhuma credencial real no histórico do Git**: sem JWT, sem connection string com senha real,
  sem chave privada, sem credencial OMIE. Os valores em testes são falsos (`"key-real"` é literal).

## Correções aplicadas — não podem regredir

Cada uma tem teste. Se um desses testes começar a falhar, é regressão de segurança, não teste velho.

1. **`escapeIdentifier` nos nomes vindos de backup** (`backup.service.js`). Os nomes de
   tabela/sequence vêm do banco recém-restaurado, ou seja, do **conteúdo do arquivo de backup**, que
   pode vir de fora. Sem quoting, um dump com tabela chamada `x" ... --` executa SQL arbitrário no
   `ALTER TABLE ... OWNER TO`.
2. **`resolverCaminhoBackup` só aceita arquivos de dentro de `backups/`** (`backup.service.js`).
   Caminho absoluto arbitrário dava a quem tem sessão de admin um oráculo de existência/tamanho de
   qualquer arquivo do host, e rodava `pg_restore --list` sobre ele. Restaurar de pendrive =
   copiar para `backups/` antes.
3. **Teto no corpo do upload** (`avarias.routes.js`, `readRawBody`). Antes acumulava o corpo em
   memória sem limite; um POST grande derrubava por OOM o serviço que atende todos os PDVs. Hoje
   aborta em `maxImageBytes + 1MB` com 413 e `req.destroy()`.
4. **`/api/health` não devolve mais o erro do driver** (`index.js`). A rota é pública e o erro do
   `pg` traz usuário, host e porta do banco. Detalhe vai só para o log.
5. **`INTEGRATION_ENCRYPTION_KEY` sem fallback** (`integration.security.js`). Antes caía em
   `JWT_SECRET` e depois numa string fixa que está no repositório público — qualquer instalação sem
   `NODE_ENV=production` gravava as credenciais da OMIE com chave conhecida. Agora é sempre exigida.
6. **Erro técnico não chega ao cliente** (`server/utils/erros.js`, 02/10/2026). O handler central
   devolvia `error.message` de tudo: o navegador recebia texto do PostgreSQL (nome de coluna,
   constraint, tabela), caminho completo do disco (ENOENT) e falha de conexão do pool. Agora
   `respostaDeErro()` esconde erro do banco, de sistema, nativo do JS e de conexão (500 genérico,
   detalhe no log) e traduz os que o usuário resolve (23505/23503 → 409, 22P02 → 400, deadlock →
   409). Mensagem de negócio (`throw new Error("...")` ou com `statusCode`) passa igual a antes.
   Toda rota com `catch` próprio usa `respostaDeErro`/`mensagemPublica`, nunca `erro.message` cru.
7. **Reconfirmação de senha também conta no limite** (`avarias.routes.js` `senhaAdminConfere`,
   troca de senha em `/api/admin/config`). Antes só o login tinha limite: com uma sessão de admin
   esquecida aberta dava para testar senhas sem limite por ali e sair com a senha.
8. **Credencial OMIE recusada para a sincronização automática** (`omie.api.js`
   `ehErroDeCredencial`, `job.runner.js`, `scheduler.js`, `integration.repository.js`). O padrão
   não tinha acento e não reconhecia o texto real da OMIE, então chave recusada virava erro de
   dados retentável e o agendador insistia até a OMIE bloquear a conta por consumo indevido.
   Agora: texto comparado sem acento, 401/403 = autenticação, e com `status = ERRO_AUTENTICACAO`
   o agendador não enfileira nem executa nada daquela integração. Só salvar credencial nova
   (`PENDENTE`) ou teste de conexão bem-sucedido liberam; outra falha não sobrescreve o bloqueio.
   O clique do operador (`manual: true`) ainda pode tentar. "chave de acesso" sozinha **não** conta
   como credencial — é também a chave de 44 dígitos da NF-e.

Testes: `tests/seguranca-erros-omie.test.js` (unidade) e `tests/seguranca-ataque.test.js` (servidor
real em banco descartável: erro do banco não aparece na resposta; 4ª senha errada → 429).

## Checklist ao revisar mudanças

1. **Rota nova**: tem `requireUser`? Se é administrativa, passa `"admin"` como terceiro argumento?
   Se aceita `pdvId`/`pdv_id` do cliente, é rota de admin? (Em rota de PDV, sempre `user.pdvId`.)
2. **Query nova**: usa `$1` para todo valor? Se interpola identificador (nome de tabela/coluna),
   ele vem de lista fixa interna ou de `escapeIdentifier`? Nunca de input do usuário.
3. **Caminho de arquivo vindo do cliente**: resolvido com `path.resolve` + checagem de
   `path.relative` começando com `..`? Nunca confiar em `startsWith` de string crua.
4. **Corpo de requisição**: passa por `readBody` (que corta em 8 MB) ou tem teto próprio? Nenhum
   `for await (const chunk of req)` sem limite.
5. **Mensagem de erro ao cliente**: não devolve `error.message` cru do driver/sistema em rota
   pública. Erro técnico vai para o log, mensagem em português vai para o usuário.
6. **Segredo novo**: entra no `.env.local` (ignorado pelo Git) e no `.env.example` com placeholder.
   Nunca com fallback para valor fixo no código.
7. **Comentário/doc novo**: não expõe senha, token, IP externo ou detalhe que ajude quem já está na
   rede. IP RFC1918 (192.168.x.x) em doc é risco baixo, mas não acrescente mais.

## Testes de ataque que valem re-rodar

Sobem contra um banco descartável (nunca produção — crie um com `db/estrutura.dump`, veja
`myestoque-ops`). Todos devem falhar do ponto de vista do atacante:

- Rotas `/api/admin/*` sem cookie → 401.
- Cookie JWT assinado com segredo errado → 401. JWT com `alg=none` → 401.
- Sessão de PDV chamando `/api/admin/*` → 403 (inclusive `/api/admin/backup/gerar` e `/restaurar`,
  que exporiam/destruiriam dados de todos).
- PDV A forçando `pdvId` do PDV B → não retorna dados do B.
- Payloads de SQLi em `q`, `pdvId`, `status` → HTTP 200 (tratados como texto), e **contagem de
  tabelas inalterada** depois. É a contagem que prova, não o status HTTP.
- 4+ tentativas de senha errada → 429 (login ou reconfirmação), e a senha correta também é
  bloqueada durante a janela.
- Tabela renomeada no banco descartável → resposta 500 genérica, sem nome de tabela/coluna/SQL.
- `/../../../.env.local` e variantes codificadas no servidor estático → sem vazamento.
- Upload acima do limite → 413, conexão cortada, e o servidor continua respondendo.

## Pendências conhecidas (decisão do usuário, não são bugs esquecidos)

- **Senhas padrão do seed antigo estão públicas no histórico do GitHub** (`admin123` para o
  almoxarifado, `123456` para PDVs). Verificado em 2026-08-11: **nenhuma credencial de produção usa
  esses valores**. Se algum dia uma instalação nova for criada a partir de um seed antigo, rotacionar
  imediatamente. Remover do HEAD não adianta — já foi publicado.
- **Ref do projeto Supabase no histórico**. O Supabase saiu do projeto; confirmar que o projeto
  remoto foi desativado de fato. Não é rotacionável, então reescrever histórico tem valor baixo.
- **Senha mínima de 4 caracteres** (`setup.routes.js`, `index.js`). Com o rate limit de 3/5min, uma
  senha de 4 dígitos (10 mil combinações) leva ~11 dias de tentativas ininterruptas a partir de um
  único IP. Aumentar o mínimo é decisão de usabilidade.
- **O bloqueio é por IP**: numa máquina compartilhada, 3 erros de uma pessoa bloqueiam o login de
  todos naquele PC por 5 minutos. Consequência aceita junto com o limite de 3.
- **Sem revogação de sessão**: trocar a senha do admin não invalida JWTs já emitidos (validade 8h).
- **Sem cabeçalhos de segurança** (`X-Content-Type-Options`, CSP, `X-Frame-Options`).
- **`cookie@0.6.0`** tem CVE-2024-47764, não explorável aqui (só recebe o JWT e opções fixas).
  Subir para ≥0.7.0 quando conveniente.
- **`.env.production.local` e `.env.local.bak`** na raiz contêm credenciais legadas de Supabase e
  Vercel. Nunca foram commitados e estão cobertos pelo `.gitignore`, mas são credenciais válidas em
  disco — revogar na origem e apagar.

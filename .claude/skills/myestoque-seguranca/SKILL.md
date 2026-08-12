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
  usuário (mesma mensagem para PDV inexistente e senha errada), rate limit de 8 tentativas/5min por
  IP cobrindo admin e PDV. Testado contra JWT forjado e `alg=none` — ambos rejeitados.
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
- 9+ tentativas de senha errada → 429, e a senha correta também é bloqueada durante a janela.
- `/../../../.env.local` e variantes codificadas no servidor estático → sem vazamento.
- Upload acima do limite → 413, conexão cortada, e o servidor continua respondendo.

## Pendências conhecidas (decisão do usuário, não são bugs esquecidos)

- **Senhas padrão do seed antigo estão públicas no histórico do GitHub** (`admin123` para o
  almoxarifado, `123456` para PDVs). Verificado em 2026-08-11: **nenhuma credencial de produção usa
  esses valores**. Se algum dia uma instalação nova for criada a partir de um seed antigo, rotacionar
  imediatamente. Remover do HEAD não adianta — já foi publicado.
- **Ref do projeto Supabase no histórico**. O Supabase saiu do projeto; confirmar que o projeto
  remoto foi desativado de fato. Não é rotacionável, então reescrever histórico tem valor baixo.
- **Senha mínima de 4 caracteres** (`setup.routes.js`, `index.js`). Com o rate limit de 8/5min, uma
  senha de 4 dígitos ainda cai em poucos dias. Aumentar o mínimo é decisão de usabilidade.
- **Sem revogação de sessão**: trocar a senha do admin não invalida JWTs já emitidos (validade 8h).
- **Sem cabeçalhos de segurança** (`X-Content-Type-Options`, CSP, `X-Frame-Options`).
- **`cookie@0.6.0`** tem CVE-2024-47764, não explorável aqui (só recebe o JWT e opções fixas).
  Subir para ≥0.7.0 quando conveniente.
- **`.env.production.local` e `.env.local.bak`** na raiz contêm credenciais legadas de Supabase e
  Vercel. Nunca foram commitados e estão cobertos pelo `.gitignore`, mas são credenciais válidas em
  disco — revogar na origem e apagar.

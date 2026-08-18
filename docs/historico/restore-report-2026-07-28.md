# Relatorio de restauracao - Vercel production

Data local: 2026-07-28
Projeto Vercel: acpark (prj_P5SejdRM4FIZu776c3EBO6XYWkLW)
Team/Org: team_IkXpIJ1dj5LEtyYHaDIwNmYR
Deployment de referencia: dpl_k8AKa14BNEku7RFM4VubknrgAM6w
URL do deployment: acpark-o01qmb759-ruanaraujosenacgo-6238s-projects.vercel.app
Dominio de producao: acpark.vercel.app
Publicado em: 2026-07-23 12:51:50 -03:00
Target: production
Origem: cli
Commit Git: nao informado pelo deployment de producao
Branch: nao informada pelo deployment de producao

Backup criado antes da restauracao:
C:\Users\User\Documents\MyEstoque-backup-antes-restauracao-2026-07-28-1007

Arquivos de referencia usados:
- Frontend publico baixado diretamente de https://acpark.vercel.app: index.html, app.js, styles.css, modulos JS importados e logo-print.png.
- Backend restaurado a partir do pacote local .vercel/output/functions/api/index.func, que corresponde ao pacote de funcao do fluxo CLI.

Arquivos restaurados/substituidos:
- package.json
- pnpm-lock.yaml
- api/index.js
- public/**
- server/**

Arquivos preservados:
- .env.local
- .env.production.local
- .env.example
- .vercel/project.json e configuracoes locais do Vercel
- Banco de dados e dados remotos/locais: nao alterados
- Backup completo com alteracoes locais recentes e arquivos nao rastreados

Diferencas de configuracao:
- Variaveis locais preservadas por nome: DATABASE_URL, JWT_SECRET, STORAGE_BUCKET, STORAGE_DRIVER, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL.
- Valores de segredos nao foram exibidos nem substituidos.
- Dependencias alinhadas com o pacote publicado: cookie@0.6.0 e qz-tray@2.2.6.

Validacoes executadas:
- node --check server/index.js: OK
- node --check public/app.js: OK
- node tests/server-routes.test.js: 6 testes passaram
- Servidor local: http://localhost:5173 retornou HTTP 200
- Hash local de public/app.js e public/styles.css igual aos arquivos baixados da producao

Problemas/pontos de atencao:
- O deployment de producao foi feito via CLI e nao informa commit/branch Git.
- A CLI local do Vercel falhou em inspect por erro de ambiente/rede (spawn EPERM / ECONNREFUSED 127.0.0.1:9), entao os metadados foram confirmados pelo conector Vercel e os assets publicos foram baixados diretamente do dominio de producao.
- Nao foi executada verificacao visual automatizada em navegador porque a ferramenta agent-browser nao esta disponivel neste ambiente; a equivalencia visual foi verificada por hash dos assets servidos.

Publicacao:
- Nenhuma publicacao no Vercel foi realizada.
- Nenhuma migracao de banco foi executada.

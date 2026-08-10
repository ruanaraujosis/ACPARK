# Implantação em rede local (LAN), sem Vercel/Supabase

Este documento descreve como rodar o MyEstoque inteiramente em um computador da rede local, acessível pelos PDVs e pelo Almoxarifado em dispositivos diferentes, funcionando mesmo sem internet. A integração com a OMIE continua existindo, mas só sincroniza quando há internet disponível — sem travar o resto do sistema quando não há.

Para o deploy na Vercel (se ainda quiser usar como alternativa), veja [DEPLOY.md](DEPLOY.md).

## 1. Banco de dados: PostgreSQL local

1. Instale o PostgreSQL no Windows (instalador oficial em postgresql.org/download/windows). Qualquer versão recente (16+) serve.
2. Durante a instalação, marque o componente "Command Line Tools" (instala `psql`, `pg_dump`, `pg_restore`) e anote a senha do superusuário.
3. Adicione a pasta `bin` do PostgreSQL ao PATH do Windows (ex: `C:\Program Files\PostgreSQL\16\bin`).
4. Crie um usuário e banco dedicados ao sistema:
   ```sql
   CREATE ROLE myestoque_app LOGIN PASSWORD 'sua-senha-local-forte';
   CREATE DATABASE myestoque OWNER myestoque_app;
   ```
5. A `DATABASE_URL` resultante fica assim (sem `sslmode`, o `server/db.js` já desliga SSL automaticamente para `localhost`):
   ```
   DATABASE_URL=postgres://myestoque_app:sua-senha-local-forte@localhost:5432/myestoque
   ```

### Restaurar o banco a partir de um dump

Se precisar recriar o banco local do zero (perda/corrupção), restaure sempre a partir de um dump
real (`pg_dump`/`pg_restore` completo) — nunca confie só em `server/schema.sql`, que não cobre
tabelas/colunas criadas em tempo de execução pelas funções `ensureXxxTable()` das rotas.

```
pg_restore -d "postgres://myestoque_app:sua-senha-local-forte@localhost:5432/myestoque" --no-owner --no-privileges -v seu_backup.dump
```

Depois do restore, rode `REASSIGN`/`ALTER TABLE ... OWNER TO myestoque_app` em todas as tabelas —
dumps vindos de outro ambiente costumam trazer políticas de RLS herdadas que deixam as tabelas
inacessíveis para o usuário da aplicação até isso ser corrigido.

## 2. Fotos de avaria: storage local

1. Configure no `.env.local`:
   ```
   STORAGE_DRIVER=local
   STORAGE_LOCAL_ROOT=.storage
   STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true
   ```
2. A pasta `.storage/` é a única cópia das fotos — inclua-a numa rotina de backup própria (cópia periódica para outro disco/NAS).

## 3. Variáveis de ambiente da LAN

No `.env.local` do computador que vai hospedar o sistema:

```
NODE_ENV=production
DATABASE_URL=postgres://myestoque_app:sua-senha-local-forte@localhost:5432/myestoque
JWT_SECRET=troque-por-uma-chave-longa-e-exclusiva
INTEGRATION_ENCRYPTION_KEY=troque-por-uma-chave-longa-e-exclusiva
STORAGE_DRIVER=local
STORAGE_LOCAL_ROOT=.storage
STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true
PORT=5173
OMIE_ENABLED=true
OMIE_SCHEDULER_ENABLED=true
OMIE_SCHEDULER_TICK_MS=5000
```

`NODE_ENV=production` é seguro aqui: o cookie de sessão não depende mais dessa variável (só de `VERCEL` ou de `FORCE_SECURE_COOKIES=true`, para um cenário futuro com HTTPS interno), então o login funciona normalmente em HTTP puro na rede local. Setar `NODE_ENV=production` também passa a exigir uma `INTEGRATION_ENCRYPTION_KEY` real, o que é bom para proteger as credenciais da OMIE.

**Checagens que assumem hospedagem na nuvem** (não fazem sentido para a LAN, pode ignorar):
- `npm run storage:check` usa a flag `--require-durable`, que rejeita storage local de propósito — para a LAN, rode `node tools/check-storage-config.js` sem essa flag.
- `npm run production:check` inclui uma checagem de "storage durável" que sempre falha com storage local — essa checagem é para o deploy na Vercel, não é aplicável aqui.

## 4. Rodar como serviço do Windows (sempre ativo)

Recomendado: [NSSM](https://nssm.cc/) — cria um serviço nativo do Windows, reinicia sozinho se cair, sobe automaticamente no boot mesmo sem ninguém logado.

1. Baixe o NSSM, extraia `nssm.exe` para uma pasta no PATH (ex: `C:\tools\nssm\`).
2. `nssm install MyEstoque`:
   - Application path: caminho completo do `node.exe` (`where node`)
   - Arguments: caminho completo de `server\index.js`
   - Startup directory: raiz do repositório (onde está o `.env.local`)
3. `nssm start MyEstoque`. Confirme em `services.msc` que o tipo de inicialização está "Automático".
4. Teste derrubando o processo `node.exe` no Gerenciador de Tarefas e confirme que o NSSM sobe de novo sozinho em poucos segundos.

Com o serviço instalado, o servidor **já fica sempre ativo** — inclusive antes de qualquer login no Windows. Ninguém precisa "iniciar o sistema"; ele já está rodando quando a máquina liga.

## 5. Acesso pela rede local

1. `ipconfig` na máquina host → anote o IPv4 do adaptador ativo (ex: `192.168.1.50`).
2. Libere a porta no Firewall do Windows (PowerShell como administrador):
   ```powershell
   New-NetFirewallRule -DisplayName "MyEstoque LAN" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Any
   ```
3. Reserve esse IP no DHCP do roteador (associando ao endereço MAC da máquina host), para o endereço não mudar depois que o roteador reiniciar.
4. Os PDVs e o Almoxarifado acessam por `http://<IP-da-máquina-host>:5173`.

## 6. Aplicativo instalável (pasta `desktop-app/`)

O sistema tem um aplicativo desktop próprio, feito em Electron, em `desktop-app/`. Ele é só a "casca" do sistema: abre a interface numa janela própria (sem abas nem barra de endereço), com o ícone da logo. Quem serve os dados continua sendo o servidor que roda como serviço do Windows — o app não inicia nada.

### Instalar num computador (Almoxarifado ou PDV)

1. Copie `desktop-app/dist/MyEstoque Setup 1.0.0.exe` para o computador.
2. Execute e siga o instalador (permite escolher a pasta; cria atalho na área de trabalho e no menu Iniciar).
3. Abra o **MyEstoque** pelo atalho. Na primeira execução ele já aponta para `http://192.168.1.207:5173`.
4. Se o endereço do servidor for outro, use o menu **Sistema → Configurar endereço do servidor**. A configuração fica salva por computador.

O mesmo instalador serve para todas as máquinas — inclusive a do Almoxarifado, já que o IP da rede também responde na própria máquina que hospeda o sistema.

### Recursos do app

- Menu **Sistema**: Recarregar (F5), Imprimir (Ctrl+P, para os pedidos), Configurar endereço do servidor, Sair.
- Menu **Exibir**: zoom, tela cheia, ferramentas do desenvolvedor (F12) para diagnóstico.
- Se o servidor estiver fora do ar ou o IP tiver mudado, aparece uma tela explicando o problema, com botões para tentar de novo ou corrigir o endereço — em vez de um erro técnico de navegador.
- A comunicação em tempo real (alertas de pedido via SSE) funciona igual ao navegador, já que o app roda sobre Chromium.

### Recompilar o instalador

Depois de alterar `main.js`, `erro.html`, `config.html` ou a logo:

```bash
cd desktop-app && npm run build
```

O instalador sai em `desktop-app/dist/`. Para regenerar o ícone a partir de `public/logo-print.png`:

```bash
powershell -ExecutionPolicy Bypass -File desktop-app/gerar-icone.ps1
```

> Se o build falhar com erro de link simbólico (`Cannot create symbolic link`), rode `npm run build` uma vez num PowerShell **como Administrador**. Isso é necessário só na primeira vez, para o electron-builder conseguir extrair o pacote de ferramentas de assinatura; depois o cache fica válido e os builds seguintes rodam normalmente.

## 7. Verificação

- `npm run test:sequential` — roda toda a suíte de testes automatizados.
- Desligue a internet da máquina host e confirme que a tela de login carrega sem erros no console (fontes, Tailwind e planilha agora são servidos localmente).
- De outro dispositivo na mesma rede, faça login como PDV, crie um pedido, e como Almoxarifado, libere-o.
- Com internet disponível, use "Sincronizar agora" na tela de integrações OMIE e confirme que funciona.
- Sem internet, use o mesmo botão e confirme que aparece um erro tratado, sem travar o resto do sistema.

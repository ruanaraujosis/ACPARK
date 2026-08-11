# Implantação em rede local (LAN)

Este documento descreve como rodar o MyEstoque inteiramente em um computador da rede local, acessível pelos PDVs e pelo Almoxarifado em dispositivos diferentes, funcionando mesmo sem internet. A integração com a OMIE continua existindo, mas só sincroniza quando há internet disponível — sem travar o resto do sistema quando não há. Este é o único caminho de hospedagem do projeto — não há mais dependência de nenhuma plataforma externa (Vercel/Supabase).

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

### Estrutura do banco: o dump versionado é a fonte da verdade

**`server/schema.sql` é legado e está incompleto.** A estrutura real do sistema vive em
`db/estrutura.dump` (formato custom do `pg_dump`, versionado no repositório), acompanhado de
`db/estrutura.sql` — a mesma coisa em texto puro, que existe só para revisar diferenças de
estrutura no Git, já que o formato custom é binário.

Estado atual da estrutura (medido no banco de produção):

| Origem | Tabelas |
|---|---|
| Banco de produção | 38 |
| Declaradas no `server/schema.sql` | 37 |
| Criadas só em runtime (`pedido_auditoria`) | 1 |
| Sem nenhuma origem no código | 0 |

O `schema.sql` continua incompleto (não cria `pedido_auditoria`) e, mesmo para as demais, não
reproduz índices, constraints e defaults com a mesma fidelidade do dump. Recriar um banco só a
partir dele produz um sistema diferente do de produção.

> Contexto histórico: até agosto/2026 a produção tinha 47 tabelas, sendo **9 sem nenhuma origem no
> código** — resíduo de recursos removidos (impressão automática por agente), antecessoras de
> tabelas atuais (`pedido_historico`, `pedido_operacao_idempotencia`) e um snapshot de permissões da
> época do Supabase. Foram apagadas por `tools/migracao-limpeza-tabelas-mortas.mjs`, com backup
> completo gerado antes.

#### Recriar o banco do zero (estrutura vazia)

```
pg_restore --host localhost --port 5432 --username myestoque_app --dbname myestoque --no-owner --no-privileges db/estrutura.dump
```

Depois do restore, **é obrigatório** reatribuir a propriedade de todas as tabelas e sequences:

```sql
ALTER TABLE public.<tabela> OWNER TO myestoque_app;
ALTER SEQUENCE public.<sequence> OWNER TO myestoque_app;
```

Isso não é formalidade: 14 tabelas têm **RLS ligada e nenhuma política** (herança da época do
Supabase). Com RLS nesse estado, só o dono da tabela enxerga as linhas — qualquer outro papel
recebe zero resultados, e o sistema sobe "funcionando" sem ver dado nenhum. O que mantém a
produção operando hoje é justamente `myestoque_app` ser dona de todas as tabelas.

#### Regerar o dump quando a estrutura mudar

Sempre que alterar a estrutura do banco (coluna nova, tabela nova, índice), regere e valide:

```bash
npm run dump:gerar
```

```bash
npm run dump:validar
```

O `dump:validar` cria um banco temporário, restaura o dump nele, confere contagem de tabelas,
sequences e estado de RLS contra a produção, testa a reatribuição de dono, confirma que as tabelas
com RLS ficam legíveis e apaga o banco de teste ao final. Requer que `myestoque_app` tenha o
privilégio `CREATEDB`:

```sql
ALTER ROLE myestoque_app CREATEDB;
```

Commite `db/estrutura.dump` e `db/estrutura.sql` junto com a mudança que alterou a estrutura —
o teste `tests/dump-estrutura.test.js` falha se o dump ficar defasado em relação ao `schema.sql`.

#### Restaurar um backup completo (com dados)

Para mover a operação inteira para outra máquina — cenário "mesma operação, máquina nova" — o
caminho é diferente do dump de estrutura: usa-se um backup completo (estrutura + dados) gerado na
máquina de origem.

### Gerar backup completo (estrutura + dados)

```bash
node tools/gerar-backup-completo.mjs --motivo "descreva por que"
```

Grava em `backups/` (pasta ignorada pelo Git — contém dados reais de produção, nunca versionar).
Sai um `.dump` (formato custom, para `pg_restore`) e um `.json` de manifesto com os totais
(pedidos, produtos, PDVs) para conferir depois de restaurar. Rode sempre antes de qualquer
migração de estrutura.

### Restaurar um backup completo pelo serviço (não em linha de comando crua)

`server/services/backup/backup.service.js` centraliza a lógica que o instalador (e qualquer
interface futura, como o `myestoqueConfig.exe`) vai usar para restaurar — não é para rodar
`pg_restore` direto na mão:

- **`validarArquivoBackup(caminho)`** — confere a assinatura mágica `PGDMP` do formato custom, lê o
  índice do arquivo (`pg_restore --list`) e recusa arquivo inexistente, truncado, corrompido ou sem
  dados, **sem tocar em banco nenhum**.
- **`bancoDestinoTemDados(databaseUrlDestino)`** — verifica se o banco de destino já tem estrutura
  e dados (conta linhas em `pedidos`/`produtos`/`pdvs`).
- **`restaurarBackup({ caminhoArquivo, databaseUrlDestino, confirmarSobrescrita, ensureAllRuntimeTables })`**
  — valida o arquivo, recusa sobrescrever banco com dados sem `confirmarSobrescrita: true`, roda o
  `pg_restore` (com `--clean --if-exists` só quando está sobrescrevendo), reatribui a propriedade de
  todas as tabelas e sequences ao usuário da aplicação, roda as rotinas de runtime (veja abaixo) e
  devolve um resumo (tabelas, pedidos, produtos, PDVs restaurados).

Erros são lançados como `BackupError` com um `codigo` estável (`ARQUIVO_INEXISTENTE`,
`ARQUIVO_TRUNCADO`, `FORMATO_INVALIDO`, `SEM_DADOS`, `DESTINO_TEM_DADOS`, `RESTAURACAO_FALHOU`) —
quem chama (rota HTTP, futura tela do instalador) traduz cada código numa mensagem em português
para o usuário, nunca expõe o erro técnico cru.

`server/services/backup/runtime-schema.service.js` expõe `ensureAllRuntimeTables()`, que roda em
sequência todas as rotinas `ensureXxxTable()` do servidor (hoje disparadas de forma preguiçosa, só
na primeira vez que a rota correspondente é usada). Depois de restaurar um backup de uma versão
anterior do sistema, isso garante a estrutura completa de uma vez, sem depender de qual tela
alguém abre primeiro.

**Validação de ponta a ponta**, sempre contra um banco descartável — nunca produção:

```bash
npm run backup:validar-restauracao
```

Cria um banco temporário, testa arquivo inválido/truncado/corrompido (rejeitados sem tocar em
banco), restaura em banco vazio, confere contagens/dono/RLS contra a origem, simula um backup
antigo (apaga uma tabela de runtime e confirma que `ensureAllRuntimeTables` recria), testa que
sobrescrever sem confirmação é recusado, testa que com confirmação funciona, e apaga o banco de
teste ao final — 18/18 verificações na última execução.

## 1.1 Reiniciar o serviço sem terminal de administrador

Por padrão, só SYSTEM e o grupo Administradores podem iniciar/parar um serviço do Windows —
qualquer usuário comum recebe "Não é possível abrir o serviço" ao tentar `Restart-Service`. Isso
inviabiliza o botão "Reiniciar servidor" da Frente 3 (precisa funcionar sem UAC, em conta comum).

A solução é conceder start/stop **só para o serviço `MyEstoque`**, via `sc sdset` no descritor de
segurança do serviço (SDDL) — nunca uma permissão ampla de administrador:

```powershell
sc.exe sdset MyEstoque "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWRPWPLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"
```

A única mudança em relação ao padrão do Windows é o bloco `IU` (Usuários Interativos): de
`CCLCSWLOCRRC` (só consulta) para `CCLCSW**RPWP**LOCRRC` (consulta + iniciar `RP` + parar `WP`).
SYSTEM (`SY`) e Administradores (`BA`) continuam com controle total, como sempre foram.

Precisa rodar uma única vez, com PowerShell como Administrador. Depois disso, qualquer usuário
logado na máquina consegue `Restart-Service MyEstoque` (ou o app clicar no botão) sem UAC e sem
senha de administrador.

**Isso é uma flexibilização deliberada de segurança**, restrita a este único serviço — qualquer
usuário local passa a poder parar o MyEstoque. Aceitável numa máquina dedicada ao servidor; nunca
deve ser replicado para outros serviços nem para máquinas de uso geral.

Para conferir o estado atual: `sc.exe sdshow MyEstoque`. Para reverter ao padrão do Windows:

```powershell
sc.exe sdset MyEstoque "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)"
```

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

`NODE_ENV=production` é seguro aqui: o cookie de sessão não depende mais dessa variável (só de `FORCE_SECURE_COOKIES=true`, para um cenário futuro com HTTPS interno), então o login funciona normalmente em HTTP puro na rede local. Setar `NODE_ENV=production` também passa a exigir uma `INTEGRATION_ENCRYPTION_KEY` real, o que é bom para proteger as credenciais da OMIE.

**Checagens que assumem hospedagem em nuvem/serverless** (não fazem sentido para a LAN, pode ignorar):
- `npm run storage:check` usa a flag `--require-durable`, que rejeita storage local de propósito — para a LAN, rode `node tools/check-storage-config.js` sem essa flag.
- `npm run production:check` inclui uma checagem de "storage durável" que sempre falha com storage local — essa checagem é para hospedagem serverless, não é aplicável aqui.

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

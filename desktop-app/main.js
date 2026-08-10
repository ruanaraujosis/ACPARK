// Processo principal do aplicativo MyEstoque (Electron).
// O app e apenas a "casca" do sistema: o servidor roda sempre ativo como
// servico do Windows na maquina do Almoxarifado, e este aplicativo abre
// a interface numa janela propria (sem abas nem barra de endereco).
const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// Endereco usado quando ainda nao existe configuracao salva
const ENDERECO_PADRAO = "http://192.168.1.207:5173";

let janela = null;

// Caminho do arquivo de configuracao (fica na pasta de dados do usuario, fora do app)
function caminhoConfig() {
  return path.join(app.getPath("userData"), "config.json");
}

// Le o endereco do servidor salvo; cai no padrao se nao houver nada valido
function lerEndereco() {
  try {
    const bruto = fs.readFileSync(caminhoConfig(), "utf8");
    const dados = JSON.parse(bruto);
    if (dados && typeof dados.servidor === "string" && dados.servidor.trim()) {
      return dados.servidor.trim();
    }
  } catch {
    // Sem config ainda (primeira execucao) ou arquivo corrompido: usa o padrao
  }
  return ENDERECO_PADRAO;
}

// Grava o endereco do servidor escolhido pelo usuario
function salvarEndereco(endereco) {
  fs.writeFileSync(caminhoConfig(), JSON.stringify({ servidor: endereco }, null, 2));
}

// Normaliza o que o usuario digitou (aceita "192.168.1.207:5173" sem http://)
function normalizarEndereco(valor) {
  let texto = String(valor || "").trim();
  if (!texto) return "";
  if (!/^https?:\/\//i.test(texto)) texto = "http://" + texto;
  return texto.replace(/\/+$/, "");
}

// Abre a tela de configuracao do endereco do servidor
function abrirConfiguracao() {
  if (!janela) return;
  janela.loadFile(path.join(__dirname, "config.html"), {
    query: { atual: lerEndereco() }
  });
}

// Carrega o sistema; se falhar, a tela de erro aparece pelo evento did-fail-load
function carregarSistema() {
  if (!janela) return;
  janela.loadURL(lerEndereco());
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: path.join(__dirname, "icone.ico"),
    title: "MyEstoque",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Evita piscar tela branca: so mostra quando o conteudo esta pronto
  janela.once("ready-to-show", () => janela.show());

  // Se o servidor estiver fora do ar ou o endereco estiver errado, mostra tela de erro
  janela.webContents.on("did-fail-load", (_evento, codigoErro, descricao, urlQueFalhou, ehQuadroPrincipal) => {
    if (!ehQuadroPrincipal) return;
    // -3 = requisicao abortada (acontece em navegacao normal), nao e falha real
    if (codigoErro === -3) return;
    janela.loadFile(path.join(__dirname, "erro.html"), {
      query: { servidor: lerEndereco(), detalhe: `${descricao} (${codigoErro})`, url: urlQueFalhou || "" }
    });
  });

  // Links externos abrem no navegador padrao, nunca dentro da janela do app
  janela.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  carregarSistema();
}

// Menu enxuto em portugues (o sistema tem impressao de pedidos, entao Imprimir fica acessivel)
function montarMenu() {
  const template = [
    {
      label: "Sistema",
      submenu: [
        { label: "Recarregar", accelerator: "F5", click: () => carregarSistema() },
        { label: "Imprimir...", accelerator: "CmdOrCtrl+P", click: () => janela?.webContents.print() },
        { type: "separator" },
        { label: "Configurar endereco do servidor...", click: () => abrirConfiguracao() },
        { type: "separator" },
        { label: "Sair", role: "quit" }
      ]
    },
    {
      label: "Exibir",
      submenu: [
        { label: "Aumentar zoom", role: "zoomIn" },
        { label: "Diminuir zoom", role: "zoomOut" },
        { label: "Zoom normal", role: "resetZoom" },
        { type: "separator" },
        { label: "Tela cheia", role: "togglefullscreen" },
        { label: "Ferramentas do desenvolvedor", accelerator: "F12", role: "toggleDevTools" }
      ]
    },
    {
      label: "Ajuda",
      submenu: [
        {
          label: "Sobre",
          click: () => {
            dialog.showMessageBox(janela, {
              type: "info",
              title: "MyEstoque",
              message: "MyEstoque",
              detail:
                `Aplicativo do sistema de estoque e pedidos.\n\n` +
                `Servidor: ${lerEndereco()}\n` +
                `Versao do app: ${app.getVersion()}\n\n` +
                `O servidor roda como servico do Windows na maquina do Almoxarifado.`,
              buttons: ["OK"]
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Canais usados pelas telas internas (erro.html e config.html)
ipcMain.handle("obter-endereco", () => lerEndereco());
ipcMain.handle("tentar-novamente", () => carregarSistema());
ipcMain.handle("abrir-configuracao", () => abrirConfiguracao());
ipcMain.handle("salvar-endereco", (_evento, valor) => {
  const endereco = normalizarEndereco(valor);
  if (!endereco) return { ok: false, erro: "Informe o endereco do servidor." };
  salvarEndereco(endereco);
  carregarSistema();
  return { ok: true };
});

app.whenReady().then(() => {
  montarMenu();
  criarJanela();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) criarJanela();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

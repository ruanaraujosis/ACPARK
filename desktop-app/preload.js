// Ponte segura entre as telas internas (erro/config) e o processo principal.
// contextIsolation fica ligado, entao so estas funcoes ficam expostas.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("myestoque", {
  obterEndereco: () => ipcRenderer.invoke("obter-endereco"),
  tentarNovamente: () => ipcRenderer.invoke("tentar-novamente"),
  abrirConfiguracao: () => ipcRenderer.invoke("abrir-configuracao"),
  salvarEndereco: (valor) => ipcRenderer.invoke("salvar-endereco", valor)
});

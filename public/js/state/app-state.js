// Elemento raiz onde todas as telas (views) do app são renderizadas
export const app = document.querySelector("#app");

// Estado global compartilhado da aplicação: usuário logado, dados carregados no bootstrap
// (PDVs, produtos, categorias, config), carrinho do pedido em andamento e tela atual
export const state = {
  user: null,
  pdvs: [],
  products: [],
  categories: [],
  config: {},
  cart: [],
  // Chave usada para evitar envio duplicado do mesmo pedido
  orderIdempotencyKey: null,
  // Contagem de pedidos pendentes de liberação, exibida no badge do Almoxarifado
  orderAlertPendingCount: 0,
  currentView: null
};

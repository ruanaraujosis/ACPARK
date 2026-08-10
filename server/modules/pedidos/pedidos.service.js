// Status oficiais do fluxo de pedidos, na ordem do quadro Kanban de liberação
export const orderStatuses = ["Pendente", "Em Andamento", "Aguardando Retirada", "Finalizado"];

// Inclui variações legadas/encoding incorreto de "Liberação Parcial" persistidas no banco
const releasedOrderStatuses = new Set(["Aguardando Retirada", "Liberação Parcial", "LiberaÃ§Ã£o Parcial", "Finalizado", "Liberado Parcial", "Liberado"]);

// Indica se o pedido já teve alguma liberação de quantidade (parcial ou total)
export function isReleasedOrderStatus(status) {
  return releasedOrderStatuses.has(status) || releasedOrderStatuses.has(normalizeOrderStatus(status));
}

// Traduz status legados/com problema de encoding para os status atuais do fluxo
export function normalizeOrderStatus(status) {
  if (status === "Liberado") return "Finalizado";
  if (status === "Liberado Parcial" || status === "Liberação Parcial" || status === "LiberaÃ§Ã£o Parcial") return "Aguardando Retirada";
  return status || "Pendente";
}

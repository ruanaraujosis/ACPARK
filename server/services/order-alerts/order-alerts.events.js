import crypto from "node:crypto";

// Conexoes SSE ativas aguardando eventos de alerta de pedidos
const clients = new Set();
// Buffer dos ultimos eventos, enviado a clientes que acabaram de conectar
const recentEvents = [];
const maxRecentEvents = 100;

// Escreve um evento SSE em uma conexao especifica (usado na conexao inicial)
function writeEvent(res, type, payload = {}) {
  const event = {
    eventId: payload.eventId || crypto.randomUUID(),
    type,
    ...payload,
    createdAt: payload.createdAt || new Date().toISOString()
  };
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  return event;
}

// Publica um evento de alerta para todos os clientes SSE conectados
export function publishOrderAlert(type, payload = {}) {
  const event = {
    eventId: payload.eventId || crypto.randomUUID(),
    type,
    ...payload,
    createdAt: payload.createdAt || new Date().toISOString()
  };
  recentEvents.push(event);
  while (recentEvents.length > maxRecentEvents) recentEvents.shift();

  const text = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(text);
    } catch {
      // Conexao morta: remove da lista de clientes ativos
      clients.delete(res);
    }
  }
  return event;
}

// Publica a mudanca de etapa de um pedido, para PDV e Almoxarifado verem o andamento na hora.
// O polling de 12s continua valendo como fallback: este evento apenas antecipa a atualizacao.
export function publishOrderStatusChange({ codigoPedido, de = "", para = "", pdvId = null, pdv = "", usuario = "", origem = "" } = {}) {
  if (!codigoPedido || !para) return null;
  return publishOrderAlert("ORDER_STATUS_CHANGED", {
    orderId: codigoPedido,
    codigoPedido,
    statusAnterior: de || null,
    status: para,
    pdvId,
    pdv,
    usuario,
    origem
  });
}

// Handler HTTP que abre e mantem a conexao SSE com o cliente
export function handleOrderAlertEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  writeEvent(res, "ORDER_ALERTS_CONNECTED", {
    recentEventIds: recentEvents.map((event) => event.eventId)
  });
  clients.add(res);
  // Remove o cliente da lista quando a conexao for encerrada
  req.on("close", () => clients.delete(res));
}

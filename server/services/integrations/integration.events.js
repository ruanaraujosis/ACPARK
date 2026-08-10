// Conexoes SSE ativas que recebem eventos de integracao em tempo real
const clients = new Set();

// Envia um evento SSE para todos os clientes conectados
export function publishIntegrationEvent(event, payload = {}) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      // Cliente desconectado: remove da lista de assinantes
      clients.delete(res);
    }
  }
}

// Abre um stream SSE (Server-Sent Events) e registra o cliente para receber eventos
export function handleIntegrationEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  clients.add(res);
  // Remove o cliente da lista quando a conexao for encerrada
  req.on("close", () => clients.delete(res));
}

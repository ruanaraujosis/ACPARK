// Canal de eventos em tempo real para o PDV.
//
// Por que não reaproveitar o canal de alertas de pedido: aquele é do Almoxarifado
// (`/api/admin/order-alert-events` recusa quem não é admin) e transmite todo evento para
// todos os conectados. Abri-lo ao PDV entregaria a cada ponto de venda os pedidos e as
// contagens dos outros. Aqui cada conexão guarda o pdvId da sessão, e o evento só é escrito
// para quem é o dono.
//
// O fallback de polling continua valendo: este canal apenas antecipa a atualização.
import crypto from "node:crypto";

// Conexões abertas, cada uma com o PDV a que pertence
const conexoes = new Set();

// Monta e serializa o evento no formato SSE
function montarEvento(tipo, payload = {}) {
  const evento = {
    eventId: payload.eventId || crypto.randomUUID(),
    type: tipo,
    ...payload,
    createdAt: payload.createdAt || new Date().toISOString()
  };
  return { evento, texto: `event: ${tipo}\ndata: ${JSON.stringify(evento)}\n\n` };
}

// Publica um evento para UM PDV. Sem pdvId nada é enviado: é melhor o PDV descobrir pelo
// polling do que um evento vazar para todos por causa de um campo esquecido.
export function publicarEventoDoPdv(tipo, pdvId, payload = {}) {
  if (pdvId === null || pdvId === undefined) return null;
  const alvo = Number(pdvId);
  const { evento, texto } = montarEvento(tipo, { ...payload, pdvId: alvo });
  for (const conexao of conexoes) {
    if (conexao.pdvId !== alvo) continue;
    try {
      conexao.res.write(texto);
    } catch {
      conexoes.delete(conexao);
    }
  }
  return evento;
}

// Abre a conexão SSE do PDV logado
export function handleEventosDoPdv(req, res, pdvId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Sem isto um proxy pode bufferizar o fluxo e o "tempo real" vira lote
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 5000\n\n");

  const conexao = { res, pdvId: Number(pdvId) };
  conexoes.add(conexao);

  // Comentário periódico para a conexão não ser encerrada por inatividade
  const batida = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(batida);
      conexoes.delete(conexao);
    }
  }, 25000);

  const encerrar = () => {
    clearInterval(batida);
    conexoes.delete(conexao);
  };
  req.on("close", encerrar);
  req.on("error", encerrar);
}

// Quantas conexões existem agora (usado em teste)
export function conexoesAbertas() {
  return conexoes.size;
}

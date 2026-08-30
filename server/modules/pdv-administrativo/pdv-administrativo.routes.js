// Rotas do PDV Administrativo.
//
// "PDV Administrativo" NÃO é ponto de venda: é um perfil para setores internos que consomem
// estoque sem vender — escritório, limpeza, marketing, manutenção. Ele pede ao Almoxarifado
// como qualquer PDV, mas o que retira sai como CONSUMO INTERNO e não vira saldo de revenda.
//
// Por isso este painel não tem nenhuma seção de saldo/estoque: para este perfil, saldo não
// existe (é ausência, não zero). O que faz sentido acompanhar é o CONSUMO — quanto foi pedido,
// quando, e de quê.
import { query } from "../../db.js";
import { send } from "../../utils/http.js";
import {
  ensurePdvAdministrativoColumn,
  ehPdvAdministrativo,
} from "../../services/pdvs/pdv-administrativo.service.js";

// Adaptador: `ehPdvAdministrativo` recebe um client de transação; aqui basta a consulta solta.
const clienteSolto = {
  query: (texto, params) => query(texto, params).then((rows) => ({ rows })),
};

// Normaliza uma data vinda da tela; devolve null se não vier no formato esperado.
function dataValida(valor) {
  const texto = String(valor || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

export async function handlePdvAdministrativoRoutes(req, res, ctx) {
  const { method, requireUser, url, user } = ctx;

  // Perfil do PDV logado. Existe como rota própria porque o /api/bootstrap não pode ler a
  // coluna `administrativo` (fazer isso derrubou o login de todo mundo em 29/08/2026) — e a
  // navegação precisa saber o perfil antes de desenhar o menu.
  if (url.pathname === "/api/pdv/perfil" && method === "GET") {
    if (!requireUser(req, res, "pdv")) return true;
    await ensurePdvAdministrativoColumn();
    const administrativo = await ehPdvAdministrativo(clienteSolto, user.pdvId);
    send(res, 200, { administrativo });
    return true;
  }

  // Painel de consumo do setor: histórico de pedidos no período e ranking do que mais saiu.
  if (url.pathname === "/api/pdv/painel" && method === "GET") {
    if (!requireUser(req, res, "pdv")) return true;
    await ensurePdvAdministrativoColumn();
    const administrativo = await ehPdvAdministrativo(clienteSolto, user.pdvId);
    if (!administrativo) {
      send(res, 403, {
        error: "Este painel é exclusivo de PDV Administrativo.",
      });
      return true;
    }

    // Período padrão: os últimos 30 dias, para a tela abrir já com conteúdo.
    const hoje = new Date().toISOString().slice(0, 10);
    const trintaDias = new Date(Date.now() - 29 * 86400000)
      .toISOString()
      .slice(0, 10);
    const de = dataValida(url.searchParams.get("de")) || trintaDias;
    const ate = dataValida(url.searchParams.get("ate")) || hoje;
    if (de > ate) {
      send(res, 400, {
        error: "A data inicial não pode ser depois da data final.",
      });
      return true;
    }

    // `data_hora` é o instante do pedido. O filtro vai até o fim do dia final (< dia+1),
    // senão um pedido feito às 14h do último dia ficaria de fora.
    const filtro =
      "p.pdv_id = $1 AND p.data_hora >= $2::date AND p.data_hora < ($3::date + INTERVAL '1 day')";
    const params = [user.pdvId, de, ate];

    const [pedidos, ranking, resumo] = await Promise.all([
      query(
        `SELECT p.codigo_pedido, p.sku_produto, pr.nome AS produto, p.quantidade_solicitada,
                p.quantidade_liberada, p.status, p.data_hora, p.retirada_em, p.retirada_responsavel
         FROM pedidos p
         LEFT JOIN produtos pr ON pr.sku = p.sku_produto
         WHERE ${filtro}
         ORDER BY p.data_hora DESC, p.codigo_pedido, p.sku_produto`,
        params,
      ),
      // Ranking pelo que foi REALMENTE liberado: pedir não é consumir. Um pedido cortado pela
      // metade na liberação consumiu a metade, e é isso que o setor precisa enxergar.
      query(
        `SELECT p.sku_produto, COALESCE(pr.nome, p.sku_produto) AS produto,
                SUM(COALESCE(p.quantidade_liberada, 0))::int AS total_liberado,
                SUM(COALESCE(p.quantidade_solicitada, 0))::int AS total_solicitado,
                COUNT(DISTINCT p.codigo_pedido)::int AS pedidos
         FROM pedidos p
         LEFT JOIN produtos pr ON pr.sku = p.sku_produto
         WHERE ${filtro}
         GROUP BY p.sku_produto, pr.nome
         HAVING SUM(COALESCE(p.quantidade_liberada, 0)) > 0
         ORDER BY total_liberado DESC, produto
         LIMIT 20`,
        params,
      ),
      query(
        `SELECT COUNT(DISTINCT p.codigo_pedido)::int AS pedidos,
                COUNT(DISTINCT p.sku_produto)::int AS produtos,
                SUM(COALESCE(p.quantidade_liberada, 0))::int AS unidades
         FROM pedidos p
         WHERE ${filtro}`,
        params,
      ),
    ]);

    send(res, 200, {
      administrativo: true,
      periodo: { de, ate },
      pedidos,
      ranking,
      resumo: resumo[0],
    });
    return true;
  }

  return false;
}

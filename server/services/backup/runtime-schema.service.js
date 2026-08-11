// Chama todas as rotinas ensureXxxTable() do servidor, que hoje rodam de forma preguicosa
// (so na primeira vez que a rota correspondente e usada). Cada rota ja se protege sozinha,
// mas depois de restaurar um backup de uma versao anterior do sistema, e melhor deixar a
// estrutura completa de uma vez -- sem depender de qual tela alguem vai abrir primeiro.
import { ensurePedidoIdempotencyTable, ensurePedidoDraftTable, ensurePedidoEditColumns, ensurePedidoAuditTable } from "../../modules/pedidos/pedidos.routes.js";
import { ensureAvariaColumns, ensureAvariaIdempotencyTable } from "../../modules/avarias/avarias.routes.js";
import { ensureOrderAlertTables } from "../../modules/order-alerts/order-alerts.routes.js";

// Roda todas as rotinas em sequencia; cada uma ja e memoizada, entao chamar de novo nao repete trabalho
export async function ensureAllRuntimeTables() {
  await ensurePedidoIdempotencyTable();
  await ensurePedidoDraftTable();
  await ensurePedidoEditColumns();
  await ensurePedidoAuditTable();
  await ensureAvariaColumns();
  await ensureAvariaIdempotencyTable();
  await ensureOrderAlertTables();
}

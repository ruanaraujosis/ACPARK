// Perfil administrativo de PDV.
//
// "PDV Administrativo" NÃO é ponto de venda. É um perfil para setores internos que consomem
// estoque sem vender — escritório, limpeza, marketing, manutenção. Ele pede ao Almoxarifado
// como qualquer PDV, mas o produto liberado sai do estoque da empresa para CONSUMO INTERNO;
// não vira saldo de revenda em lugar nenhum.
//
// Essa é a razão de negócio por trás de todas as regras técnicas deste arquivo e da
// ramificação na confirmação de retirada.
import { tx } from "../../db.js";

let colunaPronta = null;

// A coluna nasce em runtime, no mesmo padrão de ensureAvariaColumns. `is_cozinha` NÃO foi
// reaproveitado de propósito: ele está morto (as rotas de criar/editar PDV gravam `false`
// fixo), então herdar aquele campo seria construir sobre algo que ninguém mantém.
export function ensurePdvAdministrativoColumn() {
  colunaPronta ||= tx(async (client) => {
    await client.query("ALTER TABLE pdvs ADD COLUMN IF NOT EXISTS administrativo BOOLEAN NOT NULL DEFAULT FALSE");
    // Consultas de saldo filtram por este campo; sem índice elas varrem a tabela inteira.
    // São 11 PDVs hoje, então o ganho é pequeno — o índice existe para o filtro não virar
    // varredura quando alguém listar saldo por PDV em consulta maior.
    await client.query("CREATE INDEX IF NOT EXISTS idx_pdvs_administrativo ON pdvs (administrativo) WHERE administrativo");
  });
  return colunaPronta;
}

// Um PDV é administrativo? Lê direto, sem cache: a tag pode mudar a qualquer momento pelo
// Almoxarifado, e decidir errado aqui significa creditar estoque em quem não deveria ter.
export async function ehPdvAdministrativo(client, pdvId) {
  if (pdvId === null || pdvId === undefined) return false;
  const { rows } = await client.query("SELECT administrativo FROM pdvs WHERE id = $1", [pdvId]);
  return rows[0]?.administrativo === true;
}

// Quais PDVs de uma lista são administrativos. Uma consulta só, para a confirmação de
// retirada não perguntar por item quando o pedido tem vários.
export async function pdvsAdministrativos(client, pdvIds = []) {
  const ids = [...new Set(pdvIds.filter((id) => id !== null && id !== undefined))];
  if (!ids.length) return new Set();
  const { rows } = await client.query(
    "SELECT id FROM pdvs WHERE id = ANY($1) AND administrativo = TRUE",
    [ids]
  );
  return new Set(rows.map((linha) => linha.id));
}

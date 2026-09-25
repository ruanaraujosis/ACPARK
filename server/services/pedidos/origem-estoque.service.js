// Local de estoque de ORIGEM de um pedido.
//
// pedidos.local_origem_pdv_id NULL = Almoxarifado (estoque central, produtos.qtd_total) --
// o comportamento de sempre. Com um PDV preenchido, a mercadoria sai do estoque DAQUELE PDV
// (estoque_pdv) e vai para o PDV solicitante: é a transferência entre pontos de venda.
//
// Decisões do usuário (23/09/2026): qualquer PDV não administrativo pode ser origem (o
// administrativo não tem saldo de revenda); origem sem saldo NÃO bloqueia, vira aviso, como já
// acontece com o estoque central; o padrão do PDV vale só para pedidos novos.

// Origem PADRÃO do pedido, em SQL: a das linhas que NÃO tiveram a origem escolhida no item
// (origem_por_item), mesmo que seja NULL = Almoxarifado, escolhido de propósito. Sem nenhuma
// linha assim (pedido novo, ou todos os itens ajustados um a um), vale o padrão do PDV.
// Recebe os números dos parâmetros onde estão o código do pedido e o PDV.
export function sqlOrigemDaNovaLinha(parametroCodigo, parametroPdv) {
  return `CASE
    WHEN EXISTS (SELECT 1 FROM pedidos po WHERE po.codigo_pedido = $${parametroCodigo} AND po.origem_por_item IS NOT TRUE)
      THEN (SELECT po.local_origem_pdv_id FROM pedidos po
            WHERE po.codigo_pedido = $${parametroCodigo} AND po.origem_por_item IS NOT TRUE ORDER BY po.id LIMIT 1)
    ELSE (SELECT pp.local_estoque_padrao_pdv_id FROM pdvs pp WHERE pp.id = $${parametroPdv})
  END`;
}

// Mesma origem padrão, lida em JS (para desfazer a divisão de um item)
export async function origemPadraoDoPedido(client, codigoPedido, pdvId) {
  const { rows } = await client.query(`SELECT ${sqlOrigemDaNovaLinha(1, 2)} AS origem`, [codigoPedido, pdvId]);
  const valor = rows[0]?.origem;
  return valor === null || valor === undefined ? null : Number(valor);
}

// Ordem para escolher em qual linha SOMAR quando o mesmo produto é pedido de novo: a da origem
// padrão primeiro, nunca uma parte ajustada à mão (senão a soma cairia num local escolhido para
// outra coisa). Desempata pelo id, como antes.
export const ORDEM_LINHA_PADRAO_PRIMEIRO = "ORDER BY (origem_por_item IS TRUE), id";

// Normaliza o valor vindo da tela: vazio/"ALMOX"/0 = Almoxarifado (NULL)
export function origemInformada(valor) {
  if (valor === null || valor === undefined || valor === "" || String(valor).toUpperCase() === "ALMOX") return null;
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : NaN;
}

function erro400(mensagem) {
  const erro = new Error(mensagem);
  erro.statusCode = 400;
  return erro;
}

// Confere se o PDV pode ser origem de um pedido que vai para `destinoPdvId`.
// NULL (Almoxarifado) sempre vale.
export async function validarOrigem(client, { origemPdvId, destinoPdvId }) {
  if (origemPdvId === null) return null;
  if (Number.isNaN(origemPdvId)) throw erro400("Local de origem inválido.");
  if (destinoPdvId !== null && destinoPdvId !== undefined && Number(destinoPdvId) === origemPdvId) {
    throw erro400("O local de origem não pode ser o próprio PDV de destino.");
  }
  const { rows } = await client.query("SELECT id, nome, administrativo FROM pdvs WHERE id = $1", [origemPdvId]);
  if (!rows[0]) throw erro400("PDV de origem não encontrado.");
  if (rows[0].administrativo === true) {
    throw erro400("PDV administrativo não tem estoque de revenda e não pode ser origem.");
  }
  return rows[0];
}

// Baixa a quantidade no local de origem e devolve o saldo resultante (para o aviso de
// negativo). Nunca bloqueia: saldo negativo é permitido e volta para a tela como aviso.
export async function debitarOrigem(client, { origemPdvId, sku, quantidade }) {
  if (origemPdvId === null || origemPdvId === undefined) {
    const { rows } = await client.query(
      "UPDATE produtos SET qtd_total = qtd_total - $1 WHERE sku = $2 RETURNING sku, nome, qtd_total AS saldo",
      [quantidade, sku]
    );
    return rows[0] ? { ...rows[0], local: "Almoxarifado" } : null;
  }
  // Sem linha no PDV de origem, nasce negativa (permitido = FALSE: saldo não libera pedido)
  const { rows } = await client.query(
    `INSERT INTO estoque_pdv (pdv_id, sku_produto, quantidade, permitido)
     SELECT $1, $2, -$3::numeric, FALSE
     WHERE EXISTS (SELECT 1 FROM produtos WHERE sku = $2)
     ON CONFLICT (pdv_id, sku_produto) DO UPDATE SET quantidade = estoque_pdv.quantidade - $3::numeric
     RETURNING sku_produto AS sku, quantidade AS saldo,
               (SELECT nome FROM produtos WHERE sku = $2) AS nome,
               (SELECT nome FROM pdvs WHERE id = $1) AS local`,
    [origemPdvId, sku, quantidade]
  );
  return rows[0] || null;
}

// Estorno de reabertura: devolve ao MESMO local de onde a mercadoria saiu
export async function estornarOrigem(client, { origemPdvId, sku, quantidade }) {
  if (origemPdvId === null || origemPdvId === undefined) {
    await client.query("UPDATE produtos SET qtd_total = qtd_total + $1 WHERE sku = $2", [quantidade, sku]);
    return;
  }
  await client.query(
    "UPDATE estoque_pdv SET quantidade = quantidade + $3::numeric WHERE pdv_id = $1 AND sku_produto = $2",
    [origemPdvId, sku, quantidade]
  );
}

// Pedido com item dividido (mesmo produto em mais de uma linha) não volta para Pendente: lá o
// PDV edita os itens e não sabe das partes -- somaria numa e deixaria a outra para trás
export async function exigirSemItemDividido(client, codigoPedido) {
  const { rows } = await client.query(
    "SELECT sku_produto FROM pedidos WHERE codigo_pedido = $1 GROUP BY sku_produto HAVING COUNT(*) > 1 LIMIT 1",
    [codigoPedido]
  );
  if (rows.length) {
    const erro = new Error(`O produto ${rows[0].sku_produto} está dividido entre origens. Desfaça a divisão antes de voltar o pedido para Pendente.`);
    erro.statusCode = 409;
    throw erro;
  }
}

// Número do PDV de origem de uma linha de pedido (NULL = Almoxarifado)
export function origemDaLinha(linha) {
  const valor = linha?.local_origem_pdv_id;
  return valor === null || valor === undefined ? null : Number(valor);
}

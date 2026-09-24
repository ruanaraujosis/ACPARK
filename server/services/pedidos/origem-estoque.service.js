// Local de estoque de ORIGEM de um pedido.
//
// pedidos.local_origem_pdv_id NULL = Almoxarifado (estoque central, produtos.qtd_total) --
// o comportamento de sempre. Com um PDV preenchido, a mercadoria sai do estoque DAQUELE PDV
// (estoque_pdv) e vai para o PDV solicitante: é a transferência entre pontos de venda.
//
// Decisões do usuário (23/09/2026): qualquer PDV não administrativo pode ser origem (o
// administrativo não tem saldo de revenda); origem sem saldo NÃO bloqueia, vira aviso, como já
// acontece com o estoque central; o padrão do PDV vale só para pedidos novos.

// Origem de uma linha nova de pedido, em SQL: se o pedido já tem linhas, herda a origem delas
// (mesmo que seja NULL = Almoxarifado, escolhida de propósito); senão, o padrão do PDV.
// Recebe os números dos parâmetros do INSERT onde estão o código do pedido e o PDV.
export function sqlOrigemDaNovaLinha(parametroCodigo, parametroPdv) {
  return `CASE
    WHEN EXISTS (SELECT 1 FROM pedidos po WHERE po.codigo_pedido = $${parametroCodigo})
      THEN (SELECT po.local_origem_pdv_id FROM pedidos po WHERE po.codigo_pedido = $${parametroCodigo} ORDER BY po.id LIMIT 1)
    ELSE (SELECT pp.local_estoque_padrao_pdv_id FROM pdvs pp WHERE pp.id = $${parametroPdv})
  END`;
}

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

// Número do PDV de origem de uma linha de pedido (NULL = Almoxarifado)
export function origemDaLinha(linha) {
  const valor = linha?.local_origem_pdv_id;
  return valor === null || valor === undefined ? null : Number(valor);
}

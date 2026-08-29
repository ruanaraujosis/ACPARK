// Aplica o resultado do inventário: ajusta o estoque local e enfileira o lançamento na OMIE.
//
// Regras que sustentam este arquivo:
//
// 1. SUBSTITUI, nunca soma. O inventário é a contagem física — o que está na prateleira passa
//    a ser a verdade, independente do que o sistema achava.
// 2. Produto sem contagem é ZERADO. Decisão do usuário (28/08/2026): quem não foi contado não
//    está na prateleira. Por isso `COALESCE(quantidade_contada, 0)` — e é o motivo de a tela
//    avisar, em letras grandes, quantos produtos serão zerados antes de o PDV enviar.
// 3. A confirmação NUNCA é bloqueada pela OMIE. O ajuste local acontece na mesma transação da
//    assinatura; o lançamento vai para a fila e drena quando houver internet.
// 4. Idempotência por inventário + produto: reprocessar a fila não pode ajustar duas vezes.
// 5. CONFIRMADO É IMUTÁVEL. Não existe reabertura nem lançamento compensatório: a partir da
//    confirmação, nada altera aquele inventário. Corrigir depois é abrir um inventário NOVO,
//    para o mesmo PDV, com o ciclo de vida do zero — a conclusão dele substitui o saldo outra
//    vez, local e na OMIE, exatamente como qualquer inventário faz.
//
//    O motivo de não haver compensação: o inventário escreve SALDO ABSOLUTO (SLD), e saldo não
//    compensa como movimento. Dois SLD em sequência não se anulam — o segundo simplesmente
//    sobrescreve o primeiro, o que é indistinguível de uma recontagem. A recontagem entrega o
//    mesmo resultado com trilha mais clara. Decidido com o usuário em 29/08/2026.
//    Travado por teste em tests/inventario-imutabilidade.test.js.
import { EVENTOS, registrarLancamento } from "../integrations/core/stock-launches.repository.js";

// Evento gravado na fila, declarado no núcleo junto dos demais tipos de lançamento.
// Reexportado aqui por conveniência de quem já trabalha no domínio de inventário.
export const EVENTO_AJUSTE_INVENTARIO = EVENTOS.AJUSTE_INVENTARIO;

// Chave de idempotência do ajuste de inventário.
//
// Não usa montarChaveIdempotencia() do repositório porque aquela prefixa "PEDIDO-" e numera a
// versão contando lançamentos do mesmo pedido. Aqui o par inventário + SKU já é único por
// natureza: um inventário confirmado nunca é reaberto (corrigir é abrir outro).
export function chaveAjusteInventario({ codigoInventario, sku }) {
  return `INVENTARIO-${codigoInventario}-SKU-${sku}-AJUSTE`;
}

// Local de estoque na OMIE vinculado ao PDV que contou.
//
// O local do Almoxarifado é configuração (`configuracao.local_almoxarifado`), nunca adivinhado;
// o de cada PDV vem de pdv_stock_location_mappings. Inventário do Almoxarifado tem pdv_id nulo
// e por isso cai no local configurado.
export async function localDoInventario(client, { pdvId, configuracao = {} }) {
  if (pdvId === null || pdvId === undefined) {
    const almoxarifado = String(configuracao?.local_almoxarifado || "").trim();
    return almoxarifado || null;
  }
  const { rows } = await client.query(
    `SELECT omie_location_id FROM pdv_stock_location_mappings
     WHERE pdv_acpark_id = $1 AND active = TRUE
     ORDER BY updated_at DESC LIMIT 1`,
    [pdvId]
  );
  return rows[0]?.omie_location_id || null;
}

// Aplica o ajuste no estoque local e devolve o que mudou, item a item.
//
// Roda dentro da transação da assinatura: se algo falhar aqui, a assinatura também não vale,
// e o inventário continua "Aguardando assinatura" para ser tentado de novo.
export async function aplicarAjusteLocal(client, inventario) {
  // Percorre o CATÁLOGO do PDV, não as linhas de inventario_itens.
  //
  // A diferença decide o resultado do inventário: "sem contagem é zerado" tem de valer para
  // todo produto que o PDV deveria ter contado, e não só para os que ganharam linha. Um
  // produto que nunca foi tocado na tela não tem linha nenhuma — percorrendo só as linhas,
  // ele sobreviveria calado, contrariando a regra.
  //
  // O UNION traz também o que o Almoxarifado acrescentou à contagem e que pode não estar
  // mais no catálogo liberado.
  const { rows: itens } = await client.query(
    `WITH catalogo AS (
       SELECT e.sku_produto
       FROM estoque_pdv e
       JOIN produtos p ON p.sku = e.sku_produto
       JOIN produto_categorias prc ON prc.sku_produto = p.sku
       JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
       WHERE e.pdv_id = $2 AND e.permitido = TRUE AND p.ativo = TRUE
       UNION
       SELECT sku_produto FROM inventario_itens WHERE inventario_id = $1
     )
     SELECT it.id, c.sku_produto, it.quantidade_contada,
            COALESCE(e.quantidade, 0) AS saldo_anterior
     FROM catalogo c
     LEFT JOIN inventario_itens it ON it.inventario_id = $1 AND it.sku_produto = c.sku_produto
     LEFT JOIN estoque_pdv e ON e.sku_produto = c.sku_produto AND e.pdv_id = $2
     ORDER BY c.sku_produto`,
    [inventario.id, inventario.pdv_id]
  );

  const aplicados = [];
  for (const item of itens) {
    // Sem contagem = zero. É a regra 2 do cabeçalho; trocar isto muda o resultado do
    // inventário inteiro em silêncio.
    const contado = item.quantidade_contada === null || item.quantidade_contada === undefined
      ? 0
      : Number(item.quantidade_contada);
    const anterior = Number(item.saldo_anterior || 0);

    // Guarda o saldo que existia antes, para a auditoria e para o relatório de divergência.
    //
    // Produto do catálogo que ninguém sequer abriu na tela não tem linha. Ele é zerado do
    // mesmo jeito, então precisa ganhar uma linha aqui — senão o inventário zeraria um
    // produto sem deixar registro de que o zerou.
    if (item.id) {
      await client.query("UPDATE inventario_itens SET quantidade_anterior = $2 WHERE id = $1", [item.id, anterior]);
    } else {
      await client.query(
        `INSERT INTO inventario_itens (inventario_id, sku_produto, quantidade_contada, quantidade_anterior, origem)
         VALUES ($1, $2, NULL, $3, 'PDV')
         ON CONFLICT (inventario_id, sku_produto) DO UPDATE SET quantidade_anterior = EXCLUDED.quantidade_anterior`,
        [inventario.id, item.sku_produto, anterior]
      );
    }

    // Inventário do Almoxarifado (pdv_id nulo) não mexe em estoque_pdv: o saldo dele é o
    // estoque central, que vem da OMIE pela tarefa ESTOQUE_ALMOXARIFADO.
    if (inventario.pdv_id !== null && inventario.pdv_id !== undefined) {
      // SUBSTITUI (regra 1). Um `quantidade + $3` aqui transformaria contagem em entrada.
      //
      // `estoque_pdv` não tem coluna de atualização — quem marca a data é
      // `ultima_sincronizacao`, junto de `sincronizacao_status`, que passa a dizer
      // INVENTARIO para o saldo não ser confundido com o que veio da OMIE.
      await client.query(
        `UPDATE estoque_pdv
         SET quantidade = $3,
             ultima_sincronizacao = CURRENT_TIMESTAMP,
             sincronizacao_status = 'INVENTARIO'
         WHERE pdv_id = $1 AND sku_produto = $2`,
        [inventario.pdv_id, item.sku_produto, contado]
      );
    }

    aplicados.push({
      itemId: item.id,
      sku: item.sku_produto,
      anterior,
      contado,
      diferenca: contado - anterior,
      semContagem: item.quantidade_contada === null || item.quantidade_contada === undefined
    });
  }
  return aplicados;
}

// Coloca os ajustes na fila da OMIE.
//
// Engole o próprio erro de propósito, no mesmo espírito do lançamento da retirada: falhar em
// enfileirar não pode derrubar a transação da assinatura. A contagem já foi assinada e o
// estoque local já foi ajustado — perder a fila é recuperável, perder a assinatura não.
export async function enfileirarAjusteNaOmie(client, { inventario, aplicados, integracao, configuracao }) {
  try {
    const local = await localDoInventario(client, { pdvId: inventario.pdv_id, configuracao });
    if (!local) return { enfileirados: 0, motivo: "PDV sem local de estoque vinculado na integração." };

    let enfileirados = 0;
    for (const item of aplicados) {
      const { criado } = await registrarLancamento(client, {
        integrationId: integracao?.id || null,
        codigoPedido: inventario.codigo_inventario,
        sku: item.sku,
        pdvId: inventario.pdv_id,
        quantidade: item.contado,
        localOrigem: local,
        localDestino: null,
        evento: EVENTO_AJUSTE_INVENTARIO,
        idempotencyKey: chaveAjusteInventario({
          codigoInventario: inventario.codigo_inventario,
          sku: item.sku
        }),
        modo: configuracao?.modo_escrita === "REAL" ? "REAL" : "SIMULACAO"
      });
      if (criado) enfileirados += 1;
    }
    return { enfileirados, local };
  } catch (erro) {
    return { enfileirados: 0, erro: erro.message };
  }
}

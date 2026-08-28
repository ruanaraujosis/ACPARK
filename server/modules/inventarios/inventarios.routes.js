// Rotas de inventário (contagem física de estoque).
//
// Nesta primeira parte, só o lado do PDV: consultar a janela e o inventário aberto, contar,
// salvar parcial e enviar. A partir de "Enviado" o PDV perde a edição — e a trava é do
// servidor, não da tela: chamada direta à rota também é recusada.
import { query, tx, code } from "../../db.js";
import { readBody, send } from "../../utils/http.js";
import { estadoDaJanela } from "../../services/inventarios/janela-contagem.service.js";
import { auditarInventario, ensureInventarioTables, STATUS_ABERTOS, STATUS_INVENTARIO } from "./inventarios.schema.js";

// Produtos que o PDV pode contar: a mesma regra de liberação usada no pedido
// (estoque_pdv x produto_categorias x pdv_categorias). Duplicar essa regra com outro
// critério faria o inventário enxergar um catálogo diferente do que o PDV pede.
// Sem fator de conversão de propósito: a contagem é em unidade, e exibir "fardo c/ 15"
// ao lado do campo só convidaria a digitar fardos.
const SQL_PRODUTOS_DO_PDV = `
  SELECT p.sku, p.nome,
         COALESCE(string_agg(DISTINCT prc.categoria, ', ' ORDER BY prc.categoria), '') AS categoria,
         e.quantidade AS saldo_atual
  FROM estoque_pdv e
  JOIN produtos p ON p.sku = e.sku_produto
  JOIN produto_categorias prc ON prc.sku_produto = p.sku
  JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
  WHERE e.pdv_id = $1 AND e.permitido = TRUE AND p.ativo = TRUE
  GROUP BY p.sku, p.nome, e.quantidade
  ORDER BY p.nome`;

// As duas funções abaixo servem tanto fora de transação (com o query() do projeto, que já
// devolve linhas) quanto dentro dela (com um client do pg, que devolve {rows}). `executar`
// padroniza esse contrato num lugar só: recebe SQL e parâmetros, devolve linhas.
const comClient = (client) => (texto, params) => client.query(texto, params).then((r) => r.rows);

// Inventário aberto do PDV (só pode haver um, garantido por índice único)
async function inventarioAbertoDoPdv(executar, pdvId) {
  const linhas = await executar(
    `SELECT * FROM inventarios
     WHERE COALESCE(pdv_id, -1) = COALESCE($1, -1) AND status = ANY($2)
     ORDER BY id DESC LIMIT 1`,
    [pdvId, STATUS_ABERTOS]
  );
  return linhas[0] || null;
}

// Itens já contados do inventário
async function itensDoInventario(executar, inventarioId) {
  return executar(
    `SELECT id, sku_produto, quantidade_contada, contado_em, origem
     FROM inventario_itens WHERE inventario_id = $1`,
    [inventarioId]
  );
}

// Valida a quantidade contada. O inventário é SEMPRE em unidade — diferente do pedido, que
// oferece embalagem. Contar por embalagem obrigaria a multiplicar por um fator para depois
// conferir contra o saldo real; a contagem física é do que está na prateleira, uma a uma.
//
// Uma unidade de medida diferente de UNIDADE é recusada em vez de ignorada: uma tela
// desatualizada mandando "EMBALAGEM" seria lida como unidade e gravaria 2 onde havia 30.
function quantidadeContadaEmUnidades({ sku, quantidade, unidadeMedida }) {
  if (unidadeMedida && String(unidadeMedida).toUpperCase() !== "UNIDADE") {
    const erro = new Error(`A contagem de inventário é sempre em unidades (produto ${sku}).`);
    erro.statusCode = 400;
    throw erro;
  }
  // Ausente é "não contado" e continua diferente de zero digitado
  if (quantidade === null || quantidade === undefined || quantidade === "") return null;
  const numero = Number(quantidade);
  if (!Number.isFinite(numero) || numero < 0) {
    const erro = new Error(`Quantidade inválida para o produto ${sku}.`);
    erro.statusCode = 400;
    throw erro;
  }
  return numero;
}

export async function handleInventariosRoutes(req, res, context) {
  const { method, requireUser, url, user } = context;
  if (!url.pathname.startsWith("/api/pdv/inventario")) return false;

  await ensureInventarioTables();

  // Estado da tela de contagem do PDV: janela, inventário aberto e produtos liberados
  if (url.pathname === "/api/pdv/inventario" && method === "GET") {
    if (!requireUser(req, res, "pdv")) return true;
    const janela = await estadoDaJanela();
    const produtos = await query(SQL_PRODUTOS_DO_PDV, [user.pdvId]);
    const aberto = await inventarioAbertoDoPdv(query, user.pdvId);
    const itens = aberto ? await itensDoInventario(query, aberto.id) : [];
    send(res, 200, { janela, inventario: aberto, itens, produtos });
    return true;
  }

  // Abre a contagem. Recusa fora da janela e recusa a segunda contagem simultânea.
  if (url.pathname === "/api/pdv/inventario" && method === "POST") {
    if (!requireUser(req, res, "pdv")) return true;
    const janela = await estadoDaJanela();
    if (!janela.liberado) {
      send(res, 423, { error: janela.motivo });
      return true;
    }
    try {
      const criado = await tx(async (client) => {
        const jaAberto = await inventarioAbertoDoPdv(comClient(client), user.pdvId);
        if (jaAberto) return { inventario: jaAberto, reaproveitado: true };
        const inserido = await client.query(
          `INSERT INTO inventarios (codigo_inventario, pdv_id, status, criado_por)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [code("INV"), user.pdvId, STATUS_INVENTARIO.EM_CONTAGEM, user.name || user.username || "PDV"]
        );
        const inventario = inserido.rows[0];
        await auditarInventario(client, {
          inventarioId: inventario.id,
          codigoInventario: inventario.codigo_inventario,
          acao: "inventario_aberto",
          usuario: inventario.criado_por,
          dados: { origem: "pdv", pdv_id: user.pdvId }
        });
        return { inventario, reaproveitado: false };
      });
      send(res, 200, criado);
    } catch (error) {
      // O índice único é a última linha de defesa contra duas abas abrindo ao mesmo tempo
      if (error.code === "23505") {
        send(res, 409, { error: "Este PDV já tem uma contagem aberta." });
        return true;
      }
      throw error;
    }
    return true;
  }

  // Salvamento parcial da contagem. Só vale enquanto "Em contagem".
  if (url.pathname === "/api/pdv/inventario" && method === "PATCH") {
    if (!requireUser(req, res, "pdv")) return true;
    const corpo = await readBody(req);
    const itens = Array.isArray(corpo?.itens) ? corpo.itens : [];
    if (!itens.length) {
      send(res, 400, { error: "Nenhuma contagem foi enviada." });
      return true;
    }

    const janela = await estadoDaJanela();
    if (!janela.liberado) {
      send(res, 423, { error: janela.motivo });
      return true;
    }

    try {
      const resultado = await tx(async (client) => {
        const inventario = await travarInventarioDoPdv(client, corpo?.codigo_inventario, user.pdvId);
        exigirEmContagem(inventario);

        let gravados = 0;
        for (const item of itens) {
          const sku = String(item?.sku || "").trim();
          if (!sku) continue;
          const unidades = quantidadeContadaEmUnidades({
            sku,
            quantidade: item?.quantidade,
            unidadeMedida: item?.unidade_medida
          });

          // A data da contagem é do servidor e só existe quando há número: apagar a
          // quantidade também apaga o carimbo, senão sobraria data de uma contagem desfeita.
          await client.query(
            `INSERT INTO inventario_itens (inventario_id, sku_produto, quantidade_contada, contado_em, origem)
             VALUES ($1, $2, $3, CASE WHEN $3::numeric IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, 'PDV')
             ON CONFLICT (inventario_id, sku_produto) DO UPDATE
               SET quantidade_contada = EXCLUDED.quantidade_contada,
                   contado_em = EXCLUDED.contado_em,
                   atualizado_em = CURRENT_TIMESTAMP`,
            [inventario.id, sku, unidades]
          );
          gravados += 1;
        }

        await client.query("UPDATE inventarios SET atualizado_em = CURRENT_TIMESTAMP WHERE id = $1", [inventario.id]);
        return { gravados, codigo_inventario: inventario.codigo_inventario };
      });
      send(res, 200, resultado);
    } catch (error) {
      if (error.statusCode) {
        send(res, error.statusCode, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  // Envia a contagem: a partir daqui o PDV não edita mais
  if (url.pathname === "/api/pdv/inventario/enviar" && method === "POST") {
    if (!requireUser(req, res, "pdv")) return true;
    const corpo = await readBody(req);
    try {
      const resultado = await tx(async (client) => {
        const inventario = await travarInventarioDoPdv(client, corpo?.codigo_inventario, user.pdvId);
        exigirEmContagem(inventario);

        const resumo = await resumoDaContagem(client, inventario.id, user.pdvId);
        if (!resumo.contados) {
          const erro = new Error("Conte ao menos um produto antes de enviar.");
          erro.statusCode = 400;
          throw erro;
        }

        const usuario = user.name || user.username || "PDV";
        await client.query(
          `UPDATE inventarios SET status = $2, enviado_em = CURRENT_TIMESTAMP, enviado_por = $3,
                                  atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [inventario.id, STATUS_INVENTARIO.ENVIADO, usuario]
        );
        await auditarInventario(client, {
          inventarioId: inventario.id,
          codigoInventario: inventario.codigo_inventario,
          acao: "inventario_enviado",
          usuario,
          valorAnterior: STATUS_INVENTARIO.EM_CONTAGEM,
          valorNovo: STATUS_INVENTARIO.ENVIADO,
          dados: { origem: "pdv", ...resumo }
        });
        return { codigo_inventario: inventario.codigo_inventario, ...resumo };
      });
      send(res, 200, resultado);
    } catch (error) {
      if (error.statusCode) {
        send(res, error.statusCode, { error: error.message });
        return true;
      }
      throw error;
    }
    return true;
  }

  return false;
}

// Trava a linha do inventário e confirma que é do PDV que está chamando.
// FOR UPDATE porque duas abas do mesmo PDV podem salvar e enviar ao mesmo tempo.
async function travarInventarioDoPdv(client, codigo, pdvId) {
  const alvo = await client.query(
    `SELECT * FROM inventarios
     WHERE ($1::text IS NULL OR codigo_inventario = $1)
       AND COALESCE(pdv_id, -1) = COALESCE($2, -1)
       AND status = ANY($3)
     ORDER BY id DESC LIMIT 1
     FOR UPDATE`,
    [codigo || null, pdvId, STATUS_ABERTOS]
  );
  const inventario = alvo.rows[0];
  if (!inventario) {
    const erro = new Error("Nenhuma contagem aberta foi encontrada para este PDV.");
    erro.statusCode = 404;
    throw erro;
  }
  return inventario;
}

// A partir de "Enviado" o Almoxarifado assumiu a contagem; o PDV não mexe mais.
function exigirEmContagem(inventario) {
  if (inventario.status !== STATUS_INVENTARIO.EM_CONTAGEM) {
    const erro = new Error("Esta contagem já foi enviada e não pode mais ser alterada pelo PDV.");
    erro.statusCode = 409;
    throw erro;
  }
}

// Quantos produtos foram contados e quantos ficaram sem contagem.
// "Sem contagem" é o que o PDV podia contar e não contou — por isso conta o catálogo
// liberado, e não só as linhas já gravadas em inventario_itens.
async function resumoDaContagem(client, inventarioId, pdvId) {
  const liberados = await client.query(
    `SELECT COUNT(DISTINCT p.sku)::int AS n
     FROM estoque_pdv e
     JOIN produtos p ON p.sku = e.sku_produto
     JOIN produto_categorias prc ON prc.sku_produto = p.sku
     JOIN pdv_categorias pc ON pc.pdv_id = e.pdv_id AND pc.categoria = prc.categoria
     WHERE e.pdv_id = $1 AND e.permitido = TRUE AND p.ativo = TRUE`,
    [pdvId]
  );
  const contados = await client.query(
    "SELECT COUNT(*)::int AS n FROM inventario_itens WHERE inventario_id = $1 AND quantidade_contada IS NOT NULL",
    [inventarioId]
  );
  const total = liberados.rows[0].n;
  const jaContados = contados.rows[0].n;
  return { total, contados: jaContados, sem_contagem: Math.max(total - jaContados, 0) };
}

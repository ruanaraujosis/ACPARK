// Rotas de inventário (contagem física de estoque).
//
// Lado do PDV: consultar a janela e o inventário aberto, contar, salvar parcial e enviar.
// A partir de "Enviado" o PDV perde a edição — e a trava é do servidor, não da tela:
// chamada direta à rota também é recusada.
//
// Lado do Almoxarifado (rotasDoAlmoxarifado, no fim do arquivo): enxerga todos os
// inventários, corrige quantidade, adiciona/remove produto, exclui a contagem com
// justificativa, controla a janela e confirma — o que pede a assinatura do PDV.
import { query, tx, code, asInt } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { estadoDaJanela, formatarDataBr } from "../../services/inventarios/janela-contagem.service.js";
import { publishOrderAlert } from "../../services/order-alerts/order-alerts.events.js";
import { handleEventosDoPdv, publicarEventoDoPdv } from "../../services/inventarios/inventario.events.js";
import { aplicarAjusteLocal, enfileirarAjusteNaOmie } from "../../services/inventarios/ajuste-inventario.service.js";
import { auditarInventario, CHAVE_AGENDAMENTO, CHAVE_BLOQUEIO, ensureInventarioTables, STATUS_ABERTOS, STATUS_INVENTARIO } from "./inventarios.schema.js";

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
  const doPdv = url.pathname.startsWith("/api/pdv/inventario");
  const doAdmin = url.pathname.startsWith("/api/admin/inventario");
  const deAvisos = url.pathname === "/api/avisos" || url.pathname === "/api/admin/avisos";
  if (!doPdv && !doAdmin && !deAvisos) return false;

  await ensureInventarioTables();

  if (deAvisos) return rotasDeAvisos(req, res, context);

  if (doAdmin) return rotasDoAlmoxarifado(req, res, context);

  // Canal de tempo real do PDV. Escopado por PDV de proposito: o canal de alertas de pedido
  // e do Almoxarifado e transmite tudo para todos -- abri-lo aqui entregaria a cada ponto de
  // venda as contagens dos outros.
  if (url.pathname === "/api/pdv/inventario/eventos") {
    if (!requireUser(req, res, "pdv")) return true;
    handleEventosDoPdv(req, res, user.pdvId);
    return true;
  }

  if (url.pathname.startsWith("/api/pdv/inventario/assinatura")) {
    return rotaAssinaturaDoPdv(req, res, context);
  }

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

// ===== Aba INVENTÁRIOS do Almoxarifado =====
//
// O Almoxarifado enxerga todos os inventários, corrige o que o PDV contou, adiciona ou
// remove produto e pode excluir a contagem inteira. Cada alteração guarda valor anterior e
// valor novo — sem isso não há como saber depois se um número veio da contagem ou de uma
// correção feita aqui.

// Quantos dias a contagem pode ter antes de virar risco.
//
// Entre a contagem e o lançamento na OMIE o PDV continua vendendo, e o sistema de vendas dá
// baixa no mesmo local. Quanto mais velha a contagem, maior a diferença que o ajuste vai
// apagar. Não bloqueia — avisa, porque quem decide é o Almoxarifado.
const DIAS_CONTAGEM_ANTIGA = 2;

// Lista de inventários com os totais já calculados, para a tela não somar linha a linha
const SQL_LISTA_INVENTARIOS = `
  SELECT i.id, i.codigo_inventario, i.pdv_id, i.status,
         COALESCE(p.nome, 'Almoxarifado') AS pdv_nome,
         i.criado_por, i.criado_em, i.enviado_por, i.enviado_em,
         i.confirmado_por, i.confirmado_em, i.assinado_por, i.assinado_em,
         COUNT(it.id) FILTER (WHERE it.quantidade_contada IS NOT NULL)::int AS contados,
         COUNT(it.id)::int AS itens,
         MIN(it.contado_em) AS contagem_mais_antiga
  FROM inventarios i
  LEFT JOIN pdvs p ON p.id = i.pdv_id
  LEFT JOIN inventario_itens it ON it.inventario_id = i.id
  WHERE ($1::text IS NULL OR i.status = $1)
    AND ($2::int IS NULL OR i.pdv_id = $2)
  GROUP BY i.id, p.nome
  ORDER BY i.criado_em DESC
  LIMIT 200`;

// Itens do inventário com o saldo atual ao lado, para o Almoxarifado ver a divergência
const SQL_ITENS_DETALHE = `
  SELECT it.id, it.sku_produto, it.quantidade_contada, it.contado_em, it.origem,
         pr.nome AS produto,
         COALESCE(e.quantidade, 0) AS saldo_atual
  FROM inventario_itens it
  LEFT JOIN produtos pr ON pr.sku = it.sku_produto
  LEFT JOIN estoque_pdv e ON e.sku_produto = it.sku_produto AND e.pdv_id = $2
  WHERE it.inventario_id = $1
  ORDER BY pr.nome NULLS LAST, it.sku_produto`;

// Há quantos dias a contagem mais antiga foi feita
function idadeEmDias(data) {
  if (!data) return null;
  const ms = Date.now() - new Date(data).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

// Trava o inventário pelo código e devolve a linha. Sem filtro de PDV: o Almoxarifado
// enxerga todos.
async function travarInventario(client, codigo) {
  const alvo = await client.query(
    "SELECT * FROM inventarios WHERE codigo_inventario = $1 FOR UPDATE",
    [String(codigo || "")]
  );
  const inventario = alvo.rows[0];
  if (!inventario) {
    const erro = new Error("Inventário não encontrado.");
    erro.statusCode = 404;
    throw erro;
  }
  return inventario;
}

// O Almoxarifado edita a partir de "Enviado". Antes disso o PDV ainda está contando, e
// mexer por baixo faria a tela dele perder o que digitou. Depois de confirmado, a contagem
// está esperando assinatura ou já virou ajuste — corrigir aí é abrir novo inventário.
function exigirEditavelPeloAlmoxarifado(inventario) {
  if (inventario.status !== STATUS_INVENTARIO.ENVIADO) {
    const erro = new Error(
      inventario.status === STATUS_INVENTARIO.EM_CONTAGEM
        ? "O PDV ainda está contando. Aguarde o envio para editar."
        : "Esta contagem já foi confirmada. Para corrigir, abra um novo inventário."
    );
    erro.statusCode = 409;
    throw erro;
  }
}

async function rotasDoAlmoxarifado(req, res, context) {
  const { method, requireUser, url, user } = context;
  const usuario = user?.name || "Almoxarifado";

  // O inventario do proprio Almoxarifado tem fluxo curto (conta e assina de uma vez)
  if (url.pathname.startsWith("/api/admin/inventario/proprio")) {
    return rotasInventarioDoAlmoxarifado(req, res, context);
  }

  // Janela de contagem: estado atual + agendamento
  if (url.pathname === "/api/admin/inventario/janela") {
    if (!requireUser(req, res, "admin")) return true;

    if (method === "GET") {
      send(res, 200, await estadoDaJanela());
      return true;
    }

    if (method === "PUT") {
      const corpo = await readBody(req);
      const anterior = await estadoDaJanela();

      // Só grava o que veio: mexer no alternador não pode apagar o agendamento sem querer
      if (corpo?.bloqueado !== undefined) {
        await query(
          `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
           ON CONFLICT (chave) DO UPDATE SET valor = $2`,
          [CHAVE_BLOQUEIO, corpo.bloqueado ? "true" : "false"]
        );
      }
      if (corpo?.agendado_para !== undefined) {
        const data = String(corpo.agendado_para || "").slice(0, 10);
        if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
          send(res, 400, { error: "Data de agendamento inválida." });
          return true;
        }
        await query(
          `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
           ON CONFLICT (chave) DO UPDATE SET valor = $2`,
          [CHAVE_AGENDAMENTO, data]
        );
        // Agendar avisa os PDVs. Limpar a data desliga o aviso, em vez de deixar na tela
        // deles um inventario marcado que nao existe mais.
        await tx((client) => registrarAvisoDeAgendamento(client, { data, usuario }));
      }

      const atual = await estadoDaJanela();
      await tx((client) =>
        auditarInventario(client, {
          acao: "janela_alterada",
          usuario,
          valorAnterior: `bloqueio=${anterior.bloqueioManual} agendamento=${anterior.dataAgendada || "-"}`,
          valorNovo: `bloqueio=${atual.bloqueioManual} agendamento=${atual.dataAgendada || "-"}`,
          dados: { origem: "admin" }
        })
      );
      send(res, 200, atual);
      return true;
    }
  }

  // Lista de inventários de todos os PDVs
  if (url.pathname === "/api/admin/inventarios" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const status = url.searchParams.get("status") || null;
    const pdvId = asInt(url.searchParams.get("pdvId")) || null;
    const linhas = await query(SQL_LISTA_INVENTARIOS, [status, pdvId]);
    send(res, 200, {
      inventarios: linhas.map((linha) => ({
        ...linha,
        dias_desde_contagem: idadeEmDias(linha.contagem_mais_antiga),
        contagem_antiga: idadeEmDias(linha.contagem_mais_antiga) >= DIAS_CONTAGEM_ANTIGA
      })),
      janela: await estadoDaJanela()
    });
    return true;
  }

  // Relatório consolidado de estoque: "quanto tem em cada PDV" numa data de corte.
  //
  // Cada PDV confirma o próprio inventário numa data diferente, e o Almoxarifado o dele --
  // não existe UM inventário só que responda "quanto tem em todo lugar". A saída é combinar,
  // para cada PDV e para o Almoxarifado, o inventário Confirmado mais recente até a data de
  // corte escolhida. Read-only: nenhum ajuste é reprocessado, só leitura do que já foi
  // aplicado (ajuste_aplicado_em é o timestamp certo -- confirmado_em, para inventário de PDV,
  // marca só a revisão do Almoxarifado, antes de o PDV assinar e o ajuste entrar de fato).
  if (url.pathname === "/api/admin/inventario/relatorio" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const corte = String(url.searchParams.get("corte") || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(corte)) {
      send(res, 400, { error: "Informe uma data de corte válida (AAAA-MM-DD)." });
      return true;
    }

    // PDVs administrativos ficam fora das colunas: não vendem, então não têm saldo de
    // revenda -- não faz sentido uma coluna de estoque para eles neste relatório.
    const pdvs = await query("SELECT id, nome FROM pdvs WHERE administrativo = FALSE ORDER BY nome");

    // Um vencedor por local (pdv_id ou NULL = Almoxarifado). DISTINCT ON trata NULL como um
    // grupo só, igual a qualquer outro pdv_id -- o Almoxarifado entra na mesma consulta.
    const vencedores = await query(
      `SELECT DISTINCT ON (pdv_id) id, pdv_id, codigo_inventario, ajuste_aplicado_em
       FROM inventarios
       WHERE status = $1 AND ajuste_aplicado_em < ($2::date + INTERVAL '1 day')
       ORDER BY pdv_id, ajuste_aplicado_em DESC`,
      [STATUS_INVENTARIO.CONFIRMADO, corte]
    );
    const pdvIdPorInventario = new Map(vencedores.map((v) => [v.id, v.pdv_id]));

    const itensContados = vencedores.length
      ? await query(
          `SELECT inventario_id, sku_produto, quantidade_contada
           FROM inventario_itens
           WHERE inventario_id = ANY($1) AND quantidade_contada IS NOT NULL`,
          [vencedores.map((v) => v.id)]
        )
      : [];

    // Local: "ALMOX" ou o id do PDV -- chave única para separar quem contou o quê
    const CHAVE_ALMOX = "ALMOX";
    const chaveDoLocal = (pdvId) => (pdvId === null ? CHAVE_ALMOX : String(pdvId));
    const contadoPorLocal = new Map(vencedores.map((v) => [chaveDoLocal(v.pdv_id), new Map()]));
    for (const item of itensContados) {
      const pdvId = pdvIdPorInventario.get(item.inventario_id);
      contadoPorLocal.get(chaveDoLocal(pdvId)).set(item.sku_produto, Number(item.quantidade_contada));
    }

    // Saldo atual, para preservar quem não contou nesta rodada (mesma regra já usada no
    // ajuste: ausência de contagem mantém o valor, nunca zera).
    const saldosPdv = await query("SELECT pdv_id, sku_produto, quantidade FROM estoque_pdv");
    const saldoPdvPorChave = new Map(saldosPdv.map((s) => [`${s.pdv_id}|${s.sku_produto}`, Number(s.quantidade)]));

    const produtos = await query(
      // Por categoria primeiro, depois nome: o relatório agrupa visualmente por categoria, e
      // isso só funciona se as linhas da mesma categoria já vierem consecutivas.
      "SELECT sku, nome, categoria, qtd_total FROM produtos WHERE ativo = TRUE ORDER BY categoria, nome"
    );

    // Critério de inclusão: a linha só aparece se pelo menos um local (PDV ou Almoxarifado)
    // contou o produto na respectiva contagem vencedora -- catálogo inteiro sem ninguém ter
    // tocado no produto não vira linha de relatório.
    const skusContados = new Set();
    for (const mapa of contadoPorLocal.values()) for (const sku of mapa.keys()) skusContados.add(sku);

    const linhas = [];
    for (const produto of produtos) {
      if (!skusContados.has(produto.sku)) continue;
      const porPdv = {};
      let total = 0;
      for (const pdv of pdvs) {
        const contado = contadoPorLocal.get(String(pdv.id))?.get(produto.sku);
        const valor = contado !== undefined ? contado : (saldoPdvPorChave.get(`${pdv.id}|${produto.sku}`) ?? 0);
        porPdv[pdv.id] = valor;
        total += valor;
      }
      const contadoAlmox = contadoPorLocal.get(CHAVE_ALMOX)?.get(produto.sku);
      const almoxarifado = contadoAlmox !== undefined ? contadoAlmox : Number(produto.qtd_total || 0);
      total += almoxarifado;

      linhas.push({
        sku: produto.sku,
        nome: produto.nome,
        categoria: produto.categoria || "Sem categoria",
        pdvs: porPdv,
        almoxarifado,
        total
      });
    }

    send(res, 200, {
      corte,
      geradoEm: new Date().toISOString(),
      pdvs,
      vencedores: vencedores.map((v) => ({
        pdv_id: v.pdv_id,
        codigo_inventario: v.codigo_inventario,
        ajuste_aplicado_em: v.ajuste_aplicado_em
      })),
      linhas
    });
    return true;
  }

  // Detalhe de um inventário, com saldo atual ao lado de cada contagem
  if (url.pathname === "/api/admin/inventario" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const codigo = url.searchParams.get("codigo");
    const linhas = await query("SELECT * FROM inventarios WHERE codigo_inventario = $1", [codigo]);
    const inventario = linhas[0];
    if (!inventario) {
      send(res, 404, { error: "Inventário não encontrado." });
      return true;
    }
    const itens = await query(SQL_ITENS_DETALHE, [inventario.id, inventario.pdv_id]);
    const historico = await query(
      `SELECT acao, usuario, valor_anterior, valor_novo, sku_produto, observacao, criado_em
       FROM inventario_auditoria WHERE inventario_id = $1 ORDER BY criado_em DESC, id DESC`,
      [inventario.id]
    );
    const maisAntiga = itens.reduce((menor, item) => {
      if (!item.contado_em) return menor;
      return !menor || new Date(item.contado_em) < new Date(menor) ? item.contado_em : menor;
    }, null);
    send(res, 200, {
      inventario,
      itens,
      historico,
      dias_desde_contagem: idadeEmDias(maisAntiga),
      contagem_antiga: idadeEmDias(maisAntiga) >= DIAS_CONTAGEM_ANTIGA,
      // O aviso da simulacao vem do historico, nao do modo atual da integracao: o que importa
      // e como estava QUANDO o ajuste foi aplicado. Ligar a integracao para REAL depois nao
      // desfaz a sobrescrita que ja aconteceu.
      ajustado_em_simulacao: historico.some((linha) => linha.acao === "ajuste_em_simulacao")
    });
    return true;
  }

  // Edita quantidade, adiciona produto ou remove item — tudo auditado
  if (url.pathname === "/api/admin/inventario/itens" && method === "PATCH") {
    if (!requireUser(req, res, "admin")) return true;
    const corpo = await readBody(req);
    try {
      const resultado = await tx(async (client) => {
        const inventario = await travarInventario(client, corpo?.codigo_inventario);
        exigirEditavelPeloAlmoxarifado(inventario);

        let editados = 0;
        let removidos = 0;
        let adicionados = 0;

        // Alterações e remoções de itens já existentes
        for (const item of Array.isArray(corpo?.itens) ? corpo.itens : []) {
          const atual = await client.query(
            "SELECT * FROM inventario_itens WHERE id = $1 AND inventario_id = $2 FOR UPDATE",
            [asInt(item?.id), inventario.id]
          );
          const linha = atual.rows[0];
          if (!linha) continue;

          if (item?.remover) {
            await client.query("DELETE FROM inventario_itens WHERE id = $1", [linha.id]);
            await auditarInventario(client, {
              inventarioId: inventario.id,
              codigoInventario: inventario.codigo_inventario,
              itemId: linha.id,
              sku: linha.sku_produto,
              acao: "item_removido",
              usuario,
              valorAnterior: linha.quantidade_contada,
              valorNovo: null,
              observacao: item?.motivo || null,
              dados: { origem: "admin" }
            });
            removidos += 1;
            continue;
          }

          const nova = quantidadeContadaEmUnidades({
            sku: linha.sku_produto,
            quantidade: item?.quantidade,
            unidadeMedida: item?.unidade_medida
          });
          // Números iguais não viram registro de auditoria: poluiria a trilha sem informar nada
          const igual = String(linha.quantidade_contada ?? "") === String(nova ?? "");
          if (igual) continue;

          await client.query(
            `UPDATE inventario_itens
             SET quantidade_contada = $2,
                 contado_em = CASE WHEN $2::numeric IS NULL THEN NULL ELSE COALESCE(contado_em, CURRENT_TIMESTAMP) END,
                 atualizado_em = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [linha.id, nova]
          );
          await auditarInventario(client, {
            inventarioId: inventario.id,
            codigoInventario: inventario.codigo_inventario,
            itemId: linha.id,
            sku: linha.sku_produto,
            acao: "quantidade_corrigida",
            usuario,
            valorAnterior: linha.quantidade_contada,
            valorNovo: nova,
            observacao: item?.motivo || null,
            dados: { origem: "admin" }
          });
          editados += 1;
        }

        // Produtos que o Almoxarifado acrescentou à contagem
        for (const novo of Array.isArray(corpo?.adicionar) ? corpo.adicionar : []) {
          const sku = String(novo?.sku || "").trim();
          if (!sku) continue;
          const existe = await client.query("SELECT 1 FROM produtos WHERE sku = $1", [sku]);
          if (!existe.rowCount) {
            const erro = new Error(`Produto ${sku} não existe no cadastro.`);
            erro.statusCode = 400;
            throw erro;
          }
          const quantidade = quantidadeContadaEmUnidades({
            sku,
            quantidade: novo?.quantidade,
            unidadeMedida: novo?.unidade_medida
          });
          const inserido = await client.query(
            `INSERT INTO inventario_itens (inventario_id, sku_produto, quantidade_contada, contado_em, origem)
             VALUES ($1, $2, $3, CASE WHEN $3::numeric IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, 'ALMOX')
             ON CONFLICT (inventario_id, sku_produto) DO UPDATE
               SET quantidade_contada = EXCLUDED.quantidade_contada,
                   contado_em = EXCLUDED.contado_em,
                   atualizado_em = CURRENT_TIMESTAMP
             RETURNING id`,
            [inventario.id, sku, quantidade]
          );
          await auditarInventario(client, {
            inventarioId: inventario.id,
            codigoInventario: inventario.codigo_inventario,
            itemId: inserido.rows[0].id,
            sku,
            acao: "item_adicionado",
            usuario,
            valorAnterior: null,
            valorNovo: quantidade,
            observacao: novo?.motivo || null,
            dados: { origem: "admin" }
          });
          adicionados += 1;
        }

        await client.query("UPDATE inventarios SET atualizado_em = CURRENT_TIMESTAMP WHERE id = $1", [inventario.id]);
        return { editados, removidos, adicionados };
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

  // Exclui o inventário inteiro. Exige justificativa, no mesmo rigor da exclusão de pedido.
  if (url.pathname === "/api/admin/inventario" && method === "DELETE") {
    if (!requireUser(req, res, "admin")) return true;
    const corpo = await readBody(req);
    const motivo = normalizeText(corpo?.motivo, 300);
    if (!motivo) {
      send(res, 400, { error: "Informe o motivo da exclusão do inventário." });
      return true;
    }
    try {
      const resultado = await tx(async (client) => {
        const inventario = await travarInventario(client, corpo?.codigo_inventario);
        if (inventario.status === STATUS_INVENTARIO.CONFIRMADO) {
          const erro = new Error("Inventário confirmado não pode ser excluído: o ajuste já foi aplicado.");
          erro.statusCode = 409;
          throw erro;
        }
        const contagem = await client.query(
          "SELECT COUNT(*)::int AS n FROM inventario_itens WHERE inventario_id = $1 AND quantidade_contada IS NOT NULL",
          [inventario.id]
        );
        // A auditoria guarda o código, não só o id: a trilha precisa sobreviver à exclusão
        await auditarInventario(client, {
          inventarioId: null,
          codigoInventario: inventario.codigo_inventario,
          acao: "inventario_excluido",
          usuario,
          valorAnterior: inventario.status,
          valorNovo: null,
          observacao: motivo,
          dados: { origem: "admin", pdv_id: inventario.pdv_id, contados: contagem.rows[0].n }
        });
        await client.query("DELETE FROM inventarios WHERE id = $1", [inventario.id]);
        return { codigo_inventario: inventario.codigo_inventario, contados: contagem.rows[0].n };
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

  // CONFIRMAR: valida a contagem e passa a pedir a assinatura do PDV.
  // Não ajusta estoque nenhum ainda — o ajuste só acontece depois que o PDV assina.
  if (url.pathname === "/api/admin/inventario/confirmar" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const corpo = await readBody(req);
    try {
      const resultado = await tx(async (client) => {
        const inventario = await travarInventario(client, corpo?.codigo_inventario);
        if (inventario.status !== STATUS_INVENTARIO.ENVIADO) {
          const erro = new Error(`Só é possível confirmar uma contagem enviada (esta está em "${inventario.status}").`);
          erro.statusCode = 409;
          throw erro;
        }
        const contagem = await client.query(
          `SELECT COUNT(*) FILTER (WHERE quantidade_contada IS NOT NULL)::int AS contados,
                  MIN(contado_em) AS mais_antiga
           FROM inventario_itens WHERE inventario_id = $1`,
          [inventario.id]
        );
        const { contados, mais_antiga: maisAntiga } = contagem.rows[0];
        if (!contados) {
          const erro = new Error("Esta contagem não tem nenhum produto contado.");
          erro.statusCode = 400;
          throw erro;
        }

        await client.query(
          `UPDATE inventarios SET status = $2, confirmado_em = CURRENT_TIMESTAMP, confirmado_por = $3,
                                  atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [inventario.id, STATUS_INVENTARIO.AGUARDANDO_ASSINATURA, usuario]
        );
        await auditarInventario(client, {
          inventarioId: inventario.id,
          codigoInventario: inventario.codigo_inventario,
          acao: "inventario_confirmado",
          usuario,
          valorAnterior: STATUS_INVENTARIO.ENVIADO,
          valorNovo: STATUS_INVENTARIO.AGUARDANDO_ASSINATURA,
          dados: { origem: "admin", contados, dias_desde_contagem: idadeEmDias(maisAntiga) }
        });
        return {
          codigo_inventario: inventario.codigo_inventario,
          pdv_id: inventario.pdv_id,
          contados,
          dias_desde_contagem: idadeEmDias(maisAntiga)
        };
      });

      // O Almoxarifado vê a mudança no canal dele; o polling segue como plano B.
      publishOrderAlert("INVENTARIO_STATUS_CHANGED", {
        codigoInventario: resultado.codigo_inventario,
        pdvId: resultado.pdv_id,
        status: STATUS_INVENTARIO.AGUARDANDO_ASSINATURA,
        usuario
      });
      // E o PDV dono da contagem é chamado para assinar, pelo canal só dele
      publicarEventoDoPdv("INVENTARIO_ASSINATURA_SOLICITADA", resultado.pdv_id, {
        codigoInventario: resultado.codigo_inventario,
        contados: resultado.contados
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

// ===== Assinatura do PDV e aplicação do ajuste =====

// Assinatura vem como data URL de PNG desenhada no canvas. A validação é a mesma da retirada
// de pedido: prefixo de PNG e tamanho com teto, para o campo não virar porta de upload.
const PREFIXO_PNG = "data:image/png;base64,";
const LIMITE_ASSINATURA = 400 * 1024;

// Recusa qualquer coisa que não seja um PNG plausível
export function validarAssinatura(valor) {
  const texto = String(valor || "").trim();
  if (!texto.startsWith(PREFIXO_PNG)) {
    const erro = new Error("Assinatura inválida. Assine no quadro antes de confirmar.");
    erro.statusCode = 400;
    throw erro;
  }
  if (texto.length > LIMITE_ASSINATURA) {
    const erro = new Error("Assinatura muito grande. Refaça a assinatura.");
    erro.statusCode = 413;
    throw erro;
  }
  // Um PNG de canvas em branco ainda é um PNG; o teto de baixo pega assinatura vazia demais
  if (texto.length < PREFIXO_PNG.length + 200) {
    const erro = new Error("Assinatura em branco. Assine no quadro antes de confirmar.");
    erro.statusCode = 400;
    throw erro;
  }
  return texto;
}

// Integração ativa e sua configuração, para o lançamento saber local e modo de escrita.
// Ausência não é erro: sem integração o ajuste local acontece do mesmo jeito.
async function integracaoAtiva(client) {
  const { rows } = await client.query(
    `SELECT id, configuracao FROM integrations
     WHERE ativo = TRUE ORDER BY id LIMIT 1`
  );
  if (!rows[0]) return { integracao: null, configuracao: {} };
  const bruta = rows[0].configuracao;
  const configuracao = typeof bruta === "string" ? JSON.parse(bruta || "{}") : bruta || {};
  return { integracao: rows[0], configuracao };
}

// Rotas de assinatura, montadas em handleInventariosRoutes
async function rotaAssinaturaDoPdv(req, res, context) {
  const { method, requireUser, url, user } = context;

  // O que o PDV precisa assinar: só existe quando o Almoxarifado já confirmou
  if (url.pathname === "/api/pdv/inventario/assinatura" && method === "GET") {
    if (!requireUser(req, res, "pdv")) return true;
    const linhas = await query(
      `SELECT * FROM inventarios
       WHERE pdv_id = $1 AND status = $2 ORDER BY id DESC LIMIT 1`,
      [user.pdvId, STATUS_INVENTARIO.AGUARDANDO_ASSINATURA]
    );
    const inventario = linhas[0] || null;
    if (!inventario) {
      send(res, 200, { inventario: null, itens: [] });
      return true;
    }
    // O PDV assina vendo o que vai mudar: contado, saldo atual e a diferença
    const itens = await query(
      `SELECT it.sku_produto, it.quantidade_contada, it.contado_em,
              pr.nome AS produto, COALESCE(e.quantidade, 0) AS saldo_atual
       FROM inventario_itens it
       LEFT JOIN produtos pr ON pr.sku = it.sku_produto
       LEFT JOIN estoque_pdv e ON e.sku_produto = it.sku_produto AND e.pdv_id = $2
       WHERE it.inventario_id = $1
       ORDER BY pr.nome NULLS LAST, it.sku_produto`,
      [inventario.id, inventario.pdv_id]
    );
    send(res, 200, { inventario, itens });
    return true;
  }

  // Assinar: aplica o ajuste no estoque local e enfileira o lançamento na OMIE
  if (url.pathname === "/api/pdv/inventario/assinatura" && method === "POST") {
    if (!requireUser(req, res, "pdv")) return true;
    const corpo = await readBody(req);
    try {
      const resultado = await tx(async (client) => {
        const alvo = await client.query(
          `SELECT * FROM inventarios
           WHERE codigo_inventario = $1 AND pdv_id = $2
           FOR UPDATE`,
          [String(corpo?.codigo_inventario || ""), user.pdvId]
        );
        const inventario = alvo.rows[0];
        if (!inventario) {
          const erro = new Error("Inventário não encontrado para este PDV.");
          erro.statusCode = 404;
          throw erro;
        }
        // Assinar duas vezes não pode ajustar duas vezes: só "Aguardando assinatura" passa
        if (inventario.status !== STATUS_INVENTARIO.AGUARDANDO_ASSINATURA) {
          const erro = new Error(
            inventario.status === STATUS_INVENTARIO.CONFIRMADO
              ? "Este inventário já foi assinado."
              : "Este inventário ainda não foi confirmado pelo Almoxarifado."
          );
          erro.statusCode = 409;
          throw erro;
        }

        const assinatura = validarAssinatura(corpo?.assinatura);
        const assinadoPor = normalizeText(corpo?.assinado_por, 120) || user.name || "PDV";

        // Ajuste local primeiro: é ele que não pode falhar pela metade
        const aplicados = await aplicarAjusteLocal(client, inventario);

        await client.query(
          `UPDATE inventarios
           SET status = $2, assinatura_imagem = $3, assinado_por = $4,
               assinado_em = CURRENT_TIMESTAMP, ajuste_aplicado_em = CURRENT_TIMESTAMP,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [inventario.id, STATUS_INVENTARIO.CONFIRMADO, assinatura, assinadoPor]
        );

        const preservados = aplicados.preservados || [];
        await auditarInventario(client, {
          inventarioId: inventario.id,
          codigoInventario: inventario.codigo_inventario,
          acao: "inventario_assinado",
          usuario: assinadoPor,
          valorAnterior: STATUS_INVENTARIO.AGUARDANDO_ASSINATURA,
          valorNovo: STATUS_INVENTARIO.CONFIRMADO,
          dados: {
            origem: "pdv",
            itens: aplicados.length,
            // Produto sem contagem nao entra no ajuste, mas fica registrado que foi visto e
            // preservado -- senao a trilha nao distingue "pulado de proposito" de "esquecido"
            preservados_sem_contagem: preservados.length,
            preservados: preservados.slice(0, 50),
            ajustes: aplicados.map((i) => ({ sku: i.sku, de: i.anterior, para: i.contado }))
          }
        });

        // A OMIE nunca bloqueia a assinatura: enfileira e drena quando houver internet
        const { integracao, configuracao } = await integracaoAtiva(client);
        const fila = await enfileirarAjusteNaOmie(client, { inventario, aplicados, integracao, configuracao });

        return {
          codigo_inventario: inventario.codigo_inventario,
          itens: aplicados.length,
          preservados: preservados.length,
          fila
        };
      });

      publishOrderAlert("INVENTARIO_STATUS_CHANGED", {
        codigoInventario: resultado.codigo_inventario,
        pdvId: user.pdvId,
        status: STATUS_INVENTARIO.CONFIRMADO,
        usuario: user.name || "PDV"
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

// ===== Inventário do próprio Almoxarifado =====
//
// Sem segunda parte para assinar: o Almoxarifado cria, conta e confirma com a propria
// assinatura, num passo so. Por isso nao passa por "Enviado" nem por "Aguardando assinatura" --
// aqueles estados existem para o repasse entre PDV e Almoxarifado, que aqui nao existe.
//
// pdv_id nulo identifica este inventario, e e o que faz o ajuste mirar o local configurado
// (`configuracao.local_almoxarifado`) em vez de um local de PDV.

// O Almoxarifado conta o catalogo inteiro: nao ha pdv_categorias limitando o que ele guarda.
const SQL_PRODUTOS_DO_ALMOXARIFADO = `
  SELECT p.sku, p.nome, p.qtd_total AS saldo_atual,
         COALESCE(string_agg(DISTINCT prc.categoria, ', ' ORDER BY prc.categoria), '') AS categoria
  FROM produtos p
  LEFT JOIN produto_categorias prc ON prc.sku_produto = p.sku
  WHERE p.ativo = TRUE
  GROUP BY p.sku, p.nome, p.qtd_total
  ORDER BY p.nome`;

// Inventario aberto do Almoxarifado (pdv_id nulo)
async function inventarioAbertoDoAlmoxarifado(executar) {
  const linhas = await executar(
    `SELECT * FROM inventarios
     WHERE pdv_id IS NULL AND status = ANY($1)
     ORDER BY id DESC LIMIT 1`,
    [STATUS_ABERTOS]
  );
  return linhas[0] || null;
}

// Ajusta o estoque central com o que o Almoxarifado contou.
//
// ATENCAO: produtos.qtd_total e ESPELHO do saldo da OMIE -- a tarefa ESTOQUE_ALMOXARIFADO o
// reescreve a cada sincronizacao. Gravar aqui da retorno imediato na tela, e quando o ajuste
// chega na OMIE a sincronizacao seguinte confirma o mesmo numero. Enquanto a integracao
// estiver em SIMULACAO o ajuste nao sai, entao a proxima sincronizacao devolve o valor
// antigo. Isso e consequencia da simulacao, nao um erro de contagem.
async function aplicarAjusteDoAlmoxarifado(client, inventario) {
  // Percorre o CATALOGO ativo. Sob a regra nova o ajuste so toca no que foi contado, entao
  // o catalogo serve ao RELATORIO: e assim que o sistema sabe dizer quais produtos foram
  // vistos e preservados, em vez de deixar a auditoria em silencio sobre eles.
  const { rows: itens } = await client.query(
    `WITH catalogo AS (
       SELECT sku AS sku_produto FROM produtos WHERE ativo = TRUE
       UNION
       SELECT sku_produto FROM inventario_itens WHERE inventario_id = $1
     )
     SELECT it.id, c.sku_produto, it.quantidade_contada, COALESCE(p.qtd_total, 0) AS saldo_anterior
     FROM catalogo c
     LEFT JOIN inventario_itens it ON it.inventario_id = $1 AND it.sku_produto = c.sku_produto
     LEFT JOIN produtos p ON p.sku = c.sku_produto
     ORDER BY c.sku_produto`,
    [inventario.id]
  );

  const aplicados = [];
  const preservados = [];
  for (const item of itens) {
    const semContagem = item.quantidade_contada === null || item.quantidade_contada === undefined;
    const anterior = Number(item.saldo_anterior || 0);

    // SEM CONTAGEM = NAO TOCA, a mesma regra do inventario de PDV (invertida em 30/08/2026).
    // O produto que ninguem contou fica como esta. Zerar exige digitar 0.
    if (semContagem) {
      preservados.push({ sku: item.sku_produto, saldoPreservado: anterior });
      continue;
    }

    const contado = Number(item.quantidade_contada);
    await client.query("UPDATE inventario_itens SET quantidade_anterior = $2 WHERE id = $1", [item.id, anterior]);
    // SUBSTITUI, nunca soma
    await client.query("UPDATE produtos SET qtd_total = $2 WHERE sku = $1", [item.sku_produto, contado]);

    aplicados.push({
      itemId: item.id,
      sku: item.sku_produto,
      anterior,
      contado,
      diferenca: contado - anterior,
      semContagem: false
    });
  }
  aplicados.preservados = preservados;
  return aplicados;
}

// Rotas do inventario proprio, montadas dentro de rotasDoAlmoxarifado
async function rotasInventarioDoAlmoxarifado(req, res, context) {
  const { method, requireUser, url, user } = context;
  const usuario = user?.name || "Almoxarifado";

  // Estado da contagem do Almoxarifado
  if (url.pathname === "/api/admin/inventario/proprio" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const aberto = await inventarioAbertoDoAlmoxarifado(query);
    const produtos = await query(SQL_PRODUTOS_DO_ALMOXARIFADO);
    const itens = aberto
      ? await query(
          `SELECT id, sku_produto, quantidade_contada, contado_em, origem
           FROM inventario_itens WHERE inventario_id = $1`,
          [aberto.id]
        )
      : [];
    send(res, 200, { inventario: aberto, itens, produtos });
    return true;
  }

  // Abre a contagem do Almoxarifado.
  //
  // Nao passa pela janela de contagem: aquele bloqueio existe para o Almoxarifado controlar
  // QUANDO os PDVs contam. Travar a si mesmo com o proprio controle seria um nó.
  if (url.pathname === "/api/admin/inventario/proprio" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    try {
      const criado = await tx(async (client) => {
        const jaAberto = await inventarioAbertoDoAlmoxarifado(comClient(client));
        if (jaAberto) return { inventario: jaAberto, reaproveitado: true };
        const inserido = await client.query(
          `INSERT INTO inventarios (codigo_inventario, pdv_id, status, criado_por)
           VALUES ($1, NULL, $2, $3) RETURNING *`,
          [code("INVA"), STATUS_INVENTARIO.EM_CONTAGEM, usuario]
        );
        const inventario = inserido.rows[0];
        await auditarInventario(client, {
          inventarioId: inventario.id,
          codigoInventario: inventario.codigo_inventario,
          acao: "inventario_aberto",
          usuario,
          dados: { origem: "almoxarifado" }
        });
        return { inventario, reaproveitado: false };
      });
      send(res, 200, criado);
    } catch (error) {
      if (error.code === "23505") {
        send(res, 409, { error: "O Almoxarifado já tem uma contagem aberta." });
        return true;
      }
      throw error;
    }
    return true;
  }

  // Salvamento parcial
  if (url.pathname === "/api/admin/inventario/proprio" && method === "PATCH") {
    if (!requireUser(req, res, "admin")) return true;
    const corpo = await readBody(req);
    const itens = Array.isArray(corpo?.itens) ? corpo.itens : [];
    if (!itens.length) {
      send(res, 400, { error: "Nenhuma contagem foi enviada." });
      return true;
    }
    try {
      const resultado = await tx(async (client) => {
        const inventario = await travarInventario(client, corpo?.codigo_inventario);
        if (inventario.pdv_id !== null) {
          const erro = new Error("Esta rota é só do inventário do Almoxarifado.");
          erro.statusCode = 400;
          throw erro;
        }
        if (inventario.status !== STATUS_INVENTARIO.EM_CONTAGEM) {
          const erro = new Error("Esta contagem já foi concluída. Para corrigir, abra um novo inventário.");
          erro.statusCode = 409;
          throw erro;
        }
        let gravados = 0;
        for (const item of itens) {
          const sku = String(item?.sku || "").trim();
          if (!sku) continue;
          const unidades = quantidadeContadaEmUnidades({
            sku,
            quantidade: item?.quantidade,
            unidadeMedida: item?.unidade_medida
          });
          await client.query(
            `INSERT INTO inventario_itens (inventario_id, sku_produto, quantidade_contada, contado_em, origem)
             VALUES ($1, $2, $3, CASE WHEN $3::numeric IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, 'ALMOX')
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

  // Conclui: assina, ajusta o estoque central e enfileira o lançamento — tudo num passo
  if (url.pathname === "/api/admin/inventario/proprio/concluir" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const corpo = await readBody(req);
    try {
      const resultado = await tx(async (client) => {
        const inventario = await travarInventario(client, corpo?.codigo_inventario);
        if (inventario.pdv_id !== null) {
          const erro = new Error("Esta rota é só do inventário do Almoxarifado.");
          erro.statusCode = 400;
          throw erro;
        }
        if (inventario.status !== STATUS_INVENTARIO.EM_CONTAGEM) {
          const erro = new Error("Este inventário já foi concluído.");
          erro.statusCode = 409;
          throw erro;
        }
        const contagem = await client.query(
          "SELECT COUNT(*)::int AS n FROM inventario_itens WHERE inventario_id = $1 AND quantidade_contada IS NOT NULL",
          [inventario.id]
        );
        if (!contagem.rows[0].n) {
          const erro = new Error("Conte ao menos um produto antes de concluir.");
          erro.statusCode = 400;
          throw erro;
        }

        const assinatura = validarAssinatura(corpo?.assinatura);
        const assinadoPor = normalizeText(corpo?.assinado_por, 120) || usuario;

        const aplicados = await aplicarAjusteDoAlmoxarifado(client, inventario);

        // Vai direto de "Em contagem" para "Confirmado": nao ha repasse entre duas partes
        await client.query(
          `UPDATE inventarios
           SET status = $2, confirmado_por = $3, confirmado_em = CURRENT_TIMESTAMP,
               assinatura_imagem = $4, assinado_por = $3, assinado_em = CURRENT_TIMESTAMP,
               ajuste_aplicado_em = CURRENT_TIMESTAMP, atualizado_em = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [inventario.id, STATUS_INVENTARIO.CONFIRMADO, assinadoPor, assinatura]
        );

        const preservados = aplicados.preservados || [];
        await auditarInventario(client, {
          inventarioId: inventario.id,
          codigoInventario: inventario.codigo_inventario,
          acao: "inventario_assinado",
          usuario: assinadoPor,
          valorAnterior: STATUS_INVENTARIO.EM_CONTAGEM,
          valorNovo: STATUS_INVENTARIO.CONFIRMADO,
          dados: {
            origem: "almoxarifado",
            itens: aplicados.length,
            preservados_sem_contagem: preservados.length,
            preservados: preservados.slice(0, 50),
            ajustes: aplicados.map((i) => ({ sku: i.sku, de: i.anterior, para: i.contado }))
          }
        });

        const { integracao, configuracao } = await integracaoAtiva(client);
        const fila = await enfileirarAjusteNaOmie(client, { inventario, aplicados, integracao, configuracao });

        // Em simulacao o ajuste nao chega na OMIE, e a tarefa ESTOQUE_ALMOXARIFADO reescreve
        // qtd_total com o saldo de la na proxima sincronizacao. Isso precisa aparecer na tela
        // e ficar no historico -- quem olhar depois tem de entender por que o numero mudou.
        const simulacao = String(configuracao?.modo_escrita || "").toUpperCase() !== "REAL";
        if (simulacao) {
          await auditarInventario(client, {
            inventarioId: inventario.id,
            codigoInventario: inventario.codigo_inventario,
            acao: "ajuste_em_simulacao",
            usuario: assinadoPor,
            observacao:
              "Ajuste registrado localmente. Como a integração com a OMIE está em modo simulação, " +
              "a próxima sincronização vai sobrescrever o estoque central com o saldo atual da OMIE.",
            dados: { origem: "almoxarifado", modo_escrita: "SIMULACAO" }
          });
        }

        return {
          codigo_inventario: inventario.codigo_inventario,
          itens: aplicados.length,
          preservados: preservados.length,
          fila,
          simulacao
        };
      });

      publishOrderAlert("INVENTARIO_STATUS_CHANGED", {
        codigoInventario: resultado.codigo_inventario,
        pdvId: null,
        status: STATUS_INVENTARIO.CONFIRMADO,
        usuario
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

// ===== Avisos aos PDVs =====
//
// Dois tipos: o do agendamento de inventario, que o proprio sistema cria quando o
// Almoxarifado marca a data, e o manual, de texto livre.
//
// O aviso de agendamento e UNICO: marcar uma data nova substitui o anterior, em vez de
// empilhar um aviso por vez que alguem mexeu no calendario.

const TIPO_AGENDAMENTO = "INVENTARIO_AGENDADO";
const TIPO_MANUAL = "MANUAL";

// Avisos que ainda valem. O de agendamento expira sozinho quando a data passa: um aviso
// dizendo "inventario dia 15" ainda visivel no dia 20 e ruido que ninguem vai limpar.
const SQL_AVISOS_ATIVOS = `
  SELECT id, tipo, titulo, mensagem, criado_em, expira_em
  FROM avisos
  WHERE ativo = TRUE AND (expira_em IS NULL OR expira_em >= CURRENT_TIMESTAMP)
  ORDER BY criado_em DESC
  LIMIT 20`;

// Cria ou substitui o aviso do agendamento de inventario
async function registrarAvisoDeAgendamento(client, { data, usuario }) {
  // Desliga o anterior: so existe um "proximo inventario" por vez
  await client.query("UPDATE avisos SET ativo = FALSE WHERE tipo = $1 AND ativo = TRUE", [TIPO_AGENDAMENTO]);
  if (!data) return null;
  const inserido = await client.query(
    `INSERT INTO avisos (tipo, titulo, mensagem, criado_por, expira_em)
     VALUES ($1, $2, $3, $4, ($5::date + INTERVAL '1 day'))
     RETURNING id`,
    [
      TIPO_AGENDAMENTO,
      "Inventário agendado",
      `O próximo inventário está marcado para ${formatarDataBr(data)}. Nesse dia a contagem será liberada automaticamente.`,
      usuario,
      data
    ]
  );
  return inserido.rows[0].id;
}

// Rotas de aviso, montadas em handleInventariosRoutes
async function rotasDeAvisos(req, res, context) {
  const { method, requireUser, url, user } = context;

  // Qualquer sessao autenticada le os avisos: e o PDV que precisa ve-los
  if (url.pathname === "/api/avisos" && method === "GET") {
    if (!requireUser(req, res)) return true;
    send(res, 200, { avisos: await query(SQL_AVISOS_ATIVOS) });
    return true;
  }

  // Criar aviso manual e do Almoxarifado
  if (url.pathname === "/api/admin/avisos" && method === "POST") {
    if (!requireUser(req, res, "admin")) return true;
    const corpo = await readBody(req);
    const mensagem = normalizeText(corpo?.mensagem, 500);
    if (!mensagem) {
      send(res, 400, { error: "Escreva a mensagem do aviso." });
      return true;
    }
    const titulo = normalizeText(corpo?.titulo, 120) || "Aviso do Almoxarifado";
    const expira = String(corpo?.expira_em || "").slice(0, 10);
    if (expira && !/^\d{4}-\d{2}-\d{2}$/.test(expira)) {
      send(res, 400, { error: "Data de expiração inválida." });
      return true;
    }
    const criado = await query(
      `INSERT INTO avisos (tipo, titulo, mensagem, criado_por, expira_em)
       VALUES ($1, $2, $3, $4, NULLIF($5, '')::date + INTERVAL '1 day')
       RETURNING id, tipo, titulo, mensagem, criado_em, expira_em`,
      [TIPO_MANUAL, titulo, mensagem, user?.name || "Almoxarifado", expira]
    );
    send(res, 200, { aviso: criado[0] });
    return true;
  }

  // Lista para o Almoxarifado administrar (inclui os ja desligados)
  if (url.pathname === "/api/admin/avisos" && method === "GET") {
    if (!requireUser(req, res, "admin")) return true;
    const avisos = await query(
      `SELECT id, tipo, titulo, mensagem, ativo, criado_por, criado_em, expira_em
       FROM avisos ORDER BY ativo DESC, criado_em DESC LIMIT 100`
    );
    send(res, 200, { avisos });
    return true;
  }

  // Desliga um aviso. Nao apaga: o registro de que o aviso existiu tem valor.
  if (url.pathname === "/api/admin/avisos" && method === "DELETE") {
    if (!requireUser(req, res, "admin")) return true;
    const corpo = await readBody(req);
    const id = asInt(corpo?.id);
    if (!id) {
      send(res, 400, { error: "Informe o aviso a desligar." });
      return true;
    }
    await query("UPDATE avisos SET ativo = FALSE WHERE id = $1", [id]);
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}

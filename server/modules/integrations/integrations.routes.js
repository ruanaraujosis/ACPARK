import { query, tx } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";
import { comoIntegrationError } from "../../services/integrations/core/errors.js";
import {
  handleIntegrationEvents,
  publishIntegrationEvent
} from "../../services/integrations/core/integration.events.js";
import {
  listarCredenciaisMascaradas,
  listarIntegracoes,
  obterIntegracao,
  registrarTesteConexao,
  salvarCredenciais,
  salvarIntegracao,
  sanitizarIntegracao
} from "../../services/integrations/core/integration.repository.js";
import * as fila from "../../services/integrations/core/job.queue.js";
import { executarJobPorId, executarProximoJob, testarConexao } from "../../services/integrations/core/job.runner.js";
import {
  catalogoPublico,
  exigirCapacidade,
  obterProvider
} from "../../services/integrations/core/provider-registry.js";
import { listarEstados } from "../../services/integrations/core/sync-state.js";
import * as lancamentos from "../../services/integrations/core/stock-launches.repository.js";
import {
  listarPendenciasDeFator,
  resumirFatores
} from "../../services/integrations/core/fator-conversao.repository.js";
import { interpretarFator, STATUS_FATOR } from "../../services/integrations/core/fator-conversao.js";
import {
  FILAS,
  listarSugestoes,
  registrarDecisao,
  resumirSugestoes,
  STATUS_DECISAO
} from "../../services/integrations/core/fator-evidencia.repository.js";
import { ehPendenciaDeCadastro } from "../../services/integrations/core/fator-evidencia.js";
import {
  importarPlanilha,
  listarLinhasDaPlanilha,
  listarPendenciasDeVinculo,
  vincularLinha
} from "../../services/integrations/core/fator-planilha.repository.js";
// Registra os providers disponiveis antes de qualquer rota responder
import "../../services/integrations/providers/index.js";

// Atalho para exigir sessao de admin
function requireAdmin(req, res, context) {
  return context.requireUser(req, res, "admin");
}

// Reservado para webhooks publicos de integracoes (nenhum provider usa por enquanto)
export async function handleIntegrationWebhookRoutes() {
  return false;
}

// Converte erro de integracao em resposta HTTP com a mensagem util para o operador
function responderErro(res, erroBruto, mensagemPadrao) {
  const erro = comoIntegrationError(erroBruto);
  return send(res, erro.status >= 400 && erro.status < 600 ? erro.status : 502, {
    error: mensagemPadrao,
    detail: erro.message,
    codigo: erro.codigo
  });
}

// Roteador administrativo de integracoes externas.
// Nenhuma rota aqui conhece OMIE: tudo passa pelo provider registrado da integracao.
export async function handleIntegrationsRoutes(req, res, context) {
  const { method, url, user } = context;

  // Stream de eventos em tempo real (SSE) sobre status de integracoes e jobs
  if (url.pathname === "/api/admin/integrations/events") {
    if (!requireAdmin(req, res, context)) return true;
    handleIntegrationEvents(req, res);
    return true;
  }

  // Catalogo de providers disponiveis. E daqui que a tela monta formularios e seletores,
  // entao uma API nova aparece sozinha na interface assim que for registrada.
  if (url.pathname === "/api/admin/integrations/providers" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    return (send(res, 200, { providers: catalogoPublico() }), true);
  }

  // Painel de saude: estado dos cursores, circuito e resumo da fila
  if (url.pathname === "/api/admin/integrations/health" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const [runtime, estados, resumo] = await Promise.all([
      query("SELECT * FROM integration_runtime_state ORDER BY updated_at DESC LIMIT 50").catch(() => []),
      tx((client) => listarEstados(client)).catch(() => []),
      tx((client) => fila.resumirJobs(client)).catch(() => [])
    ]);
    return (
      send(res, 200, {
        ok: true,
        runtime,
        sync_state: estados,
        resumo_jobs: resumo
      }),
      true
    );
  }

  if (url.pathname === "/api/admin/integrations" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const [integracoes, credenciais] = await Promise.all([
      tx((client) => listarIntegracoes(client)),
      tx((client) => listarCredenciaisMascaradas(client))
    ]);
    return (
      send(res, 200, {
        integrations: integracoes.map((integracao) =>
          sanitizarIntegracao(
            integracao,
            credenciais.filter((credencial) => String(credencial.integration_id) === String(integracao.id))
          )
        )
      }),
      true
    );
  }

  // Cria ou atualiza uma integracao. As credenciais aceitas sao as que o provider declara —
  // um campo que o provider nao conhece e simplesmente ignorado.
  if (url.pathname === "/api/admin/integrations" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const provedor = normalizeText(body.provedor || "OMIE", 40).toUpperCase();
    const provider = obterProvider(provedor);
    if (!provider) {
      return (
        send(res, 400, {
          error: `Provider "${provedor}" nao esta disponivel neste sistema.`
        }),
        true
      );
    }

    // Só as configurações declaradas pelo provider entram; o resto do corpo é descartado.
    // Editar uma integração existente parte do que já estava salvo, para um formulário que
    // não trouxe todos os campos não apagar os demais.
    const existente = Number(body.id || 0) ? await tx((client) => obterIntegracao(client, Number(body.id))) : null;
    const configuracao = { ...(existente?.configuracao || {}) };
    for (const item of provider.configuracoes || []) {
      if (body.configuracao && Object.hasOwn(body.configuracao, item.chave)) {
        configuracao[item.chave] = normalizeText(body.configuracao[item.chave], 160);
      }
    }

    const salva = await tx(async (client) => {
      const integracao = await salvarIntegracao(
        client,
        {
          id: Number(body.id || 0) || null,
          configuracao,
          nome: normalizeText(body.nome || provider.rotulo, 120),
          provedor,
          tipo: normalizeText(body.tipo || provider.tipoPadrao, 40),
          ambiente: normalizeText(body.ambiente || "PRODUCAO", 40).toUpperCase(),
          urlBase: normalizeText(body.url_base || provider.urlBasePadrao, 255),
          empresaVinculada: normalizeText(body.empresa_vinculada || "", 160) || null,
          ativo: body.ativo !== false,
          stockMode: normalizeText(body.stock_mode || "MANUAL", 30).toUpperCase(),
          syncIntervals: body.sync_intervals && typeof body.sync_intervals === "object" ? body.sync_intervals : {}
        },
        { autor: user?.name || null }
      );

      // Só as credenciais declaradas pelo provider são persistidas
      const valores = {};
      for (const credencial of provider.credenciais || []) {
        if (body[credencial.chave]) valores[credencial.chave] = body[credencial.chave];
      }
      await salvarCredenciais(client, integracao.id, valores);

      const credenciais = await listarCredenciaisMascaradas(client, integracao.id);
      return sanitizarIntegracao(integracao, credenciais);
    });

    publishIntegrationEvent("integration.status.updated", { id: salva.id });
    return (send(res, 200, { ok: true, integration: salva }), true);
  }

  // Testa a conexao chamando o testarConexao do provider. Nao passa pela fila.
  if (url.pathname === "/api/admin/integrations/test" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    try {
      const resultado = await tx((client) => testarConexao(client, id));
      await tx((client) =>
        registrarTesteConexao(client, id, {
          sucesso: true,
          duracaoMs: resultado.duracaoMs,
          mensagem: "Conexao validada."
        })
      );
      publishIntegrationEvent("integration.status.updated", { id });
      return (send(res, 200, { ok: true, status: "CONECTADO", resultado }), true);
    } catch (erroBruto) {
      const erro = comoIntegrationError(erroBruto);
      await tx((client) =>
        registrarTesteConexao(client, id, {
          sucesso: false,
          duracaoMs: erro.duracaoMs || 0,
          mensagem: erro.message.slice(0, 500)
        })
      ).catch(() => {});
      publishIntegrationEvent("integration.status.updated", { id });
      return (responderErro(res, erro, "A integracao nao validou a conexao."), true);
    }
  }

  // Dispara uma sincronizacao manual de uma capacidade especifica.
  // A capacidade e validada contra o provider — nao existe mais "escopo desconhecido vira COMPLETA".
  if (url.pathname === "/api/admin/integrations/sync" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    const capacidadeId = normalizeText(body.capacidade || body.escopo || body.scope, 60).toUpperCase();
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);
    if (!capacidadeId) return (send(res, 400, { error: "Informe qual operacao sincronizar." }), true);

    const integracao = await tx((client) => obterIntegracao(client, id));
    if (!integracao) return (send(res, 404, { error: "Integracao nao encontrada." }), true);

    let capacidade;
    try {
      capacidade = exigirCapacidade(integracao.provedor, capacidadeId);
    } catch (erro) {
      return (responderErro(res, erro, "Operacao indisponivel para esta integracao."), true);
    }

    const job = await tx((client) =>
      fila.enfileirar(client, {
        integrationId: id,
        capacidade: capacidade.id,
        prioridade: body.priority || capacidade.prioridade || "ALTA"
      })
    );
    // Executa na hora para o operador ver o resultado, em vez de esperar o proximo tick
    const processado = await tx((client) => executarJobPorId(client, job.id));
    return (send(res, 200, { ok: true, job: processado || job }), true);
  }

  if (url.pathname === "/api/admin/integrations/jobs" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const jobs = await tx((client) =>
      fila.listarJobs(client, {
        integrationId: Number(url.searchParams.get("integrationId")) || null,
        status: normalizeText(url.searchParams.get("status"), 40),
        capacidade: normalizeText(url.searchParams.get("capacidade"), 60),
        limite: Number(url.searchParams.get("limite")) || 100
      })
    ).catch(() => []);
    return (send(res, 200, { jobs }), true);
  }

  if (url.pathname === "/api/admin/integrations/jobs/process-next" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const job = await tx((client) => executarProximoJob(client));
    return (send(res, 200, { ok: true, job }), true);
  }

  if (url.pathname === "/api/admin/integrations/jobs/process" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Job invalido." }), true);
    const job = await tx((client) => executarJobPorId(client, id));
    if (!job) return (send(res, 404, { error: "Job nao encontrado ou ja em processamento." }), true);
    return (send(res, 200, { ok: true, job }), true);
  }

  // Reabre um job parado num status final, exigindo motivo (fica registrado no last_error)
  if (url.pathname === "/api/admin/integrations/jobs/retry" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    const motivo = normalizeText(body.motivo || body.reason, 500);
    if (!id) return (send(res, 400, { error: "Job invalido." }), true);
    if (!motivo) return (send(res, 400, { error: "Informe o motivo do reprocessamento." }), true);
    const job = await tx((client) => fila.reabrir(client, id, `Reaberto por ${user?.name || "admin"}: ${motivo}`));
    if (!job) return (send(res, 404, { error: "Job nao encontrado ou em processamento." }), true);
    return (send(res, 200, { ok: true, job }), true);
  }

  // Locais de estoque ja importados, para a tela oferecer um seletor em vez de pedir
  // que o operador digite o id do local na mao
  if (url.pathname === "/api/admin/integrations/locations" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const locais = await query(
      `SELECT integration_id, omie_location_id, code, name, active, synced_at
       FROM omie_stock_locations
       WHERE active = TRUE
       ORDER BY name`
    ).catch(() => []);
    return (send(res, 200, { locations: locais }), true);
  }

  // Vinculo entre PDV interno e local de estoque externo
  if (url.pathname === "/api/admin/integrations/location-mappings") {
    if (!requireAdmin(req, res, context)) return true;
    if (method === "GET") {
      const mappings = await query(
        `SELECT m.*, p.nome AS pdv_nome, l.name AS local_nome
         FROM pdv_stock_location_mappings m
         LEFT JOIN pdvs p ON p.id = m.pdv_acpark_id
         LEFT JOIN omie_stock_locations l
           ON l.integration_id = m.integration_id AND l.omie_location_id = m.omie_location_id
         ORDER BY p.nome`
      ).catch(() => []);
      return (send(res, 200, { mappings }), true);
    }
    if (method === "POST") {
      const body = await readBody(req);
      const integrationId = Number(body.integration_id || body.id);
      const pdvId = Number(body.pdv_id || body.pdv_acpark_id);
      const localId = normalizeText(body.omie_location_id || body.location_id, 80);
      if (!integrationId || !pdvId || !localId) {
        return (
          send(res, 400, {
            error: "Informe integracao, PDV e local de estoque."
          }),
          true
        );
      }
      // O local do almoxarifado NAO pode ser vinculado a um PDV.
      //
      // Aconteceu de verdade nesta instalacao: o PDV CABANA foi vinculado a 10792598111, que
      // e o ALMOXARIFADO. As consequencias sao silenciosas e caras -- a transferencia sairia
      // com origem igual ao destino, e a leitura de saldos daria ao PDV o estoque inteiro do
      // almoxarifado.
      const integracaoDoVinculo = await tx((client) => obterIntegracao(client, integrationId));
      const localAlmoxarifado = String(integracaoDoVinculo?.configuracao?.local_almoxarifado || "").trim();
      if (localAlmoxarifado && localAlmoxarifado === localId) {
        return (
          send(res, 409, {
            error:
              "Este e o local do almoxarifado, nao de um PDV. Vincular os dois faria a transferencia sair com origem igual ao destino e o PDV receber o estoque inteiro do almoxarifado."
          }),
          true
        );
      }

      // O vinculo e um-para-um nos dois sentidos. Dois PDVs no mesmo local externo fariam
      // o MESMO saldo ser gravado como estoque dos dois, dobrando o estoque no sistema.
      // Isto e concreto nesta instalacao: a OMIE tem um unico local "DECK", enquanto o
      // sistema tem DECK INFERIOR e DECK SUPERIOR.
      const ocupado = await query(
        `SELECT m.pdv_acpark_id, p.nome AS pdv_nome
         FROM pdv_stock_location_mappings m
         LEFT JOIN pdvs p ON p.id = m.pdv_acpark_id
         WHERE m.integration_id = $1 AND m.omie_location_id = $2
           AND m.active = TRUE AND m.pdv_acpark_id <> $3
         LIMIT 1`,
        [integrationId, localId, pdvId]
      );
      if (ocupado[0]) {
        return (
          send(res, 409, {
            error: `Este local ja esta vinculado ao PDV ${ocupado[0].pdv_nome || ocupado[0].pdv_acpark_id}. Um local de estoque so pode alimentar um PDV, senao o mesmo saldo entraria nos dois.`
          }),
          true
        );
      }

      // Um PDV so pode apontar para um local: trocar o vinculo desativa o anterior
      await tx(async (client) => {
        await client.query(
          `UPDATE pdv_stock_location_mappings
           SET active = FALSE, updated_at = CURRENT_TIMESTAMP
           WHERE integration_id = $1 AND pdv_acpark_id = $2 AND omie_location_id <> $3`,
          [integrationId, pdvId, localId]
        );
        await client.query(
          `INSERT INTO pdv_stock_location_mappings
             (integration_id, pdv_acpark_id, omie_location_id, omie_location_name, active)
           VALUES ($1, $2, $3, $4, TRUE)
           ON CONFLICT (pdv_acpark_id, integration_id, omie_location_id) DO UPDATE
           SET omie_location_name = EXCLUDED.omie_location_name,
               active = TRUE,
               updated_at = CURRENT_TIMESTAMP`,
          [integrationId, pdvId, localId, normalizeText(body.omie_location_name || "", 120) || null]
        );
      });
      return (send(res, 200, { ok: true }), true);
    }
  }

  // Pendencias de cadastro do fator de conversao: produtos cujo conteudo no ERP nao e
  // um inteiro puro. A correcao e feita LA, no cadastro do produto, nunca aqui.
  if (url.pathname === "/api/admin/integrations/fatores" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const [pendencias, resumo] = await Promise.all([
      tx((client) => listarPendenciasDeFator(client)).catch(() => []),
      tx((client) => resumirFatores(client)).catch(() => [])
    ]);
    return (send(res, 200, { pendencias, resumo }), true);
  }

  // Reler o fator de TODOS os produtos, sem esperar o ciclo de 7 dias.
  // Serve para depois de configurar as caracteristicas no ERP: o operador dispara aqui em vez
  // de esperar, e a varredura encadeia sozinha ate cobrir o catalogo.
  if (url.pathname === "/api/admin/integrations/fatores/reler" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    const integracao = await tx((client) => obterIntegracao(client, id));
    if (!integracao) return (send(res, 404, { error: "Integracao nao encontrada." }), true);

    let capacidade;
    try {
      capacidade = exigirCapacidade(integracao.provedor, "FATORES");
    } catch (erro) {
      return (responderErro(res, erro, "Esta integracao nao le fator de conversao."), true);
    }

    const job = await tx((client) =>
      fila.enfileirar(client, {
        integrationId: id,
        capacidade: capacidade.id,
        payload: { reler: true, relerDesde: new Date().toISOString() },
        prioridade: "NORMAL"
      })
    );
    return (send(res, 200, { ok: true, job }), true);
  }

  // Assistente de fator: sugestoes derivadas do historico de compra, com a evidencia junto.
  // A situacao (sugerido / conflito / unitario) e derivada na leitura, nunca gravada.
  if (url.pathname === "/api/admin/integrations/fator-evidencia" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    const situacao = normalizeText(url.searchParams.get("situacao"), 30).toUpperCase();
    const apenasPendentes = url.searchParams.get("pendentes") === "1";
    // Duas filas distintas: conferencia de fator e correcao de cadastro na OMIE
    const filaPedida = normalizeText(url.searchParams.get("fila"), 10).toUpperCase();
    const fila = FILAS[filaPedida] || FILAS.FATOR;

    const [sugestoes, resumo] = await Promise.all([
      tx((client) => listarSugestoes(client, id, { situacao: situacao || undefined, fila, apenasPendentes })),
      tx((client) => resumirSugestoes(client, id))
    ]);
    return (send(res, 200, { fila, sugestoes, resumo }), true);
  }

  // Dispara a varredura do historico de compra. Fora do relogio de proposito: o historico
  // nao muda sozinho e a varredura completa custa 48 chamadas a API.
  if (url.pathname === "/api/admin/integrations/fator-evidencia/varrer" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    const integracao = await tx((client) => obterIntegracao(client, id));
    if (!integracao) return (send(res, 404, { error: "Integracao nao encontrada." }), true);

    let capacidade;
    try {
      capacidade = exigirCapacidade(integracao.provedor, "EVIDENCIA_COMPRA");
    } catch (erro) {
      return (responderErro(res, erro, "Esta integracao nao le historico de compra."), true);
    }

    const job = await tx((client) =>
      fila.enfileirar(client, {
        integrationId: id,
        capacidade: capacidade.id,
        payload: { pagina: 1 },
        prioridade: "BAIXA"
      })
    );
    return (send(res, 200, { ok: true, job }), true);
  }

  // Decisao humana sobre uma sugestao. Aceita lote, porque revisar 200 produtos um POST por
  // vez seria a diferenca entre a tela ser usada e nao ser.
  if (url.pathname === "/api/admin/integrations/fator-evidencia/decidir" && method === "POST") {
    const usuario = requireAdmin(req, res, context);
    if (!usuario) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    const decisoes = Array.isArray(body.decisoes) ? body.decisoes : [body];
    const aceitas = [];
    const recusadas = [];

    for (const item of decisoes) {
      const externalProductId = normalizeText(item.external_product_id, 60);
      const status = normalizeText(item.status, 20).toUpperCase();
      if (!externalProductId) continue;
      if (status !== STATUS_DECISAO.APROVADA && status !== STATUS_DECISAO.RECUSADA) {
        recusadas.push({ external_product_id: externalProductId, motivo: "Status invalido." });
        continue;
      }

      // Aprovar exige um fator explicito e valido. O sistema nunca completa esse numero
      // sozinho: se a evidencia esta em conflito, quem decide e quem esta olhando.
      let fatorDecidido = null;
      if (status === STATUS_DECISAO.APROVADA) {
        const leitura = interpretarFator(String(item.fator ?? ""));
        if (leitura.status !== STATUS_FATOR.DEFINIDO) {
          recusadas.push({
            external_product_id: externalProductId,
            motivo: "Fator precisa ser um inteiro positivo."
          });
          continue;
        }
        fatorDecidido = leitura.fator;
      }

      await tx((client) =>
        registrarDecisao(client, {
          integrationId: id,
          externalProductId,
          status,
          fatorSugerido: Number(item.fator_sugerido) || null,
          fatorDecidido,
          decididoPor: usuario.username || usuario.nome || usuario.role || null
        })
      );
      aceitas.push({ external_product_id: externalProductId, status, fator: fatorDecidido });
    }

    return (send(res, 200, { ok: true, aceitas: aceitas.length, detalhe: aceitas, recusadas }), true);
  }

  // Grava no ERP os fatores aprovados. Capacidade de escrita: nasce em simulacao e so envia
  // de verdade com modo_escrita REAL, pela mesma trava generica das transferencias.
  if (url.pathname === "/api/admin/integrations/fator-evidencia/escrever" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    const integracao = await tx((client) => obterIntegracao(client, id));
    if (!integracao) return (send(res, 404, { error: "Integracao nao encontrada." }), true);

    let capacidade;
    try {
      capacidade = exigirCapacidade(integracao.provedor, "ESCRITA_FATOR");
    } catch (erro) {
      return (responderErro(res, erro, "Esta integracao nao grava fator no cadastro."), true);
    }

    const job = await tx((client) =>
      fila.enfileirar(client, {
        integrationId: id,
        capacidade: capacidade.id,
        payload: {},
        prioridade: "NORMAL"
      })
    );
    return (send(res, 200, { ok: true, job }), true);
  }


  // Planilha de controle de fardos: fonte de corroboracao do fator.
  //
  // O arquivo e lido no NAVEGADOR (mesma biblioteca ja usada na importacao de produtos) e
  // chega aqui como linhas por aba -- o servidor nao ganha dependencia de leitor de Excel.
  if (url.pathname === "/api/admin/integrations/fator-planilha/importar" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    const abas = body.abas && typeof body.abas === "object" ? body.abas : null;
    if (!abas || !Object.keys(abas).length) {
      return (send(res, 400, { error: "Nenhuma aba de planilha recebida." }), true);
    }

    const resumo = await tx((client) => importarPlanilha(client, id, abas));
    return (send(res, 200, { ok: true, resumo }), true);
  }

  // Linhas da planilha e a fila de vinculo, com candidatos sugeridos por semelhanca de nome
  if (url.pathname === "/api/admin/integrations/fator-planilha" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return (send(res, 400, { error: "Integracao invalida." }), true);

    const [linhas, pendencias] = await Promise.all([
      tx((client) => listarLinhasDaPlanilha(client, id)),
      tx((client) => listarPendenciasDeVinculo(client, id))
    ]);
    return (send(res, 200, { linhas, pendencias }), true);
  }

  // Vincula uma linha da planilha a um produto do cadastro.
  //
  // Sempre humano: o casamento textual erra -- medido, o primeiro candidato de
  // "AGUA MINERAL GASOSA 500ML" foi "AGUA MINERAL SEM GAS 500ML", o produto oposto.
  if (url.pathname === "/api/admin/integrations/fator-planilha/vincular" && method === "POST") {
    const usuario = requireAdmin(req, res, context);
    if (!usuario) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    const nomeOperacao = normalizeText(body.nome_operacao, 160);
    if (!id || !nomeOperacao) {
      return (send(res, 400, { error: "Informe a integracao e a linha da planilha." }), true);
    }
    // Vinculo vazio desfaz: quem percebeu que casou errado precisa poder soltar
    const externalProductId = normalizeText(body.external_product_id, 60) || null;

    const alteradas = await tx((client) =>
      vincularLinha(client, id, nomeOperacao, externalProductId, usuario.username || usuario.role || null)
    );
    if (!alteradas) return (send(res, 404, { error: "Linha da planilha nao encontrada." }), true);
    return (send(res, 200, { ok: true, vinculado: Boolean(externalProductId) }), true);
  }

  // Fila de lancamentos de escrita: pendentes, simulados, enviados e com erro
  if (url.pathname === "/api/admin/integrations/launches" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const status = normalizeText(url.searchParams.get("status"), 40).toUpperCase();
    const pedido = normalizeText(url.searchParams.get("pedido"), 80);
    const linhas = await query(
      `SELECT l.*, p.nome AS pdv_nome, pr.nome AS produto_nome
       FROM integration_stock_launches l
       LEFT JOIN pdvs p ON p.id = l.pdv_id
       LEFT JOIN produtos pr ON pr.sku = l.sku_produto
       WHERE ($1::text = '' OR l.status = $1)
         AND ($2::text = '' OR l.codigo_pedido = $2)
       ORDER BY l.created_at DESC
       LIMIT 200`,
      [status, pedido]
    ).catch(() => []);

    const resumo = await query(
      "SELECT status, COUNT(*)::int AS total FROM integration_stock_launches GROUP BY status"
    ).catch(() => []);

    return (send(res, 200, { launches: linhas, resumo }), true);
  }

  // Reprocessa um lancamento com erro pela interface, sem terminal
  if (url.pathname === "/api/admin/integrations/launches/retry" && method === "POST") {
    if (!requireAdmin(req, res, context)) return true;
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return (send(res, 400, { error: "Lancamento invalido." }), true);

    const lancamento = await tx((client) => lancamentos.reabrirLancamento(client, id));
    if (!lancamento) {
      return (
        send(res, 409, {
          error: "Lancamento nao encontrado ou ja enviado. Enviado nao se reprocessa, para nao duplicar."
        }),
        true
      );
    }

    // Enfileira o envio: a capacidade de escrita drena a fila
    const integracao = await tx((client) => obterIntegracao(client, lancamento.integration_id));
    const provider = integracao ? obterProvider(integracao.provedor) : null;
    const capacidade = provider?.capacidades?.find((item) => item.escrita === true);
    if (capacidade) {
      await tx((client) =>
        fila.enfileirar(client, { integrationId: integracao.id, capacidade: capacidade.id, prioridade: "ALTA" })
      );
    }
    return (send(res, 200, { ok: true, lancamento }), true);
  }

  if (url.pathname === "/api/admin/integrations/reconciliations" && method === "GET") {
    if (!requireAdmin(req, res, context)) return true;
    const divergences = await query(
      `SELECT r.*, p.nome AS pdv_nome, pr.nome AS produto_nome
       FROM stock_reconciliation_items r
       LEFT JOIN pdvs p ON p.id = r.pdv_id
       LEFT JOIN produtos pr ON pr.sku = r.sku_produto
       WHERE r.status = 'PENDENTE'
       ORDER BY r.created_at DESC
       LIMIT 200`
    ).catch(() => []);
    return (send(res, 200, { divergences }), true);
  }

  return false;
}

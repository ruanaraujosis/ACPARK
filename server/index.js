import "./env.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { parse as parseCookie, serialize as serializeCookie } from "cookie";
import { pool, query, tx, verifyPassword, hashPassword, asInt, code } from "./db.js";
import { handleEstoqueRoutes } from "./modules/estoque/estoque.routes.js";
import { syncPdvAllowedProducts } from "./modules/estoque/estoque.service.js";
import { handlePedidosRoutes } from "./modules/pedidos/pedidos.routes.js";
import { handleAvariasRoutes } from "./modules/avarias/avarias.routes.js";
import { handleOmieRoutes } from "./modules/omie/omie.routes.js";
import { handleIntegrationWebhookRoutes, handleIntegrationsRoutes } from "./modules/integrations/integrations.routes.js";
import { handleOrderAlertRoutes } from "./modules/order-alerts/order-alerts.routes.js";
import { handleBackupRoutes } from "./modules/backup/backup.routes.js";
import { handleSetupRoutes } from "./modules/setup/setup.routes.js";
import { runOmieSchedulerTick, startOmieScheduler } from "./services/integrations/omie/omie.scheduler.js";
import { comprimirSePossivel, marcarSuporteGzip, normalizeCategories, normalizeCategoryList, normalizeText, readBody, send } from "./utils/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT || 5173);
// Em produção exige JWT_SECRET real: com o valor padrão qualquer um que conheça
// essa string (ela está no repositório) conseguiria forjar um cookie de admin.
if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "dev-only-change-me")) {
  throw new Error("JWT_SECRET obrigatorio em producao.");
}
const jwtSecret = process.env.JWT_SECRET || "dev-only-change-me";
// Cookie seguro (HTTPS) só quando explicitamente forçado (ex: LAN atrás de HTTPS interno)
// NODE_ENV=production sozinho NÃO ativa isso: em rede local sobre HTTP puro, secure=true faria o navegador nunca enviar o cookie
const secureCookies = process.env.FORCE_SECURE_COOKIES === "true";
const sessionCookieOptions = { path: "/", httpOnly: true, sameSite: "lax", secure: secureCookies };

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};


// Decodifica e valida o cookie de sessão (JWT); retorna null se ausente ou inválido
function sessionFrom(req) {
  const cookies = parseCookie(req.headers.cookie || "");
  if (!cookies.session) return null;
  try {
    return jwt.verify(cookies.session, jwtSecret);
  } catch {
    return null;
  }
}

// Exige usuário autenticado (e, opcionalmente, um perfil específico); já envia a resposta de erro
function requireUser(req, res, role = null) {
  const user = sessionFrom(req);
  if (!user) {
    send(res, 401, { error: "Login necessario." });
    return null;
  }
  if (role && user.role !== role) {
    send(res, 403, { error: "Acesso não permitido para este perfil." });
    return null;
  }
  return user;
}

// Aplica o schema.sql no banco (idempotente); usado para manter a estrutura sincronizada
async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
}

// Intervalo mínimo entre duas verificações de reposição automática.
// Antes isso rodava a CADA requisição autenticada: uma transação + varredura de estoque_pdv
// (42 mil linhas, ~17ms) por chamada, inclusive nas de polling. Como a reposição depende só do
// estoque mudar, verificar periodicamente dá o mesmo resultado por uma fração do custo.
const AUTO_ORDER_INTERVAL_MS = Number(process.env.AUTO_ORDER_INTERVAL_MS || 60_000);
let autoOrdersLastRun = 0;
let autoOrdersRunning = false;

// Gera pedidos automáticos (prefixo AUTO-) quando o estoque de um PDV cai no mínimo configurado.
// Limitado por AUTO_ORDER_INTERVAL_MS e protegido contra execução concorrente.
async function processAutoOrders() {
  const agora = Date.now();
  if (autoOrdersRunning || agora - autoOrdersLastRun < AUTO_ORDER_INTERVAL_MS) return;
  autoOrdersRunning = true;
  autoOrdersLastRun = agora;
  try {
    await runAutoOrders();
  } finally {
    autoOrdersRunning = false;
  }
}

// Faz a verificação de fato; separada para o controle de intervalo ficar legível e testável
async function runAutoOrders() {
  await tx(async (client) => {
    const lows = await client.query(
      `SELECT e.pdv_id, e.sku_produto, e.quantidade, e.estoque_minimo, e.estoque_maximo
       FROM estoque_pdv e
       JOIN produtos p ON p.sku = e.sku_produto
       WHERE e.permitido = TRUE
         AND p.ativo = TRUE
         AND e.estoque_maximo > e.quantidade
         AND e.quantidade <= e.estoque_minimo`
    );
    if (!lows.rows.length) return;

    for (const item of lows.rows) {
      const exists = await client.query(
        `SELECT 1 FROM pedidos
         WHERE pdv_id = $1 AND sku_produto = $2 AND codigo_pedido LIKE 'AUTO-%'
           AND status IN ('Pendente', 'Em Andamento')
         LIMIT 1`,
        [item.pdv_id, item.sku_produto]
      );
      if (exists.rowCount) continue;

      // Evita duplicar pedido automático já pendente/em andamento para o mesmo produto no PDV
      await client.query(
        `INSERT INTO pedidos
          (codigo_pedido, solicitante, pdv_id, sku_produto, quantidade_solicitada, quantidade_liberada, status, observacao)
         VALUES ($1, 'AUTO PEDIDO', $2, $3, $4, 0, 'Pendente', 'Gerado automaticamente por estoque minimo')`,
        [code("AUTO"), item.pdv_id, item.sku_produto, item.estoque_maximo - item.quantidade]
      );
    }
  });
}

// Lista produtos já com as categorias de cada um.
//
// Faz duas consultas simples e junta em memória, em vez de agregar no SQL. O `string_agg` +
// `array_agg` com ORDER BY interno obrigava o Postgres a ordenar duas vezes (uma para agrupar,
// outra para o ORDER BY final) e custava ~230ms para 4,5 mil produtos — em toda carga de página.
// A ordenação das categorias continua vindo do banco (ORDER BY sku_produto, categoria), então o
// resultado é idêntico ao da versão anterior, inclusive na collation.
async function listarProdutosComCategorias({ somenteAtivos = false, colunasReduzidas = false } = {}) {
  const colunas = colunasReduzidas
    ? "p.sku, p.nome, COALESCE(p.origem, 'manual') AS origem"
    : "p.sku, p.nome, p.qtd_total, p.ativo, COALESCE(p.origem, 'manual') AS origem";
  const [produtos, vinculos] = await Promise.all([
    query(`SELECT ${colunas} FROM produtos p ${somenteAtivos ? "WHERE p.ativo = TRUE" : ""} ORDER BY p.nome`),
    query("SELECT sku_produto, categoria FROM produto_categorias ORDER BY sku_produto, categoria")
  ]);

  const categoriasPorSku = new Map();
  for (const vinculo of vinculos) {
    const lista = categoriasPorSku.get(vinculo.sku_produto);
    if (lista) lista.push(vinculo.categoria);
    else categoriasPorSku.set(vinculo.sku_produto, [vinculo.categoria]);
  }

  return produtos.map((produto) => {
    const categorias = categoriasPorSku.get(produto.sku) || [];
    return { ...produto, categoria: categorias.join(", "), categorias };
  });
}

// Limite de tentativas de login por IP: protege contra forca bruta de senha
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const loginAttempts = new Map();

// Verifica se o IP estourou o limite de tentativas de login na janela atual
function isLoginRateLimited(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

// Registra uma tentativa de login falha para o IP
function registerLoginFailure(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttemptAt: Date.now() });
    return;
  }
  entry.count += 1;
}

// Roteador principal das rotas /api/*; delega para os handlers de cada módulo
async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || "GET";

  if (url.pathname === "/api/auth/me") {
    return send(res, 200, { user: sessionFrom(req) });
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    return send(res, 200, { ok: true }, {
      "Set-Cookie": serializeCookie("session", "", { ...sessionCookieOptions, maxAge: 0 })
    });
  }

  // Login por perfil: admin usa senha única do almoxarifado; PDV usa senha própria do ponto
  if (url.pathname === "/api/auth/login" && method === "POST") {
    const ip = req.socket.remoteAddress || "desconhecido";
    if (isLoginRateLimited(ip)) {
      return send(res, 429, { error: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente." });
    }
    const body = await readBody(req);
    const profile = body.profile === "admin" ? "admin" : "pdv";
    const password = normalizeText(body.password, 120);

    if (profile === "admin") {
      const rows = await query("SELECT valor FROM configuracoes WHERE chave = 'senha_almoxarifado'");
      if (!rows[0] || !verifyPassword(password, rows[0].valor)) {
        registerLoginFailure(ip);
        return send(res, 401, { error: "Senha incorreta." });
      }
      const token = jwt.sign({ role: "admin", name: "Almoxarifado" }, jwtSecret, { expiresIn: "8h" });
      return send(res, 200, { user: { role: "admin", name: "Almoxarifado" } }, {
        "Set-Cookie": serializeCookie("session", token, { ...sessionCookieOptions, maxAge: 60 * 60 * 8 })
      });
    }

    const pdvId = asInt(body.pdvId);
    const rows = await query("SELECT id, nome, senha FROM pdvs WHERE id = $1", [pdvId]);
    if (!rows[0] || !verifyPassword(password, rows[0].senha)) {
      registerLoginFailure(ip);
      return send(res, 401, { error: "Senha incorreta." });
    }
    const token = jwt.sign({ role: "pdv", pdvId: rows[0].id, name: rows[0].nome }, jwtSecret, { expiresIn: "8h" });
    return send(res, 200, { user: { role: "pdv", pdvId: rows[0].id, name: rows[0].nome } }, {
      "Set-Cookie": serializeCookie("session", token, { ...sessionCookieOptions, maxAge: 60 * 60 * 8 })
    });
  }

  // Lista pública de PDVs (sem autenticação) para popular a tela de login
  if (url.pathname === "/api/public/pdvs") {
    return send(res, 200, { pdvs: await query("SELECT id, nome FROM pdvs ORDER BY nome") });
  }

  // Assistente de primeiro uso: rotas públicas que só funcionam numa instalação nova (sem senha
  // do almoxarifado configurada ainda) — cada rota se tranca sozinha no servidor
  if (await handleSetupRoutes(req, res, { method, url })) return;

  // Endpoint chamado por cron externo para disparar o tick de sincronização OMIE.
  // Fica desabilitado quando CRON_SECRET não está configurado — antes, sem o segredo
  // a checagem era pulada e qualquer um na rede podia disparar a sincronização.
  if (url.pathname === "/api/cron/omie-sync") {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      return send(res, 404, { error: "Rota de cron desabilitada." });
    }
    if (req.headers.authorization !== `Bearer ${cronSecret}`) {
      return send(res, 401, { error: "Cron nao autorizado." });
    }
    const result = await runOmieSchedulerTick();
    return send(res, 200, { ok: true, result });
  }

  if (await handleIntegrationWebhookRoutes(req, res, { method, requireUser, url })) return;

  // Todas as rotas abaixo exigem sessão autenticada
  const user = requireUser(req, res);
  if (!user) return;

  // Verifica reposição automática por estoque mínimo a cada chamada autenticada
  await processAutoOrders();

  // Dados iniciais carregados ao abrir a aplicação (PDVs, produtos e categorias)
  if (url.pathname === "/api/bootstrap") {
    const [pdvs, products, categories] = await Promise.all([
      query(`
        SELECT p.id, p.nome, p.codigo_orion, p.is_cozinha, p.categoria,
               COALESCE(ARRAY(
                 SELECT pc.categoria
                 FROM pdv_categorias pc
                 WHERE pc.pdv_id = p.id
                 ORDER BY pc.categoria
               ), '{}') AS categorias
        FROM pdvs p
        ORDER BY p.nome
      `),
      listarProdutosComCategorias(),
      query("SELECT nome FROM categorias ORDER BY nome")
    ]);
    return send(res, 200, { pdvs, products, categories, user });
  }

  // Delega para os roteadores de cada módulo; cada um retorna true se tratou a rota
  if (await handleEstoqueRoutes(req, res, { method, requireUser, url, user })) return;
  if (await handlePedidosRoutes(req, res, { method, requireUser, url, user })) return;
  if (await handleAvariasRoutes(req, res, { method, requireUser, url, user })) return;
  if (await handleOmieRoutes(req, res, { method, requireUser, url, user })) return;
  if (await handleIntegrationsRoutes(req, res, { method, requireUser, url, user })) return;
  if (await handleOrderAlertRoutes(req, res, { method, url, user })) return;
  if (await handleBackupRoutes(req, res, { method, requireUser, url, user })) return;

  // CRUD de produtos manuais; produtos de origem OMIE não podem ser criados/editados/excluídos aqui
  if (url.pathname === "/api/admin/products") {
    if (!requireUser(req, res, "admin")) return;
    if (method === "GET") {
      return send(res, 200, { products: await listarProdutosComCategorias() });
    }
    const body = await readBody(req);
    if (method === "POST") {
      const sku = normalizeText(body.sku, 60);
      const nome = normalizeText(body.nome, 160).toUpperCase();
      const qty = asInt(body.qtd_total);
      const categorias = Array.isArray(body.categorias)
        ? [...new Set(body.categorias.map((item) => normalizeText(item, 120).toUpperCase()).filter(Boolean))]
        : [];
      if (!sku || !nome) return send(res, 400, { error: "SKU e nome são obrigatórios." });
      // Upsert só é aplicado se o produto existente também for de origem manual (protege itens do OMIE)
      const inserted = await tx(async (client) => {
        const result = await client.query(
          `INSERT INTO produtos (sku, nome, qtd_total, estoque_central, ativo, categoria, origem)
           VALUES ($1, $2, $3, $3, TRUE, NULL, 'manual')
           ON CONFLICT (sku) DO UPDATE SET
             nome = EXCLUDED.nome,
             qtd_total = EXCLUDED.qtd_total,
             estoque_central = EXCLUDED.estoque_central,
             ativo = TRUE
           WHERE COALESCE(produtos.origem, 'manual') = 'manual'
           RETURNING sku`,
          [sku, nome, qty]
        );
        if (!result.rows[0]) return [];
        await client.query("DELETE FROM produto_categorias WHERE sku_produto = $1", [sku]);
        for (const category of categorias) {
          await client.query("INSERT INTO categorias (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING", [category]);
          await client.query(
            `INSERT INTO produto_categorias (sku_produto, categoria)
             VALUES ($1, $2)
             ON CONFLICT (sku_produto, categoria) DO NOTHING`,
            [sku, category]
          );
        }
        await client.query("UPDATE produtos SET categoria = $2 WHERE sku = $1", [sku, categorias[0] || null]);
        return result.rows;
      });
      if (!inserted[0]) return send(res, 400, { error: "Este SKU pertence a um produto integrado ao OMIE." });
      return send(res, 200, { ok: true });
    }
    // Edita um produto manual; falha se o SKU pertencer a um produto sincronizado do OMIE
    if (method === "PATCH") {
      const sku = normalizeText(body.sku, 60);
      const categorias = Array.isArray(body.categorias)
        ? [...new Set(body.categorias.map((item) => normalizeText(item, 120).toUpperCase()).filter(Boolean))]
        : [];
      const updated = await tx(async (client) => {
        const result = await client.query(
          "UPDATE produtos SET nome = $2, qtd_total = $3, estoque_central = $3, ativo = $4, categoria = $5 WHERE sku = $1 AND COALESCE(origem, 'manual') = 'manual' RETURNING sku",
          [sku, normalizeText(body.nome, 160).toUpperCase(), asInt(body.qtd_total), Boolean(body.ativo), categorias[0] || null]
        );
        if (!result.rows[0]) return [];
        await client.query("DELETE FROM produto_categorias WHERE sku_produto = $1", [sku]);
        for (const category of categorias) {
          await client.query("INSERT INTO categorias (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING", [category]);
          await client.query(
            `INSERT INTO produto_categorias (sku_produto, categoria)
             VALUES ($1, $2)
             ON CONFLICT (sku_produto, categoria) DO NOTHING`,
            [sku, category]
          );
        }
        return result.rows;
      });
      if (!updated[0]) return send(res, 400, { error: "Produto integrado ao OMIE não pode ser editado aqui." });
      // Desativar bloqueia o produto em todos os PDVs; reativar recalcula a liberação por categoria
      if (!body.ativo) await query("UPDATE estoque_pdv SET permitido = FALSE WHERE sku_produto = $1", [sku]);
      if (body.ativo) {
        const pdvs = await query("SELECT id FROM pdvs");
        await tx(async (client) => {
          for (const pdv of pdvs) await syncPdvAllowedProducts(client, pdv.id);
        });
      }
      return send(res, 200, { ok: true });
    }
    // Exclui um produto manual e seus vínculos (pedidos e estoque por PDV)
    if (method === "DELETE") {
      const sku = normalizeText(body.sku, 60);
      const deleted = await tx(async (client) => {
        const check = await client.query("SELECT sku FROM produtos WHERE sku = $1 AND COALESCE(origem, 'manual') = 'manual'", [sku]);
        if (!check.rows[0]) return [];
        await client.query("DELETE FROM pedidos WHERE sku_produto = $1", [sku]);
        await client.query("DELETE FROM estoque_pdv WHERE sku_produto = $1", [sku]);
        const result = await client.query("DELETE FROM produtos WHERE sku = $1 RETURNING sku", [sku]);
        return result.rows;
      });
      if (!deleted[0]) return send(res, 400, { error: "Produto integrado ao OMIE não pode ser excluído aqui." });
      return send(res, 200, { ok: true });
    }
  }

  // Importação em lote de produtos (usada pela sincronização OMIE e por upload manual), limitada a 2000 itens
  if (url.pathname === "/api/admin/products/import" && method === "POST") {
    if (!requireUser(req, res, "admin")) return;
    const body = await readBody(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
    if (!items.length) return send(res, 400, { error: "Nenhum produto válido para importar." });

    let imported = 0;
    await tx(async (client) => {
      for (const item of items) {
        const sku = normalizeText(item.sku, 60);
        const nome = normalizeText(item.nome, 160).toUpperCase();
        const categorias = normalizeCategoryList(item.categorias || item.categoria);
        const categoria = categorias[0] || null;
        const origem = String(item.origem || "").trim().toLowerCase() === "omie" ? "omie" : "manual";
        if (!sku || !nome) continue;
        await client.query(
          `INSERT INTO produtos (sku, nome, qtd_total, estoque_central, ativo, categoria, origem)
           VALUES ($1, $2, $3, $3, $4, $5, $6)
           ON CONFLICT (sku) DO UPDATE SET
             nome = EXCLUDED.nome,
             qtd_total = EXCLUDED.qtd_total,
             estoque_central = EXCLUDED.estoque_central,
             ativo = EXCLUDED.ativo,
             categoria = EXCLUDED.categoria,
             origem = EXCLUDED.origem`,
          [sku, nome, asInt(item.qtd_total), item.ativo !== false, categoria, origem]
        );
        if (categorias.length) {
          await client.query("DELETE FROM produto_categorias WHERE sku_produto = $1", [sku]);
        }
        for (const category of categorias) {
          await client.query(
            `INSERT INTO categorias (nome)
             VALUES ($1)
             ON CONFLICT (nome) DO NOTHING`,
            [category]
          );
          await client.query(
            `INSERT INTO produto_categorias (sku_produto, categoria)
             VALUES ($1, $2)
             ON CONFLICT (sku_produto, categoria) DO NOTHING`,
            [sku, category]
          );
        }
        if (item.ativo === false) {
          await client.query("UPDATE estoque_pdv SET permitido = FALSE WHERE sku_produto = $1", [sku]);
        }
        imported += 1;
      }
    });
    return send(res, 200, { ok: true, imported });
  }

  // CRUD de pontos de venda (PDVs)
  if (url.pathname === "/api/admin/pdvs") {
    if (!requireUser(req, res, "admin")) return;
    const body = method === "GET" ? {} : await readBody(req);
    if (method === "GET") {
      return send(res, 200, { pdvs: await query(`
        SELECT p.id, p.nome, p.codigo_orion, p.is_cozinha, p.categoria,
               COALESCE(ARRAY(
                 SELECT pc.categoria
                 FROM pdv_categorias pc
                 WHERE pc.pdv_id = p.id
                 ORDER BY pc.categoria
               ), '{}') AS categorias
        FROM pdvs p
        ORDER BY p.nome
      `) });
    }
    if (method === "POST") {
      const nome = normalizeText(body.nome, 120).toUpperCase();
      const senha = normalizeText(body.senha, 120);
      const categoria = normalizeText(body.categoria, 120).toUpperCase() || null;
      const categorias = normalizeCategories(body.categorias);
      if (!nome || !senha) return send(res, 400, { error: "Nome e senha são obrigatórios." });
      const pdv = await query(
        `INSERT INTO pdvs (nome, senha, codigo_orion, is_cozinha, categoria)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (nome) DO NOTHING
         RETURNING id`,
        [nome, hashPassword(senha), normalizeText(body.codigo_orion, 60) || null, false, categoria]
      );
      const pdvId = pdv[0]?.id;
      // Novo PDV: associa categorias e já libera os produtos correspondentes no estoque
      if (pdvId) {
        for (const category of categorias) {
          await query(
            `INSERT INTO categorias (nome)
             VALUES ($1)
             ON CONFLICT (nome) DO NOTHING`,
            [category]
          );
          await query(
            `INSERT INTO pdv_categorias (pdv_id, categoria)
             VALUES ($1, $2)
             ON CONFLICT (pdv_id, categoria) DO NOTHING`,
            [pdvId, category]
          );
        }
        await tx(async (client) => {
          await syncPdvAllowedProducts(client, pdvId);
        });
      }
      return send(res, 200, { ok: true });
    }
    // Edita um PDV; senha só é alterada se enviada, e categorias são substituídas por completo
    if (method === "PATCH") {
      const pdvId = asInt(body.id);
      const categorias = normalizeCategories(body.categorias);
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!pdvId || !nome) return send(res, 400, { error: "PDV inválido." });
      await query("UPDATE pdvs SET nome = $2, codigo_orion = $3, is_cozinha = $4, categoria = $5 WHERE id = $1", [
        pdvId,
        nome,
        normalizeText(body.codigo_orion, 60) || null,
        false,
        normalizeText(body.categoria, 120).toUpperCase() || null
      ]);
      const senha = normalizeText(body.senha, 120);
      if (senha) {
        await query("UPDATE pdvs SET senha = $2 WHERE id = $1", [pdvId, hashPassword(senha)]);
      }
      await tx(async (client) => {
        await client.query("DELETE FROM pdv_categorias WHERE pdv_id = $1", [pdvId]);
        for (const category of categorias) {
          await client.query(
            `INSERT INTO categorias (nome)
             VALUES ($1)
             ON CONFLICT (nome) DO NOTHING`,
            [category]
          );
          await client.query(
            `INSERT INTO pdv_categorias (pdv_id, categoria)
             VALUES ($1, $2)
             ON CONFLICT (pdv_id, categoria) DO NOTHING`,
            [pdvId, category]
          );
        }
        await syncPdvAllowedProducts(client, pdvId);
      });
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      await query("DELETE FROM pdvs WHERE id = $1", [asInt(body.id)]);
      return send(res, 200, { ok: true });
    }
  }

  // CRUD de categorias de produto (usadas para liberar produtos por PDV)
  if (url.pathname === "/api/admin/categories") {
    if (!requireUser(req, res, "admin")) return;
    if (method === "GET") {
      const rows = await query(
        `SELECT trim(upper(c.nome)) AS nome,
                (SELECT COUNT(*)::int FROM produto_categorias pcg WHERE trim(upper(pcg.categoria)) = trim(upper(c.nome))) AS produtos,
                (SELECT COUNT(*)::int FROM pdv_categorias pc WHERE trim(upper(pc.categoria)) = trim(upper(c.nome))) AS pdvs
         FROM categorias c
         ORDER BY trim(upper(c.nome))`
      );
      const products = await listarProdutosComCategorias({ somenteAtivos: true, colunasReduzidas: true });
      return send(res, 200, { categories: rows, products });
    }
    const body = await readBody(req);
    if (method === "POST") {
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!nome) return send(res, 400, { error: "Nome da categoria e obrigatorio." });
      await query(
        `INSERT INTO categorias (nome)
         VALUES ($1)
         ON CONFLICT (nome) DO NOTHING`,
        [nome]
      );
      return send(res, 200, { ok: true });
    }
    // Renomeia uma categoria propagando o novo nome para produtos, PDVs e tabelas de vínculo
    if (method === "PATCH") {
      const atual = normalizeText(body.atual, 120).toUpperCase();
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!atual || !nome) return send(res, 400, { error: "Categoria atual e novo nome são obrigatórios." });
      await tx(async (client) => {
        await client.query("UPDATE categorias SET nome = $2 WHERE nome = $1", [atual, nome]);
        await client.query("UPDATE produtos SET categoria = $2 WHERE categoria = $1", [atual, nome]);
        await client.query("UPDATE produto_categorias SET categoria = $2 WHERE categoria = $1", [atual, nome]);
        await client.query("UPDATE pdv_categorias SET categoria = $2 WHERE categoria = $1", [atual, nome]);
        await client.query("UPDATE pdvs SET categoria = $2 WHERE categoria = $1", [atual, nome]);
      });
      return send(res, 200, { ok: true });
    }
    // Remove a categoria e limpa suas referências em produtos e PDVs
    if (method === "DELETE") {
      const nome = normalizeText(body.nome, 120).toUpperCase();
      if (!nome) return send(res, 400, { error: "Nome da categoria e obrigatorio." });
      await tx(async (client) => {
        await client.query("DELETE FROM categorias WHERE nome = $1", [nome]);
        await client.query("UPDATE produtos SET categoria = NULL WHERE categoria = $1", [nome]);
        await client.query("DELETE FROM produto_categorias WHERE categoria = $1", [nome]);
        await client.query("DELETE FROM pdv_categorias WHERE categoria = $1", [nome]);
        await client.query("UPDATE pdvs SET categoria = NULL WHERE categoria = $1", [nome]);
      });
      return send(res, 200, { ok: true });
    }
  }

  // Associa/remove categoria em lote para um ou mais produtos, ressincronizando a liberação por PDV
  if (url.pathname === "/api/admin/category-products" && method === "POST") {
    if (!requireUser(req, res, "admin")) return;
    const body = await readBody(req);
    const skus = Array.isArray(body.skus)
      ? [...new Set(body.skus.map((item) => normalizeText(item, 60)).filter(Boolean))]
      : [normalizeText(body.sku, 60)].filter(Boolean);
    const categoria = normalizeText(body.categoria, 120).toUpperCase() || null;
    const action = String(body.action || "").toLowerCase();
    if (!skus.length) return send(res, 400, { error: "Produto inválido." });
    await tx(async (client) => {
      if (action === "remove" || action === "delete") {
        for (const sku of skus) {
          if (categoria) {
            await client.query("DELETE FROM produto_categorias WHERE sku_produto = $1 AND categoria = $2", [sku, categoria]);
            await client.query(
              `UPDATE produtos p
               SET categoria = (
                 SELECT pc.categoria
                 FROM produto_categorias pc
                 WHERE pc.sku_produto = p.sku
                 ORDER BY pc.categoria
                 LIMIT 1
               )
               WHERE p.sku = $1 AND p.categoria = $2`,
              [sku, categoria]
            );
          } else {
            await client.query("DELETE FROM produto_categorias WHERE sku_produto = $1", [sku]);
            await client.query("UPDATE produtos SET categoria = NULL WHERE sku = $1", [sku]);
          }
        }
      } else {
        if (!categoria) return;
        await client.query(
          `INSERT INTO categorias (nome)
           VALUES ($1)
           ON CONFLICT (nome) DO NOTHING`,
          [categoria]
        );
        for (const sku of skus) {
          await client.query(
            `INSERT INTO produto_categorias (sku_produto, categoria)
             VALUES ($1, $2)
             ON CONFLICT (sku_produto, categoria) DO NOTHING`,
            [sku, categoria]
          );
          await client.query(
            `UPDATE produtos
             SET categoria = COALESCE(categoria, $2)
             WHERE sku = $1`,
            [sku, categoria]
          );
        }
      }
      const pdvs = await client.query("SELECT id FROM pdvs");
      for (const pdv of pdvs.rows) {
        await syncPdvAllowedProducts(client, pdv.id);
      }
    });
    return send(res, 200, { ok: true, total: skus.length });
  }

  // Painel gerencial: ranking de saídas por produto ou por PDV, tendência mensal e estatísticas
  if (url.pathname === "/api/admin/dashboard") {
    if (!requireUser(req, res, "admin")) return;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const sku = normalizeText(url.searchParams.get("sku"), 60);
    const productSearch = normalizeText(url.searchParams.get("q"), 120);
    const productSearchLike = productSearch ? `%${productSearch}%` : null;
    const rankingType = url.searchParams.get("ranking") === "pdv" ? "pdv" : "produto";
    const rows = rankingType === "pdv"
      ? await query(
        `SELECT pd.nome AS pdv, NULL::text AS sku, pd.nome AS produto,
                COUNT(DISTINCT COALESCE(
                  NULLIF(p.codigo_pedido, ''),
                  concat(p.pdv_id, '|', p.solicitante, '|', p.data_hora, '|', COALESCE(p.observacao, ''))
                ))::int AS total
         FROM pedidos p
         JOIN pdvs pd ON pd.id = p.pdv_id
         JOIN produtos pr ON pr.sku = p.sku_produto
         WHERE (CASE
                  WHEN p.status = 'Liberado' THEN 'Finalizado'
                  WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                  ELSE p.status
                END) = 'Finalizado'
           AND ($1::date IS NULL OR COALESCE(p.retirada_em, p.liberado_em, p.data_hora)::date >= $1::date)
           AND ($2::date IS NULL OR COALESCE(p.retirada_em, p.liberado_em, p.data_hora)::date <= $2::date)
           AND ($3::text IS NULL OR pr.nome ILIKE $3 OR pr.sku ILIKE $3)
         GROUP BY pd.nome
         ORDER BY total DESC
         LIMIT 20`,
        [from || null, to || null, productSearchLike]
      )
      : await query(
        `SELECT NULL::text AS pdv, pr.sku, pr.nome AS produto,
                SUM(COALESCE(NULLIF(p.quantidade_liberada, 0), p.quantidade_solicitada))::int AS total
         FROM pedidos p
         JOIN produtos pr ON pr.sku = p.sku_produto
         WHERE (CASE
                  WHEN p.status = 'Liberado' THEN 'Finalizado'
                  WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
                  ELSE p.status
                END) = 'Finalizado'
           AND ($1::date IS NULL OR COALESCE(p.retirada_em, p.liberado_em, p.data_hora)::date >= $1::date)
           AND ($2::date IS NULL OR COALESCE(p.retirada_em, p.liberado_em, p.data_hora)::date <= $2::date)
           AND ($3::text IS NULL OR pr.nome ILIKE $3 OR pr.sku ILIKE $3)
         GROUP BY pr.sku, pr.nome
         ORDER BY total DESC
         LIMIT 20`,
        [from || null, to || null, productSearchLike]
      );

    let selectedSku = sku || rows[0]?.sku || "";
    let selectedProduct = [];
    if (!selectedSku && productSearch) {
      selectedProduct = await query(
        `SELECT sku, nome
         FROM produtos
         WHERE sku ILIKE $1 OR nome ILIKE $2
         ORDER BY CASE WHEN sku ILIKE $1 THEN 0 ELSE 1 END, nome
         LIMIT 1`,
        [productSearch, productSearchLike]
      );
      selectedSku = selectedProduct[0]?.sku || "";
    }
    const productTrend = selectedSku ? await query(
      `SELECT to_char(months.month_start, 'YYYY-MM') AS mes,
              COALESCE(SUM(COALESCE(NULLIF(p.quantidade_liberada, 0), p.quantidade_solicitada)), 0)::int AS total
       FROM generate_series(
         date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
         date_trunc('month', CURRENT_DATE),
         INTERVAL '1 month'
       ) AS months(month_start)
       LEFT JOIN pedidos p
         ON p.sku_produto = $1
        AND (CASE
               WHEN p.status = 'Liberado' THEN 'Finalizado'
               WHEN p.status IN ('Liberado Parcial', 'Liberação Parcial') AND COALESCE(p.quantidade_liberada, 0) > 0 AND p.retirada_assinatura IS NOT NULL THEN 'Finalizado'
               ELSE p.status
             END) = 'Finalizado'
        AND date_trunc('month', COALESCE(p.retirada_em, p.liberado_em, p.data_hora)) = months.month_start
       GROUP BY months.month_start
       ORDER BY months.month_start`,
      [selectedSku]
    ) : [];

    if (selectedSku && !selectedProduct[0]) {
      selectedProduct = await query("SELECT sku, nome FROM produtos WHERE sku = $1", [selectedSku]);
    }
    const stats = (await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ativo = TRUE)::int AS ativos,
              COUNT(*) FILTER (WHERE ativo = FALSE)::int AS inativos
       FROM produtos`
    ))[0] || { total: 0, ativos: 0, inativos: 0 };
    return send(res, 200, { ranking: rows, rankingType, stats, selectedProduct: selectedProduct[0] || null, productTrend });
  }

  // Atualiza a senha do almoxarifado e/ou as credenciais do OMIE
  if (url.pathname === "/api/admin/config" && method === "POST") {
    if (!requireUser(req, res, "admin")) return;
    const body = await readBody(req);
    if (body.adminPassword) {
      const currentPassword = normalizeText(body.currentAdminPassword, 120);
      const nextPassword = normalizeText(body.adminPassword, 120);
      const confirmPassword = normalizeText(body.confirmAdminPassword, 120);
      if (!currentPassword) return send(res, 400, { error: "Informe a senha atual do almoxarifado." });
      if (nextPassword.length < 4) return send(res, 400, { error: "A nova senha deve ter pelo menos 4 caracteres." });
      if (!confirmPassword) return send(res, 400, { error: "Confirme a nova senha do almoxarifado." });
      if (nextPassword !== confirmPassword) return send(res, 400, { error: "A confirmação da senha não confere." });
      const rows = await query("SELECT valor FROM configuracoes WHERE chave = 'senha_almoxarifado'");
      if (!rows[0] || !verifyPassword(currentPassword, rows[0].valor)) return send(res, 401, { error: "Senha atual incorreta." });
      if (verifyPassword(nextPassword, rows[0].valor)) return send(res, 400, { error: "A nova senha deve ser diferente da senha atual." });
      await query(
        `INSERT INTO configuracoes (chave, valor) VALUES ('senha_almoxarifado', $1)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
        [hashPassword(nextPassword)]
      );
    }
    // Credenciais do OMIE nao sao mais gravadas em texto puro aqui: use a tela de
    // Integracoes (/api/admin/integrations), que criptografa com AES-256-GCM antes de persistir.
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "Rota não encontrada." });
}

// Decide por quanto tempo o navegador pode guardar cada arquivo estático.
//
// O index.html nunca é cacheado: é ele que aponta para as URLs versionadas (?v=...), então
// precisa estar sempre fresco para que um deploy novo seja notado. Já os arquivos pedidos COM
// ?v= podem ser guardados indefinidamente -- trocar a versão no index.html muda a URL e força
// o download do arquivo novo. Antes tudo vinha com no-store, o que fazia o navegador rebaixar
// ~1,9 MB (tailwind + xlsx + app.js + css) a cada abertura do sistema.
function cacheHeaderFor(url, extension) {
  if (extension === ".html") return "no-store";
  if (url.searchParams.has("v")) return "public, max-age=31536000, immutable";
  // Sem versão na URL (ex: fontes referenciadas de dentro do fonts.css, imagens): cache curto,
  // suficiente para evitar rebaixar a cada navegação sem segurar uma troca por muito tempo.
  return "public, max-age=3600";
}

// Tipos que valem comprimir. Fontes (.woff2), imagens (.png/.jpg) e .ico já são comprimidos
// no próprio formato -- gzipar de novo só gasta CPU sem reduzir nada.
const EXTENSOES_COMPRIMIVEIS = new Set([".html", ".css", ".js", ".json", ".svg"]);

// Guarda o conteúdo já comprimido dos estáticos: o app.js tem ~484 KB e seria gzipado de novo a
// cada primeira visita de cada navegador. A chave inclui o mtime, então editar o arquivo invalida.
const cacheEstaticosGzip = new Map();

// Comprime um arquivo estático quando faz sentido, reaproveitando o resultado entre requisições
function comprimirEstatico(res, caminho, extensao, conteudo) {
  if (!res.aceitaGzip || !EXTENSOES_COMPRIMIVEIS.has(extensao)) return { corpo: conteudo, headers: {} };
  let chave;
  try {
    chave = `${caminho}:${fs.statSync(caminho).mtimeMs}`;
  } catch {
    return comprimirSePossivel(res, conteudo);
  }
  const emCache = cacheEstaticosGzip.get(chave);
  if (emCache) return { corpo: emCache, headers: { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } };
  const { corpo, headers } = comprimirSePossivel(res, conteudo);
  // Só entra no cache se realmente comprimiu (arquivos pequenos passam direto)
  if (headers["Content-Encoding"]) cacheEstaticosGzip.set(chave, corpo);
  return { corpo, headers };
}

// Serve arquivos estáticos de /public; cai para index.html (SPA) quando o arquivo não existe
function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(publicDir, requested));
  // Impede path traversal para fora da pasta public
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (error, content) => {
    if (error) {
      fs.readFile(path.join(publicDir, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": mime[".html"], "Cache-Control": "no-store" });
        res.end(fallback);
      });
      return;
    }
    const extension = path.extname(file);
    const { corpo, headers } = comprimirEstatico(res, file, extension, content);
    res.writeHead(200, {
      "Content-Type": mime[extension] || "application/octet-stream",
      "Cache-Control": cacheHeaderFor(url, extension),
      "Content-Length": corpo.length,
      ...headers
    });
    res.end(corpo);
  });
}

let schemaReady;

// Garante que o schema seja aplicado apenas uma vez por processo (cacheado em memória)
function ensureSchemaOnce() {
  schemaReady ||= ensureSchema();
  return schemaReady;
}

// Ponto de entrada HTTP: healthcheck, sincronização de schema, API e arquivos estáticos
export async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Registra uma vez por requisição se o cliente aceita gzip; o send() e os estáticos consultam isso
  marcarSuporteGzip(req, res);
  if (url.pathname === "/api/health") {
    try {
      const result = await query("SELECT 1 AS ok");
      return send(res, 200, { ok: true, db: result[0]?.ok === 1 });
    } catch (error) {
      // Rota sem autenticação: o erro do driver traz usuário, host e porta do banco, então só o
      // detalhe vai para o log do servidor — a resposta fica genérica para quem está na rede
      console.error("Falha no healthcheck do banco:", error.message);
      return send(res, 500, { ok: false, error: "Falha na conexao com o banco." });
    }
  }

  // Servidor sempre ativo: sincroniza o schema uma única vez por processo (resultado fica em cache)
  await ensureSchemaOnce();

  if (req.url?.startsWith("/api/")) {
    api(req, res).catch((error) => {
      console.error(error);
      send(res, error.statusCode || 500, {
        error: error.code || error.message || "Erro interno.",
        message: error.message || "Erro interno.",
        existingRequest: error.existingRequest || null
      });
    });
  } else {
    serveStatic(req, res);
  }
}

// Sobe o servidor HTTP e inicia o agendador de sincronização OMIE
http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error(error);
    send(res, 500, { error: error.message || "Erro interno." });
  });
}).listen(port, () => {
  console.log(`MyEstoque web rodando em http://localhost:${port}`);
  startOmieScheduler();
});


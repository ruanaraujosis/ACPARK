// Escreve a unidade "UN" nos produtos que a comparacao (corrigir-unidade-omie.mjs) achou
// divergentes contra a OMIE ao vivo. Usa AlterarProduto, que faz merge parcial -- ja
// confirmado por medicao anterior (docs/INTEGRACOES.md, secao "Categorias <-> familias"):
// enviar so {codigo_produto, unidade} altera so esse campo, nada mais no cadastro muda.
//
// Tres modos, cada um so avanca com o anterior feito:
//   (padrao)              -- simulacao: monta os payloads, nao envia nada
//   --item=<sku> --executar -- aplica em UM produto so, releh e confere que so unidade mudou
//   --lote --executar       -- aplica no resto da lista (exige que --item ja tenha rodado)
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../server/db.js";
import { carregarComSegredos } from "../server/services/integrations/core/integration.repository.js";
import { chamarOmie, ENDPOINTS } from "../server/services/integrations/providers/omie/omie.api.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARQUIVO_COMPARACAO = "C:\\Users\\User\\Documents\\MyEstoque\\backups\\unidade-omie-comparacao-1790018997210.json";
const ARQUIVO_CONFIRMACAO = path.join(raiz, "backups", "unidade-omie-item-confirmado.json");
const UNIDADE_ALVO = "UN";
// Mais conservador que o padrao de leitura (fatores.js: 10 chamadas / 400ms) -- bati em
// "Consumo redundante detectado" nos testes manuais de hoje com poucas chamadas seguidas.
const CHAMADAS_ANTES_DA_PAUSA = 3;
const PAUSA_MS = 3000;
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const argv = process.argv.slice(2);
const executar = argv.includes("--executar");
const modoLote = argv.includes("--lote");
const itemArg = argv.find((a) => a.startsWith("--item="));
const skuUnico = itemArg ? itemArg.split("=")[1] : null;

function carregarDivergentes() {
  const dados = JSON.parse(fs.readFileSync(ARQUIVO_COMPARACAO, "utf8"));
  return dados.divergentes;
}

// So os campos que realmente podem ter mudado num ALTERAR bem-sucedido: unidade e o
// carimbo de alteracao. Qualquer outro campo diferente entre antes/depois e sinal de que
// o ALTERAR nao fez merge parcial de verdade -- e o motivo de conferir campo a campo, nao
// so "unidade bateu".
function camposQueDeveriamMudar() {
  return new Set(["unidade", "info"]);
}

function diffCampos(antes, depois) {
  const chaves = new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})]);
  const mudou = [];
  for (const chave of chaves) {
    const a = JSON.stringify(antes?.[chave]);
    const d = JSON.stringify(depois?.[chave]);
    if (a !== d) mudou.push(chave);
  }
  return mudou;
}

async function lerProduto(integracao, segredos, idExterno) {
  const resposta = await chamarOmie({
    integracao,
    segredos,
    endpoint: ENDPOINTS.PRODUTOS,
    call: "ConsultarProduto",
    params: { codigo_produto: Number(idExterno) || idExterno }
  });
  return resposta.dados;
}

async function alterarUnidade(integracao, segredos, idExterno) {
  return chamarOmie({
    integracao,
    segredos,
    endpoint: ENDPOINTS.PRODUTOS,
    call: "AlterarProduto",
    params: { codigo_produto: Number(idExterno) || idExterno, unidade: UNIDADE_ALVO }
  });
}

async function principal() {
  const divergentes = carregarDivergentes();
  console.log(`${divergentes.length} produtos divergentes carregados de ${path.basename(ARQUIVO_COMPARACAO)}.`);

  const { integracao, segredos } = await carregarComSegredos(pool, 1);

  // ===== Modo item unico =====
  if (skuUnico) {
    const item = divergentes.find((d) => d.sku === skuUnico);
    if (!item) {
      console.error(`SKU ${skuUnico} nao esta na lista de divergentes.`);
      await pool.end();
      process.exit(1);
    }

    console.log(`\n=== Item unico: ${item.sku} (id ${item.idExterno}) ===`);
    console.log(`OMIE atual: "${item.unidadeAoVivo}" -> alvo: "${UNIDADE_ALVO}"`);

    if (!executar) {
      console.log(`\nPayload que seria enviado (AlterarProduto):`);
      console.log(JSON.stringify({ codigo_produto: Number(item.idExterno), unidade: UNIDADE_ALVO }, null, 2));
      console.log("\n(SIMULACAO -- rode com --item=" + skuUnico + " --executar para aplicar)");
      await pool.end();
      return;
    }

    console.log("\nLendo estado ANTES...");
    const antes = await lerProduto(integracao, segredos, item.idExterno);

    console.log("Aplicando AlterarProduto...");
    await alterarUnidade(integracao, segredos, item.idExterno);

    console.log("Lendo estado DEPOIS...");
    const depois = await lerProduto(integracao, segredos, item.idExterno);

    const mudou = diffCampos(antes, depois);
    const esperado = camposQueDeveriamMudar();
    const inesperado = mudou.filter((c) => !esperado.has(c));

    console.log(`\nCampos que mudaram: ${mudou.join(", ") || "nenhum"}`);
    if (inesperado.length) {
      console.log(`\n!!! ATENCAO: campo(s) fora do esperado mudaram: ${inesperado.join(", ")}`);
      console.log("NAO prosseguir para o lote sem investigar isso.");
    } else if (depois.unidade !== UNIDADE_ALVO) {
      console.log(`\n!!! ATENCAO: unidade nao ficou "${UNIDADE_ALVO}" -- ficou "${depois.unidade}".`);
    } else {
      console.log(`\nOK: só unidade (e o carimbo de alteração) mudaram. "${antes.unidade}" -> "${depois.unidade}".`);
      fs.writeFileSync(ARQUIVO_CONFIRMACAO, JSON.stringify({ sku: item.sku, idExterno: item.idExterno, confirmadoEm: new Date().toISOString(), antes, depois }, null, 2));
      console.log(`Confirmação salva em ${ARQUIVO_CONFIRMACAO} -- agora o lote pode rodar.`);
    }
    await pool.end();
    return;
  }

  // ===== Modo lote =====
  if (modoLote) {
    if (!fs.existsSync(ARQUIVO_CONFIRMACAO)) {
      console.error("Nenhum item unico confirmado ainda. Rode primeiro: --item=<sku> --executar");
      await pool.end();
      process.exit(1);
    }
    const confirmacao = JSON.parse(fs.readFileSync(ARQUIVO_CONFIRMACAO, "utf8"));
    const restantes = divergentes.filter((d) => d.sku !== confirmacao.sku);
    console.log(`\nItem já confirmado: ${confirmacao.sku}. Restam ${restantes.length} produtos no lote.`);

    if (!executar) {
      console.log("\nPayloads que seriam enviados:");
      for (const item of restantes) {
        console.log(`  ${item.sku} (id ${item.idExterno}): "${item.unidadeAoVivo}" -> "${UNIDADE_ALVO}"`);
      }
      console.log("\n(SIMULACAO -- rode com --lote --executar para aplicar)");
      await pool.end();
      return;
    }

    const relatorio = [];
    let chamadas = 0;
    for (const item of restantes) {
      try {
        await alterarUnidade(integracao, segredos, item.idExterno);
        relatorio.push({ sku: item.sku, idExterno: item.idExterno, de: item.unidadeAoVivo, para: UNIDADE_ALVO, status: "OK" });
        console.log(`  OK  ${item.sku}: "${item.unidadeAoVivo}" -> "${UNIDADE_ALVO}"`);
      } catch (erro) {
        relatorio.push({ sku: item.sku, idExterno: item.idExterno, de: item.unidadeAoVivo, status: "ERRO", erro: erro.message });
        console.log(`  ERRO ${item.sku}: ${erro.message}`);
      }
      chamadas += 1;
      if (chamadas % CHAMADAS_ANTES_DA_PAUSA === 0) await dormir(PAUSA_MS);
    }

    const sucesso = relatorio.filter((r) => r.status === "OK").length;
    const falha = relatorio.filter((r) => r.status === "ERRO").length;
    console.log(`\n=== Lote concluído: ${sucesso} OK, ${falha} erro(s) ===`);

    const saida = path.join(raiz, "backups", `unidade-omie-lote-${Date.now()}.json`);
    fs.writeFileSync(saida, JSON.stringify({ itemUnico: confirmacao.sku, relatorio }, null, 2));
    console.log(`Relatório completo salvo em: ${saida}`);
    await pool.end();
    return;
  }

  // ===== Sem --item nem --lote: mostra a lista e como usar =====
  console.log("\nUse:");
  console.log("  node tools/corrigir-unidade-omie-escrever.mjs --item=<sku>              (simulação de 1 item)");
  console.log("  node tools/corrigir-unidade-omie-escrever.mjs --item=<sku> --executar   (aplica em 1 item)");
  console.log("  node tools/corrigir-unidade-omie-escrever.mjs --lote                    (simulação do lote)");
  console.log("  node tools/corrigir-unidade-omie-escrever.mjs --lote --executar         (aplica o lote, exige item confirmado)");
  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

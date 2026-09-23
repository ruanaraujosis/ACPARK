// Compara a unidade de medida que a planilha do relatorio de estoque diz ser a correta
// (relatorio_sku_unidade.tsv) contra o cadastro AO VIVO na OMIE (ConsultarProduto, nunca o
// espelho local em product_integration_mappings.unit -- esse so atualiza quando a tarefa
// PRODUTOS roda, e pode estar desatualizado).
//
// So essa parte -- leitura e comparacao. Nao escreve nada na OMIE. Escrita fica pra um
// segundo script (corrigir-unidade-omie-escrever.mjs), depois de confirmado o comportamento
// de merge parcial do AlterarProduto com 1 item e aprovacao explicita do usuario.
import "../server/env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "../server/db.js";
import { carregarComSegredos } from "../server/services/integrations/core/integration.repository.js";
import { chamarOmie, ENDPOINTS } from "../server/services/integrations/providers/omie/omie.api.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSV = "C:\\Users\\User\\AppData\\Local\\Temp\\relatorio_sku_unidade.tsv";
const CALL = "ConsultarProduto";
const CHAMADAS_ANTES_DA_PAUSA = 10;
const PAUSA_MS = 400;
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizarUnidade = (v) => String(v || "").trim().toUpperCase();

async function principal() {
  const linhas = fs.readFileSync(TSV, "utf8").split(/\r?\n/).filter(Boolean);
  const alvo = linhas.map((linha) => {
    const [sku, unidade] = linha.split("\t");
    return { sku: sku.trim(), unidadeAlvo: unidade.trim() };
  });
  console.log(`${alvo.length} produtos na planilha.`);

  const { integracao, segredos } = await carregarComSegredos(pool, 1);

  const mapeamentos = await query(
    `SELECT sku_produto, external_product_id FROM product_integration_mappings
     WHERE integration_id = 1 AND sku_produto = ANY($1::text[])`,
    [alvo.map((a) => a.sku)]
  );
  const idPorSku = new Map(mapeamentos.map((m) => [m.sku_produto, m.external_product_id]));

  const semVinculo = alvo.filter((a) => !idPorSku.get(a.sku));
  if (semVinculo.length) {
    console.log(`\nAVISO: ${semVinculo.length} SKU(s) sem vinculo com a OMIE (sem external_product_id):`);
    for (const s of semVinculo) console.log(`  ${s.sku}`);
  }

  const resultados = [];
  let chamadas = 0;
  for (const item of alvo) {
    const idExterno = idPorSku.get(item.sku);
    if (!idExterno) {
      resultados.push({ ...item, status: "SEM_VINCULO" });
      continue;
    }
    try {
      const resposta = await chamarOmie({
        integracao,
        segredos,
        endpoint: ENDPOINTS.PRODUTOS,
        call: CALL,
        params: { codigo_produto: Number(idExterno) || idExterno }
      });
      const produto = resposta.dados;
      const unidadeAoVivo = produto?.unidade || produto?.codigo_unidade || "";
      resultados.push({
        sku: item.sku,
        idExterno,
        unidadeAlvo: item.unidadeAlvo,
        unidadeAoVivo,
        divergente: normalizarUnidade(item.unidadeAlvo) !== normalizarUnidade(unidadeAoVivo),
        status: "OK"
      });
    } catch (erro) {
      resultados.push({ ...item, status: "ERRO", erro: erro.message });
    }

    chamadas += 1;
    if (chamadas % CHAMADAS_ANTES_DA_PAUSA === 0) {
      process.stdout.write(`  ${chamadas}/${alvo.length} lidos...\r`);
      await dormir(PAUSA_MS);
    }
  }

  const divergentes = resultados.filter((r) => r.status === "OK" && r.divergente);
  const iguais = resultados.filter((r) => r.status === "OK" && !r.divergente);
  const erros = resultados.filter((r) => r.status === "ERRO");

  console.log(`\n\n=== Resultado ===`);
  console.log(`Iguais (nada a fazer): ${iguais.length}`);
  console.log(`Divergentes (candidatos a correcao): ${divergentes.length}`);
  console.log(`Erros de leitura: ${erros.length}`);
  console.log(`Sem vinculo com a OMIE: ${semVinculo.length}`);

  if (divergentes.length) {
    console.log(`\nDivergentes:`);
    for (const d of divergentes) {
      console.log(`  ${d.sku} (id ${d.idExterno}): OMIE="${d.unidadeAoVivo}" -> planilha="${d.unidadeAlvo}"`);
    }
  }
  if (erros.length) {
    console.log(`\nErros:`);
    for (const e of erros) console.log(`  ${e.sku}: ${e.erro}`);
  }

  const saida = path.join(raiz, "backups", `unidade-omie-comparacao-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, JSON.stringify({ resultados, divergentes, iguais: iguais.length, erros }, null, 2));
  console.log(`\nResultado completo salvo em: ${saida}`);

  await pool.end();
}

principal().catch(async (erro) => {
  console.error("Falha:", erro.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

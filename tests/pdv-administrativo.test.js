import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");

// Comentário longo quebra em várias linhas com "//" no meio, então uma frase inteira nunca
// casa contra o texto cru. Achatar a continuação é o que estas asserções realmente querem
// dizer: "esta frase está no arquivo", não "está numa única linha".
const achatado = (src) => src.replace(/\n\s*\/\/\s*/g, " ").replace(/\s+/g, " ");
const servico = ler("server/services/pdvs/pdv-administrativo.service.js");
const index = ler("server/index.js");
const pedidos = ler("server/modules/pedidos/pedidos.routes.js");
const estoque = ler("server/modules/estoque/estoque.routes.js");

test("a razão de negócio fica registrada junto da regra", () => {
  // "PDV Administrativo" não é ponto de venda: é setor interno que consome estoque sem
  // vender. Quem ler o código depois precisa entender o motivo, não só o mecanismo.
  assert.match(achatado(servico), /NÃO é ponto de venda/);
  assert.match(achatado(servico), /consomem estoque sem vender/);
  assert.match(achatado(pedidos), /nao e ponto de venda: e um setor interno/i);
});

test("a tag tem campo próprio; is_cozinha não foi reaproveitado", () => {
  // is_cozinha está morto (as rotas de criar/editar gravam `false` fixo), então herdá-lo
  // seria construir sobre algo que ninguém mantém.
  assert.match(servico, /ADD COLUMN IF NOT EXISTS administrativo BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(achatado(servico), /`is_cozinha` NÃO foi reaproveitado/);
  assert.match(index, /INSERT INTO pdvs \(nome, senha, codigo_orion, is_cozinha, administrativo, categoria\)/);
});

test("estoque_pdv continua sendo a permissão — o que muda é o crédito", () => {
  // Tirar as linhas quebraria a criação de pedido, que exige permitido = TRUE.
  assert.match(pedidos, /if \(!administrativos\.has\(row\.pdv_id\)\) \{/);
  assert.match(achatado(pedidos), /ela libera, nunca acumula/);
  // syncPdvAllowedProducts segue semeando para qualquer PDV, sem ramificação
  const serv = ler("server/modules/estoque/estoque.service.js");
  assert.doesNotMatch(serv, /administrativo/, "a semeadura de permissão não distingue perfil");
});

test("o perfil é consultado uma vez por pedido, não por item", () => {
  // Desde 23/09/2026 a movimentação da retirada mora em baixarEstoqueDaRetirada (usada também
  // pela transferência rápida); o laço que importa é o da baixa, não o de validação da origem
  const bloco = pedidos.slice(pedidos.indexOf("async function baixarEstoqueDaRetirada"));
  const posConsulta = bloco.indexOf("const administrativos = await pdvsAdministrativos(client");
  const posLaco = bloco.indexOf("for (const row of targetRows)", bloco.indexOf("// Baixa definitiva"));
  assert.ok(posConsulta > -1 && posConsulta < posLaco, "a consulta precisa vir antes do laço");
});

test("PDV administrativo não gera transferência TRF", () => {
  // Não há local de destino: a mercadoria sai da empresa como consumo. Mandar TRF faria a
  // OMIE acreditar que o estoque continua na empresa, só que em outro lugar.
  assert.match(pedidos, /const itensDeRevenda = targetRows\.filter\(\(row\) => !administrativos\.has\(row\.pdv_id\)\)/);
  assert.match(pedidos, /itens: itensDeRevenda\.map/);
  assert.match(achatado(pedidos), /nao ha transferencia entre locais/);
});

test("a saída por consumo é enfileirada, mas o envio segue travado pelo motivo", () => {
  // Mudou em 30/08/2026: antes nada era enfileirado enquanto o motivo não fosse conhecido.
  // Agora o levantamento está feito — o domínio de `motivo` para tipo SAI na OMIE tem quatro
  // valores (INV, PER, OPS, PDV) e NENHUM significa consumo interno. Como a escolha continua
  // sendo do usuário, o lançamento passa a ser registrado e o payload montado (para o
  // histórico não começar do zero no dia da decisão), mas o envio permanece travado.
  //
  // PER (perda) segue recusado: perda e consumo administrativo são coisas diferentes para
  // relatório fiscal e gerencial. Reaproveitar inflaria o relatório de perdas.
  assert.match(pedidos, /registrarConsumoAdministrativo\(client, \{/);
  assert.match(achatado(pedidos), /nenhum significa consumo interno/);
  const bloco = pedidos.slice(pedidos.indexOf("itensAdministrativos"), pedidos.indexOf("itensAdministrativos") + 1600);
  assert.doesNotMatch(bloco, /"PER"/, "não pode cair no motivo de perda por semelhança");
});

test("a reposição automática exclui o administrativo explicitamente", () => {
  // Confiar em estoque_maximo ficar zerado por acaso deixaria um máximo configurado por
  // engano disparar autopedido para um perfil que nunca deveria ter reposição.
  const bloco = index.slice(index.indexOf("async function runAutoOrders"));
  assert.match(bloco, /JOIN pdvs pdv ON pdv\.id = e\.pdv_id AND pdv\.administrativo = FALSE/);
  assert.match(achatado(bloco), /confiar em `estoque_maximo` ficar zerado por acaso/);
});

test("a tela de saldo trata ausência como ausência, não como zero", () => {
  // Zero significaria "acabou o estoque", e a tela mostraria um número que nunca muda.
  assert.match(estoque, /if \(pdv\?\.administrativo\) \{/);
  assert.match(estoque, /sem_saldo: true/);
  assert.match(achatado(estoque), /zero significaria/);
});

test("a lista de produtos do PDV continua vindo, marcada com o perfil", () => {
  // A mesma rota alimenta a tela de pedido, que precisa da lista para o PDV pedir.
  assert.match(estoque, /administrativo: perfil\[0\]\?\.administrativo === true/);
});

test("virar administrativo com saldo é recusado enquanto a regra não é aprovada", () => {
  // Zerar por conta própria aplicaria uma regra não aprovada; deixar o saldo parado criaria
  // estoque fantasma num perfil que não mostra tela de saldo.
  assert.match(achatado(index), /PENDENTE DE DECISAO: virar administrativo com saldo residual/);
  assert.match(index, /A regra de baixa do saldo ao virar administrativo está em definição/);
  const bloco = index.slice(index.indexOf("const eraAdministrativo"), index.indexOf("const eraAdministrativo") + 1200);
  assert.match(bloco, /if \(administrativo && !eraAdministrativo\)/, "só a transição para administrativo é barrada");
  assert.doesNotMatch(bloco, /UPDATE estoque_pdv SET quantidade = 0/, "nada é zerado sem aprovação");
});

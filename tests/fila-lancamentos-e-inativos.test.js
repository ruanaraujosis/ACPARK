import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ehAjusteJaExistente,
  idDoAjusteJaExistente
} from "../server/services/integrations/providers/omie/omie.api.js";
import { LIMITE_TENTATIVAS } from "../server/services/integrations/core/stock-launches.repository.js";

// Tres correcoes medidas contra a producao em 21/09/2026:
//  1. produto inativo nao pode aparecer para o PDV pedir;
//  2. ajuste que ja existe na OMIE e sucesso, nao erro eterno;
//  3. saldo velho so e divergencia quando alguem esta atualizando saldo de PDV.

const ler = (caminho) => fs.readFileSync(caminho, "utf8").split("\r\n").join("\n");

test("nenhum caminho de pedido oferece produto inativo ao PDV", () => {
  // Oito retiradas de set/2026 so falharam na OMIE ("O cadastro deste produto esta inativo"),
  // depois de o pedido ja ter sido feito, separado e retirado. As duas rotas de pedido ja
  // filtravam; o que faltava era a tela de estoque do almoxarifado e a marca `permitido`.
  const rotas = ler("server/modules/estoque/estoque.routes.js");

  const pdv = rotas.slice(rotas.indexOf("/api/pdv/products"), rotas.indexOf("/api/admin/stock"));
  assert.match(pdv, /p\.ativo = TRUE/, "a lista que o PDV usa para pedir nao pode mostrar item inativo");

  const admin = rotas.slice(rotas.indexOf("FROM produtos p"));
  assert.match(admin, /WHERE p\.ativo IS NOT FALSE/, "a tela de estoque por PDV tambem nao deve listar item inativo");

  const auto = ler("server/index.js");
  const reposicao = auto.slice(auto.indexOf("FROM estoque_pdv e"), auto.indexOf("FROM pedidos"));
  assert.match(reposicao, /p\.ativo = TRUE/, "a reposicao automatica nunca pode pedir item inativo");
});

test("produto inativo nunca fica permitido no estoque do PDV", () => {
  const servico = ler("server/modules/estoque/estoque.service.js");
  const liberacao = servico.slice(servico.indexOf("INSERT INTO estoque_pdv"), servico.indexOf("ON CONFLICT"));
  assert.match(liberacao, /WHERE p\.ativo IS NOT FALSE/, "a liberacao por categoria nao pode liberar item inativo");

  const bloqueio = servico.slice(servico.indexOf("UPDATE estoque_pdv e"));
  assert.match(bloqueio, /AND p\.ativo IS NOT FALSE/, "produto que virou inativo precisa perder a permissao");
});

test("ajuste que ja existe na OMIE e reconhecido como envio aceito", () => {
  const erro = new Error(
    "ERROR: Já existe um ajuste de estoque para o código de integração [PEDIDO-PED-1-ITEM-7443-RETIRADA-V1] com o ID 4577812345 !"
  );
  assert.equal(ehAjusteJaExistente(erro), true);
  assert.equal(idDoAjusteJaExistente(erro), "4577812345");
  assert.equal(ehAjusteJaExistente(new Error("ERROR: O cadastro deste produto está inativo")), false);
});

test("as tres tarefas de escrita marcam o ajuste duplicado como ENVIADO, nao como erro", () => {
  for (const tarefa of ["transferencias", "consumo-administrativo", "inventarios"]) {
    const src = ler(`server/services/integrations/providers/omie/tarefas/${tarefa}.js`);
    const ramo = src.slice(src.indexOf("if (ehAjusteJaExistente(erro))"));
    assert.ok(ramo.startsWith("if (ehAjusteJaExistente(erro))"), `${tarefa} nao trata ajuste ja existente`);
    assert.match(ramo.slice(0, 400), /status: lancamentos\.STATUS\.ENVIADO/, `${tarefa} deveria marcar ENVIADO`);
    assert.match(ramo.slice(0, 400), /externalId: idDoAjusteJaExistente\(erro\)/, `${tarefa} perde a rastreabilidade do ajuste`);
  }
});

test("a fila para de retentar depois do limite, e so acao humana reprocessa", () => {
  // Oito retiradas de produto inativo chegaram a 923 tentativas, gastando chamadas da API
  // (25 respostas HTTP 429 e cinco bloqueios por consumo no mesmo periodo).
  assert.ok(LIMITE_TENTATIVAS > 0 && LIMITE_TENTATIVAS <= 50, "limite precisa ser um numero pequeno e explicito");
  const repo = ler("server/services/integrations/core/stock-launches.repository.js");
  const consulta = repo.slice(repo.indexOf("export async function listarAbertos"), repo.indexOf("return resultado.rows;"));
  assert.match(consulta, /status <> 'ERRO' OR COALESCE\(tentativas, 0\) < \$6/);
  assert.match(
    consulta,
    /\$4::bigint IS NOT NULL OR status <> 'ERRO'/,
    "reprocessar um item escolhido a mao tem de continuar funcionando, mesmo esgotado"
  );
  assert.match(repo, /export async function contarEsgotados/, "o alerta precisa saber quantos pararam");
});

test("saldo desatualizado so conta como divergencia com a sincronizacao de PDV ligada", () => {
  // Com SALDOS fora do relogio, toda linha de estoque_pdv e velha por definicao: eram 5.000
  // divergencias por execucao, 330.000 acumuladas, todas do mesmo tipo.
  const src = ler("server/services/integrations/providers/omie/tarefas/reconciliacao.js");
  assert.match(src, /import \{ SINCRONIZACAO_PDV_ATIVA \} from "\.\.\/omie\.politica\.js";/);
  assert.match(src, /const conferirDesatualizado = SINCRONIZACAO_PDV_ATIVA;/);
  assert.match(src, /\$6::boolean AND \(/, "a checagem de saldo velho precisa estar dentro da condicao");
  assert.match(src, /saldo_desatualizado_conferido: conferirDesatualizado/, "o resumo tem de dizer o que foi conferido");

  // As duas divergencias que importam continuam sendo olhadas sempre
  const condicao = src.slice(src.indexOf("WHERE e.permitido = TRUE"), src.indexOf("LIMIT 5000"));
  assert.match(condicao, /COALESCE\(e\.saldo_omie, 0\) < 0/);
  assert.match(condicao, /COALESCE\(e\.quantidade_reservada_acpark, 0\) > COALESCE\(e\.saldo_omie, 0\)/);
});

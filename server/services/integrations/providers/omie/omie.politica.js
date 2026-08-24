// Interruptor unico do lado PDV da sincronizacao de estoque.
//
// Existe porque o estoque do PDV pode ser escrito por DOIS caminhos:
//
//   1. a capacidade SALDOS, que o agendador dispara pelo relogio; e
//   2. a capacidade SALDO_ITEM, que a tarefa de MOVIMENTOS enfileira sozinha sempre que
//      detecta movimento novo -- e MOVIMENTOS roda a cada 5 minutos.
//
// Deixar so a SALDOS desligada nao bastava: assim que existissem vinculos de PDV, o caminho
// 2 passaria a gravar estoque_pdv automaticamente, furando o bloqueio pela porta dos fundos.
// Com o interruptor aqui, os dois caminhos obedecem a mesma decisao e nao tem como divergir.
//
// Situacao atual: as transferencias ALMOXARIFADO -> PDV comecaram a ser lancadas na OMIE,
// mas a baixa de venda ainda nao -- o sistema de vendas sera integrado depois. Enquanto so
// a entrada e lancada, o saldo de PDV na OMIE nao reflete o consumo.
//
// Mude para true quando as duas condicoes valerem:
//   1. todas as saidas do almoxarifado para PDV lancadas na OMIE; e
//   2. o sistema de vendas dando baixa no local do PDV que vendeu.
export const SINCRONIZACAO_PDV_ATIVA = false;

// O estoque central nao depende do interruptor: o local do almoxarifado ja e a fonte da
// verdade hoje, e e dele que sai o saldo que a liberacao de pedido debita.
export const SINCRONIZACAO_CENTRAL_ATIVA = true;

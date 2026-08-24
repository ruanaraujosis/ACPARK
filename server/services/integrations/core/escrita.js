import { CODIGOS_ERRO, IntegrationError } from "./errors.js";

// Trava de escrita, generica para qualquer provider.
//
// Uma capacidade que declara `escrita: true` no manifesto altera dados no sistema EXTERNO.
// Diferente da leitura, um erro aqui nao se conserta rodando de novo: o lancamento ja saiu.
// Por isso toda capacidade de escrita nasce em SIMULACAO -- monta o payload, registra em
// auditoria e nao envia -- e so passa a enviar de verdade quando alguem desliga a simulacao
// explicitamente na configuracao daquela integracao.
//
// O nucleo nao sabe o que a capacidade escreve nem em qual API; sabe apenas que ela escreve.
// Quem decide o que fazer com o payload em modo simulacao e o provider.

// Chave de configuracao, por integracao, que libera o envio real
export const CHAVE_MODO_ESCRITA = "modo_escrita";

export const MODOS_ESCRITA = Object.freeze({
  SIMULACAO: "SIMULACAO",
  REAL: "REAL"
});

// Le o modo de escrita da integracao. O padrao e SIMULACAO de proposito: uma configuracao
// ausente, vazia ou com valor desconhecido nunca pode significar "pode enviar".
export function modoDeEscrita(configuracao = {}) {
  const bruto = String(configuracao?.[CHAVE_MODO_ESCRITA] || "")
    .trim()
    .toUpperCase();
  return bruto === MODOS_ESCRITA.REAL ? MODOS_ESCRITA.REAL : MODOS_ESCRITA.SIMULACAO;
}

export function emSimulacao(configuracao = {}) {
  return modoDeEscrita(configuracao) !== MODOS_ESCRITA.REAL;
}

// Recusa executar uma capacidade de escrita cuja integracao esteja inativa.
// Uma leitura numa integracao desligada e apenas inutil; uma escrita e perigosa.
export function validarEscritaPermitida(capacidade, integracao) {
  if (!capacidade?.escrita) return;
  if (integracao?.ativo === false) {
    throw new IntegrationError(
      `A integracao "${integracao?.nome || integracao?.provedor}" esta desativada, entao nenhum lancamento pode ser enviado.`,
      { codigo: CODIGOS_ERRO.CONFIGURACAO, status: 400 }
    );
  }
}

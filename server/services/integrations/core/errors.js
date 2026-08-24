// Erro de dominio unico para qualquer integracao (OMIE ou futuras).
//
// O "codigo" e o que decide o destino do job: erro de configuracao/autenticacao nao adianta
// repetir, erro temporario sim. Antes isso era inferido por regex na mensagem, o que fazia
// falha de rede virar "erro de dados" e vice-versa.
export const CODIGOS_ERRO = Object.freeze({
  CONFIGURACAO: "CONFIGURACAO",
  AUTENTICACAO: "AUTENTICACAO",
  TEMPORARIO: "TEMPORARIO",
  DADOS: "DADOS",
  FALHA: "FALHA"
});

// Traduz o codigo do erro para o status que o job recebe na tabela integration_jobs
export const STATUS_POR_CODIGO = Object.freeze({
  CONFIGURACAO: "ERRO_CONFIGURACAO",
  AUTENTICACAO: "ERRO_AUTENTICACAO",
  TEMPORARIO: "ERRO_TEMPORARIO",
  DADOS: "ERRO_DADOS",
  FALHA: "ERRO_TEMPORARIO"
});

export class IntegrationError extends Error {
  constructor(mensagem, { codigo = CODIGOS_ERRO.FALHA, status = 500, retentavel = false, detalhes = null } = {}) {
    super(mensagem);
    this.name = "IntegrationError";
    this.codigo = codigo;
    this.status = status;
    this.retentavel = retentavel;
    this.detalhes = detalhes;
  }

  // Status do job correspondente a este erro
  get statusJob() {
    return STATUS_POR_CODIGO[this.codigo] || "ERRO_TEMPORARIO";
  }
}

// Converte um erro qualquer (inclusive os que nao sao IntegrationError) em IntegrationError
export function comoIntegrationError(erro) {
  if (erro instanceof IntegrationError) return erro;
  const mensagem = String(erro?.message || erro || "Falha desconhecida na integracao.");
  // Falha de rede/DNS/socket e sempre transitoria: vale nova tentativa
  const rede = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(mensagem);
  return new IntegrationError(mensagem, {
    codigo: rede ? CODIGOS_ERRO.TEMPORARIO : CODIGOS_ERRO.FALHA,
    retentavel: rede
  });
}

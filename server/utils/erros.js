// Separa erro técnico (banco, sistema operacional, bug de programação) de mensagem de negócio.
//
// Antes, o handler central devolvia `error.message` de qualquer erro. Assim chegavam ao
// navegador textos do PostgreSQL ("coluna p.administrativo não existe", "duplicar valor da
// chave viola a restrição de unicidade \"pdvs_nome_key\""), caminhos completos do disco do
// servidor (ENOENT) e falhas de conexão do pool -- detalhe que só ajuda quem quer mapear o
// sistema. As mensagens de negócio (`throw new Error("Pedido não encontrado.")`) continuam
// chegando ao usuário como antes.

// Mensagem padrão para qualquer falha técnica
export const MENSAGEM_ERRO_INTERNO = "Erro interno no servidor. Tente novamente; se persistir, avise o suporte.";

// Falhas de conexão do pg/pg-pool chegam como `Error` comum, sem código: só dá para
// reconhecer pelo texto (fixo, em inglês, definido pela biblioteca)
const CONEXAO_BANCO =
  /^(Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|Cannot use a pool after calling end|Client was closed and is not queryable)/i;

// Erros nativos do JavaScript indicam bug no código, nunca algo que o usuário possa corrigir
const ERROS_NATIVOS = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError];

// Erro do PostgreSQL: tem SQLSTATE de 5 caracteres e o campo `severity` do protocolo
function ehErroDoBanco(erro) {
  return typeof erro.severity === "string" && typeof erro.code === "string" && /^[0-9A-Z]{5}$/.test(erro.code);
}

// O erro carrega detalhe técnico que não pode ir para o cliente?
export function ehErroInterno(erro) {
  if (!erro || typeof erro !== "object") return true;
  // Lançado de propósito pelo código com status HTTP ou marcado como público: é mensagem de negócio
  if (Number.isInteger(erro.statusCode) || erro.expose === true) return false;
  if (ehErroDoBanco(erro)) return true;
  // Erro de sistema do Node (ENOENT, ECONNREFUSED...): traz caminho de arquivo, host ou porta
  if (typeof erro.syscall === "string" || typeof erro.errno === "number") return true;
  if (ERROS_NATIVOS.some((Classe) => erro instanceof Classe)) return true;
  if (CONEXAO_BANCO.test(String(erro.message || ""))) return true;
  return false;
}

// Traduz os erros do banco que o usuário consegue entender e resolver; o resto vira 500 genérico
function respostaParaErroDoBanco(erro) {
  switch (erro.code) {
    case "23505":
      return { status: 409, mensagem: "Já existe um cadastro com esses dados." };
    case "23503":
      return { status: 409, mensagem: "Um item usado nesta operação foi alterado ou removido. Recarregue e tente de novo." };
    case "23502":
    case "22P02":
    case "22003":
    case "22001":
      return { status: 400, mensagem: "Algum valor informado é inválido ou está fora do formato esperado." };
    case "40P01":
    case "40001":
      return { status: 409, mensagem: "Outra operação estava alterando os mesmos dados. Tente de novo." };
    default:
      return { status: 500, mensagem: MENSAGEM_ERRO_INTERNO };
  }
}

// Monta status e corpo da resposta de erro. Erro técnico: só mensagem genérica (o detalhe fica
// no log). Erro de negócio: mesmo formato de antes, para não mudar o que as telas esperam.
export function respostaDeErro(erro, { mensagemPadrao = MENSAGEM_ERRO_INTERNO } = {}) {
  if (ehErroInterno(erro)) {
    const { status, mensagem } = erro && ehErroDoBanco(erro)
      ? respostaParaErroDoBanco(erro)
      : { status: 500, mensagem: mensagemPadrao };
    return { status, corpo: { error: mensagem, message: mensagem } };
  }
  const status = Number.isInteger(erro.statusCode) && erro.statusCode >= 400 && erro.statusCode < 600 ? erro.statusCode : 500;
  return {
    status,
    corpo: {
      error: erro.code || erro.message || mensagemPadrao,
      message: erro.message || mensagemPadrao,
      existingRequest: erro.existingRequest || null
    }
  };
}

// Só a mensagem segura para o cliente (para rotas que montam o próprio corpo de erro)
export function mensagemPublica(erro, mensagemPadrao = MENSAGEM_ERRO_INTERNO) {
  return respostaDeErro(erro, { mensagemPadrao }).corpo.message;
}

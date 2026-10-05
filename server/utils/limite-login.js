// Limite de tentativas de senha por IP: protege contra força bruta.
//
// Vale para TODO lugar que confere senha, não só para a tela de login. Antes, o login tinha o
// limite, mas a reconfirmação da senha do almoxarifado (devoluções de avaria, troca de senha)
// conferia a mesma senha sem limite nenhum: quem pegasse uma sessão de admin aberta podia
// testar senhas à vontade por ali e sair com a senha, que vale bem mais que as 8h do cookie.
//
// 3 tentativas erradas por IP a cada 5 minutos (decisão do usuário em 02/10/2026; antes eram 8).
// O contador é por IP e soma login do MyEstoque, login do MyControl e reconfirmações de senha.
const MAX_TENTATIVAS = 3;
const JANELA_MS = 5 * 60 * 1000;
const tentativas = new Map();

// IP de quem fez a requisição (o serviço atende direto na LAN, sem proxy na frente)
export function ipDaRequisicao(req) {
  return req?.socket?.remoteAddress || "desconhecido";
}

// O IP estourou o limite de tentativas falhas na janela atual?
export function isLoginRateLimited(ip) {
  const registro = tentativas.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.firstAttemptAt > JANELA_MS) {
    tentativas.delete(ip);
    return false;
  }
  return registro.count >= MAX_TENTATIVAS;
}

// Conta uma tentativa de senha errada para o IP
export function registerLoginFailure(ip) {
  const registro = tentativas.get(ip);
  if (!registro || Date.now() - registro.firstAttemptAt > JANELA_MS) {
    tentativas.set(ip, { count: 1, firstAttemptAt: Date.now() });
    return;
  }
  registro.count += 1;
}

// Erro padrão de "muitas tentativas", já com o status HTTP certo para o handler central
export function erroMuitasTentativas() {
  const erro = new Error("Muitas tentativas de senha. Aguarde alguns minutos e tente novamente.");
  erro.statusCode = 429;
  return erro;
}

// Rotas do assistente de primeiro uso: definem a senha do almoxarifado numa instalacao nova.
// Sao as unicas rotas do sistema que respondem SEM sessao -- por isso cada uma se tranca sozinha
// checando no servidor se a instalacao ja foi configurada, nunca confiando so na tela do frontend.
import { hashPassword, query } from "../../db.js";
import { normalizeText, readBody, send } from "../../utils/http.js";

// Uma instalacao e "nova" quando a chave senha_almoxarifado nunca foi gravada -- nao ha seed
// nesse valor, entao a ausencia dele e o sinal exato de banco vazio, sem precisar de flag extra
async function estaConfigurado() {
  const rows = await query("SELECT 1 FROM configuracoes WHERE chave = 'senha_almoxarifado'");
  return rows.length > 0;
}

export async function handleSetupRoutes(req, res, context) {
  const { method, url } = context;

  // Status publico: o frontend usa isso para decidir entre mostrar o assistente ou o login normal
  if (url.pathname === "/api/setup/status" && method === "GET") {
    const configurado = await estaConfigurado();
    send(res, 200, { precisaConfigurar: !configurado });
    return true;
  }

  // Define a senha do almoxarifado pela primeira vez. So funciona enquanto nao houver nenhuma
  // senha configurada -- depois que a instalacao ganha uma senha, essa rota se recusa a rodar de
  // novo, mesmo que alguem chame ela direto (sem passar pela tela), para nao virar um jeito de
  // resetar a senha de uma instalacao ja em uso sem autenticacao nenhuma.
  if (url.pathname === "/api/setup/senha-admin" && method === "POST") {
    if (await estaConfigurado()) {
      send(res, 403, { error: "Este sistema já foi configurado. Use a tela de login." });
      return true;
    }
    const body = await readBody(req);
    const senha = normalizeText(body.senha, 120);
    const confirmarSenha = normalizeText(body.confirmarSenha, 120);
    if (senha.length < 4) {
      send(res, 400, { error: "A senha deve ter pelo menos 4 caracteres." });
      return true;
    }
    if (senha !== confirmarSenha) {
      send(res, 400, { error: "A confirmação da senha não confere." });
      return true;
    }
    await query(
      `INSERT INTO configuracoes (chave, valor) VALUES ('senha_almoxarifado', $1)
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
      [hashPassword(senha)]
    );
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}

// Hook PreToolUse: roda a suite de testes antes de um `git commit` e bloqueia
// o commit se algo falhar. Em qualquer outro comando Bash, sai calado.
//
// O Claude Code envia o JSON da chamada da ferramenta pelo stdin.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Raiz do projeto = duas pastas acima deste arquivo (.claude/hooks/ -> raiz)
const raizProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Le todo o stdin (JSON da ferramenta)
function lerEntrada() {
  return new Promise((resolve) => {
    let dados = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (pedaco) => (dados += pedaco));
    process.stdin.on("end", () => resolve(dados));
    // Se nao houver stdin, nao trava o hook
    setTimeout(() => resolve(dados), 3000);
  });
}

// Bloqueia o commit devolvendo a decisao "deny" para o Claude Code
function negar(motivo) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: motivo
      }
    })
  );
}

const entrada = await lerEntrada();

let comando = "";
try {
  comando = JSON.parse(entrada)?.tool_input?.command || "";
} catch {
  // JSON invalido/ausente: nao ha o que verificar, deixa passar
  process.exit(0);
}

// So age em commits de verdade; ignora status, diff, log, etc.
if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(comando)) process.exit(0);

// Roda a suite sempre a partir da raiz do projeto (o cwd do hook varia)
const resultado = spawnSync("npm", ["run", "test:sequential"], {
  cwd: raizProjeto,
  encoding: "utf8",
  shell: true,
  timeout: 180000
});

if (resultado.status !== 0) {
  const saida = `${resultado.stdout || ""}${resultado.stderr || ""}`;
  const ultimasLinhas = saida.trim().split(/\r?\n/).slice(-15).join("\n");
  negar(`A suite de testes falhou — commit bloqueado ate os testes passarem.\n\n${ultimasLinhas}`);
}

process.exit(0);

// Catálogo fixo de permissões do MyControl.
//
// Não existe usuário "comum" nem perfil: cada usuário tem a própria lista de permissões,
// marcada na criação e editável depois. O catálogo mora no código de propósito (não é
// configurável pela tela) -- cada chave corresponde a uma checagem real no servidor, então
// uma chave criada pela tela não protegeria nada. Chave fora desta lista é recusada.

// Permissão que abre a tela de usuários; tem regras próprias (último gestor, não tirar de si)
export const PERMISSAO_GERENCIAR_USUARIOS = "usuario.gerenciar";

// Grupos na ordem em que aparecem na tela (Uso, Cadastros, Configuração, Consulta)
export const GRUPOS_PERMISSOES = Object.freeze([
  Object.freeze({
    id: "uso",
    rotulo: "Uso",
    permissoes: Object.freeze([
      Object.freeze({ chave: "registro.registrar", rotulo: "Registrar saída" }),
      Object.freeze({ chave: "registro.devolver", rotulo: "Registrar devolução" }),
      Object.freeze({ chave: "registro.editar", rotulo: "Editar registro" }),
      Object.freeze({ chave: "registro.cancelar", rotulo: "Cancelar registro" }),
      Object.freeze({ chave: "registro.excluir", rotulo: "Excluir registro" })
    ])
  }),
  Object.freeze({
    id: "cadastros",
    rotulo: "Cadastros",
    permissoes: Object.freeze([
      Object.freeze({ chave: "colaborador.gerenciar", rotulo: "Gerenciar colaboradores" }),
      Object.freeze({ chave: "veiculo.gerenciar", rotulo: "Gerenciar veículos" }),
      Object.freeze({ chave: "ferramenta.gerenciar", rotulo: "Gerenciar ferramentas" }),
      Object.freeze({ chave: "cargo.gerenciar", rotulo: "Gerenciar cargos" })
    ])
  }),
  Object.freeze({
    id: "configuracao",
    rotulo: "Configuração",
    permissoes: Object.freeze([
      Object.freeze({ chave: "campos.configurar", rotulo: "Configurar campos" }),
      Object.freeze({ chave: PERMISSAO_GERENCIAR_USUARIOS, rotulo: "Gerenciar usuários" })
    ])
  }),
  Object.freeze({
    id: "consulta",
    rotulo: "Consulta",
    permissoes: Object.freeze([Object.freeze({ chave: "dashboard.ver", rotulo: "Ver dashboard" })])
  })
]);

// Lista plana de todas as chaves válidas, na ordem do catálogo
export const TODAS_PERMISSOES = Object.freeze(GRUPOS_PERMISSOES.flatMap((grupo) => grupo.permissoes.map((p) => p.chave)));

const CHAVES_VALIDAS = new Set(TODAS_PERMISSOES);

// Valida a lista enviada pelo cliente: tem que ser array de textos, todos do catálogo.
// Devolve as permissões sem repetição e na ordem do catálogo, ou as chaves desconhecidas.
export function validarPermissoes(valor) {
  if (!Array.isArray(valor)) return { ok: false, erro: "Envie a lista de permissões." };
  const desconhecidas = [];
  const marcadas = new Set();
  for (const item of valor) {
    const chave = typeof item === "string" ? item.trim() : "";
    if (!CHAVES_VALIDAS.has(chave)) desconhecidas.push(String(item).slice(0, 60));
    else marcadas.add(chave);
  }
  if (desconhecidas.length) {
    return { ok: false, erro: `Permissão desconhecida: ${desconhecidas.join(", ")}.`, desconhecidas };
  }
  if (!marcadas.size) return { ok: false, erro: "Marque pelo menos uma permissão." };
  return { ok: true, permissoes: TODAS_PERMISSOES.filter((chave) => marcadas.has(chave)) };
}

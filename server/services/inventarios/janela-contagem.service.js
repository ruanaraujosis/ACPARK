// Janela de contagem: decide se os PDVs podem iniciar/editar um inventário agora.
//
// Dois controles se somam, conforme decidido com o usuário:
//   - alternador manual do Almoxarifado (aba INVENTÁRIOS), para abrir/fechar a qualquer momento;
//   - data agendada, que destrava sozinha no dia marcado e volta a travar quando o dia acaba.
//
// Configuração ausente significa BLOQUEADO, nunca liberado. Mesmo princípio do `modo_escrita`
// da integração: a ausência de configuração jamais pode ser lida como permissão.
import { query } from "../../db.js";
import { CHAVE_AGENDAMENTO, CHAVE_BLOQUEIO } from "../../modules/inventarios/inventarios.schema.js";

// Data de hoje no fuso de São Paulo, em AAAA-MM-DD. O servidor pode rodar em UTC, e comparar
// datas sem fixar o fuso liberaria (ou travaria) a contagem algumas horas fora da hora certa.
export function hojeEmSaoPaulo(agora = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(agora);
}

// Lê as duas chaves de uma vez só.
// query() deste projeto já devolve result.rows — não é o objeto de resultado do pg.
async function lerConfiguracoes() {
  const linhas = await query(
    "SELECT chave, valor FROM configuracoes WHERE chave = ANY($1)",
    [[CHAVE_BLOQUEIO, CHAVE_AGENDAMENTO]]
  );
  return Object.fromEntries(linhas.map((linha) => [linha.chave, linha.valor]));
}

// Decide o estado da janela a partir dos valores já lidos (separado para poder testar sem banco)
export function avaliarJanela({ bloqueio, agendamento, agora = new Date() } = {}) {
  const hoje = hojeEmSaoPaulo(agora);
  const dataAgendada = String(agendamento || "").slice(0, 10) || null;
  const diaAgendado = Boolean(dataAgendada) && dataAgendada === hoje;
  // Ausente ou qualquer valor diferente de "false" conta como bloqueado
  const bloqueioManual = String(bloqueio ?? "true").trim().toLowerCase() !== "false";

  const liberado = !bloqueioManual || diaAgendado;
  return {
    liberado,
    bloqueioManual,
    diaAgendado,
    dataAgendada,
    // Texto exibido ao PDV: nunca deixar um formulário mudo sem explicação
    motivo: liberado
      ? null
      : dataAgendada
        ? `Contagem bloqueada — liberada automaticamente em ${formatarDataBr(dataAgendada)}.`
        : "Contagem bloqueada — aguarde o Almoxarifado agendar o próximo inventário."
  };
}

// AAAA-MM-DD -> DD/MM/AAAA
export function formatarDataBr(iso) {
  const [ano, mes, dia] = String(iso || "").slice(0, 10).split("-");
  return ano && mes && dia ? `${dia}/${mes}/${ano}` : "";
}

// Estado atual da janela, lendo do banco
export async function estadoDaJanela(agora = new Date()) {
  const config = await lerConfiguracoes();
  return avaliarJanela({
    bloqueio: config[CHAVE_BLOQUEIO],
    agendamento: config[CHAVE_AGENDAMENTO],
    agora
  });
}

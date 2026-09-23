// Pausa de uma integração inteira até um instante conhecido.
//
// Existe por causa de um incidente real (29/08/2026): a OMIE bloqueou a conta por consumo
// excessivo e devolveu "tente novamente em N segundos" — até 1690s. O agendador, que tenta a
// cada 5 minutos, batia de novo ANTES do bloqueio expirar, e cada tentativa renovava a
// punição. Resultado: 50 chamadas bloqueadas a cada ciclo, indefinidamente, e 387 lançamentos
// represados. Sem respeitar o tempo pedido, religar o agendador reproduz o mesmo laço.
//
// O núcleo não sabe QUE API pediu a pausa nem como ela avisou — só que alguém pediu para
// esperar até tal hora. Quem reconhece a mensagem é o provider, que traduz para um
// IntegrationError com `codigo: LIMITE_TAXA` e os segundos a esperar.
//
// A pausa vale para a INTEGRAÇÃO INTEIRA, não para a operação que falhou: verificado no
// incidente que o bloqueio atingiu transferência, inventário e leitura de fatores na mesma
// janela — é limite de conta, não de endpoint.
import { CODIGOS_ERRO } from "./errors.js";

// Guarda a pausa. Reaproveita integration_runtime_state, que já tem forma de disjuntor:
// circuito aberto = não bater, `half_open_after` = quando pode tentar de novo.
export async function pausarIntegracao(client, integrationId, { segundos, motivo }) {
  const espera = Number(segundos);
  if (!Number.isFinite(espera) || espera <= 0) return null;
  const { rows } = await client.query(
    `INSERT INTO integration_runtime_state (integration_id, circuit_state, opened_at, half_open_after, updated_at)
     VALUES ($1, 'OPEN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($2 || ' seconds')::interval, CURRENT_TIMESTAMP)
     ON CONFLICT (integration_id) DO UPDATE
       SET circuit_state = 'OPEN',
           opened_at = CURRENT_TIMESTAMP,
           -- GREATEST: se duas operações forem bloqueadas na mesma janela com tempos
           -- diferentes, vale o MAIOR. Encurtar a espera por causa de uma resposta mais
           -- otimista foi o que manteve o laço vivo no incidente.
           half_open_after = GREATEST(
             integration_runtime_state.half_open_after,
             CURRENT_TIMESTAMP + ($2 || ' seconds')::interval
           ),
           consecutive_failures = integration_runtime_state.consecutive_failures + 1,
           updated_at = CURRENT_TIMESTAMP
     RETURNING half_open_after`,
    [integrationId, String(Math.ceil(espera))]
  );
  return { pausadaAte: rows[0]?.half_open_after || null, motivo: motivo || null };
}

// Até quando esta integração está pausada. Devolve null quando pode rodar.
export async function pausaAtiva(client, integrationId) {
  const { rows } = await client.query(
    `SELECT half_open_after
     FROM integration_runtime_state
     WHERE integration_id = $1
       AND circuit_state = 'OPEN'
       AND half_open_after IS NOT NULL
       AND half_open_after > CURRENT_TIMESTAMP`,
    [integrationId]
  );
  return rows[0]?.half_open_after || null;
}

// Libera a integração. Chamado quando uma chamada volta a dar certo: o bloqueio acabou.
export async function liberarIntegracao(client, integrationId) {
  await client.query(
    `UPDATE integration_runtime_state
     SET circuit_state = 'CLOSED', half_open_after = NULL, consecutive_failures = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE integration_id = $1 AND circuit_state <> 'CLOSED'`,
    [integrationId]
  );
}

// O erro pede espera? Só o provider sabe reconhecer a mensagem; aqui olhamos o código.
export function ehLimiteDeTaxa(erro) {
  return erro?.codigo === CODIGOS_ERRO.LIMITE_TAXA;
}

// Quantos segundos o erro pediu para esperar
export function segundosDeEspera(erro) {
  const bruto = Number(erro?.detalhes?.retomarEmSegundos);
  return Number.isFinite(bruto) && bruto > 0 ? bruto : null;
}

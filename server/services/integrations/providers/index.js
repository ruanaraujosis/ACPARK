import { registrarProvider } from "../core/provider-registry.js";
import { providerOmie } from "./omie/index.js";

// Ponto unico de registro dos providers de integracao.
//
// Para ligar uma API nova ao sistema: crie a pasta em providers/, exporte um manifesto no
// mesmo formato do OMIE e acrescente uma linha aqui. Rotas, fila, agendador, eventos e a
// tela de Integracoes passam a enxerga-la sem nenhuma alteracao.
const PROVIDERS = [providerOmie];

let registrados = false;

export function registrarProvidersPadrao() {
  if (registrados) return;
  for (const provider of PROVIDERS) registrarProvider(provider);
  registrados = true;
}

// Registra no import para que qualquer modulo que use o registro ja o encontre pronto
registrarProvidersPadrao();

export { providerOmie };

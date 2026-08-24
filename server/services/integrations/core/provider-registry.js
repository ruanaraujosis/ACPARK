import { CODIGOS_ERRO, IntegrationError } from "./errors.js";

// Registro central de providers de integracao.
//
// E o ponto que torna a aba "Integracoes" extensivel: o provider se descreve (credenciais que
// exige, capacidades que oferece, intervalos padrao), e tanto a API quanto a tela sao geradas
// a partir dessa descricao. Adicionar uma API nova = criar a pasta do provider e registrar aqui,
// sem tocar em rota, fila, agendador ou frontend.
const providers = new Map();

// Valida o formato do manifesto antes de aceitar o provider, para o erro aparecer no boot
// e nao no meio de uma sincronizacao
function validarManifesto(provider) {
  if (!provider?.id) throw new Error("Provider de integracao precisa de um id.");
  if (!Array.isArray(provider.capacidades) || !provider.capacidades.length) {
    throw new Error(`Provider ${provider.id} precisa declarar ao menos uma capacidade.`);
  }
  for (const capacidade of provider.capacidades) {
    if (!capacidade.id) throw new Error(`Provider ${provider.id} tem capacidade sem id.`);
    if (typeof capacidade.executar !== "function") {
      throw new Error(`Capacidade ${provider.id}.${capacidade.id} nao tem funcao executar().`);
    }
  }
}

export function registrarProvider(provider) {
  validarManifesto(provider);
  providers.set(String(provider.id).toUpperCase(), provider);
  return provider;
}

export function obterProvider(id) {
  return providers.get(String(id || "").toUpperCase()) || null;
}

// Igual a obterProvider, mas falha com erro de configuracao em vez de devolver null
export function exigirProvider(id) {
  const provider = obterProvider(id);
  if (!provider) {
    throw new IntegrationError(`Provider de integracao "${id}" nao esta registrado no sistema.`, {
      codigo: CODIGOS_ERRO.CONFIGURACAO,
      status: 400
    });
  }
  return provider;
}

export function listarProviders() {
  return [...providers.values()];
}

export function obterCapacidade(providerId, capacidadeId) {
  const provider = obterProvider(providerId);
  if (!provider) return null;
  const alvo = String(capacidadeId || "").toUpperCase();
  return provider.capacidades.find((capacidade) => String(capacidade.id).toUpperCase() === alvo) || null;
}

export function exigirCapacidade(providerId, capacidadeId) {
  const capacidade = obterCapacidade(providerId, capacidadeId);
  if (!capacidade) {
    throw new IntegrationError(`A integracao ${providerId} nao oferece a operacao "${capacidadeId}".`, {
      codigo: CODIGOS_ERRO.CONFIGURACAO,
      status: 400
    });
  }
  return capacidade;
}

// Catalogo enviado ao frontend: descreve o que cada provider precisa e o que sabe fazer,
// sem expor nada executavel. E a partir dele que a tela monta formularios e seletores.
export function catalogoPublico() {
  return listarProviders().map((provider) => ({
    id: provider.id,
    rotulo: provider.rotulo || provider.id,
    descricao: provider.descricao || "",
    tipo_padrao: provider.tipoPadrao || "PERSONALIZADA",
    url_base_padrao: provider.urlBasePadrao || "",
    ambientes: provider.ambientes || ["PRODUCAO", "HOMOLOGACAO"],
    credenciais: (provider.credenciais || []).map((credencial) => ({
      chave: credencial.chave,
      rotulo: credencial.rotulo || credencial.chave,
      obrigatoria: credencial.obrigatoria !== false,
      ajuda: credencial.ajuda || ""
    })),
    // Ajustes nao-secretos da integracao (ex: qual local externo e o almoxarifado).
    // Ficam em texto claro em integrations.configuracao; credencial nunca entra aqui.
    // O "tipo" diz a tela que campo desenhar sem que ela saiba o que o valor significa.
    configuracoes: (provider.configuracoes || []).map((configuracao) => ({
      chave: configuracao.chave,
      rotulo: configuracao.rotulo || configuracao.chave,
      tipo: configuracao.tipo || "texto",
      obrigatoria: configuracao.obrigatoria === true,
      // Lista fechada de valores, quando o ajuste e uma escolha (ex: SIMULACAO/REAL)
      opcoes: Array.isArray(configuracao.opcoes) ? configuracao.opcoes : null,
      ajuda: configuracao.ajuda || ""
    })),
    capacidades: provider.capacidades.map((capacidade) => ({
      id: capacidade.id,
      rotulo: capacidade.rotulo || capacidade.id,
      descricao: capacidade.descricao || "",
      prioridade: capacidade.prioridade || "NORMAL",
      intervalo_padrao_ms: capacidade.intervaloPadraoMs || null,
      // A tela precisa distinguir leitura de escrita para avisar antes de disparar
      escrita: capacidade.escrita === true,
      automatica: capacidade.automatica !== false,
      manual: capacidade.manual !== false
    }))
  }));
}

// Usado apenas pelos testes, para isolar o registro entre casos
export function limparProvidersRegistrados() {
  providers.clear();
}

import { chamarOmie, ENDPOINTS, extrairLista, totalDeRegistros, URL_BASE_PADRAO } from "./omie.api.js";
import { sincronizarEstoqueAlmoxarifado } from "./tarefas/estoque-almoxarifado.js";
import { SINCRONIZACAO_PDV_ATIVA } from "./omie.politica.js";
import { CHAVE_MODO_ESCRITA } from "../../core/escrita.js";
import { escreverFatoresAprovados } from "./tarefas/escrita-fator.js";
import { sincronizarEvidenciaDeCompra } from "./tarefas/evidencia-compra.js";
import { PADRAO_CARACTERISTICA_FATOR, sincronizarFatores } from "./tarefas/fatores.js";
import { sincronizarLocais } from "./tarefas/locais.js";
import { enviarTransferencias } from "./tarefas/transferencias.js";
import { sincronizarMovimentos } from "./tarefas/movimentos.js";
import { sincronizarProdutos } from "./tarefas/produtos.js";
import { reconciliarEstoque } from "./tarefas/reconciliacao.js";
import { sincronizarSaldoDeItem, sincronizarSaldos } from "./tarefas/saldos.js";

const MINUTO = 60_000;

// Manifesto do provider OMIE.
//
// Tudo que o resto do sistema precisa saber sobre a OMIE esta declarado aqui: quais
// credenciais ela exige, o que sabe fazer, com que frequencia e em que prioridade. A fila,
// o agendador, as rotas e a tela leem so este objeto — nenhum deles importa arquivo da OMIE.
export const providerOmie = {
  id: "OMIE",
  rotulo: "OMIE",
  descricao: "ERP usado como fonte oficial de produtos, locais, saldos e movimentacoes de estoque.",
  tipoPadrao: "ERP_ESTOQUE",
  urlBasePadrao: URL_BASE_PADRAO,
  ambientes: ["PRODUCAO", "HOMOLOGACAO"],

  credenciais: [
    {
      chave: "app_key",
      rotulo: "App Key",
      obrigatoria: true,
      ajuda: "Gerada no painel da OMIE em Configuracoes > APIs."
    },
    {
      chave: "app_secret",
      rotulo: "App Secret",
      obrigatoria: true,
      ajuda: "Par da App Key. Nunca e exibida de volta."
    }
  ],

  // Ajustes nao-secretos. O tipo "local_estoque" faz a tela oferecer um seletor com os
  // locais ja importados, em vez de pedir que alguem digite o codigo na mao.
  configuracoes: [
    {
      chave: "local_almoxarifado",
      rotulo: "Local do almoxarifado",
      tipo: "local_estoque",
      obrigatoria: true,
      ajuda: "Local da OMIE que representa o estoque central. E dele que sai o saldo dos produtos no MyEstoque."
    },
    {
      chave: CHAVE_MODO_ESCRITA,
      rotulo: "Modo de escrita",
      tipo: "opcao",
      opcoes: ["SIMULACAO", "REAL"],
      obrigatoria: false,
      ajuda:
        "SIMULACAO monta o lancamento e nao envia nada. So mude para REAL depois de conferir os payloads simulados."
    },
    {
      chave: "caracteristica_fator",
      rotulo: "Caracteristica do fator de conversao",
      tipo: "texto",
      obrigatoria: false,
      padrao: PADRAO_CARACTERISTICA_FATOR,
      ajuda: `Nome da caracteristica do produto na OMIE que guarda quantas unidades tem a embalagem. Padrao: ${PADRAO_CARACTERISTICA_FATOR}. Renomear no ERP so exige ajustar aqui.`
    },
    {
      chave: "caracteristica_embalagem",
      rotulo: "Caracteristica do nome da embalagem",
      tipo: "texto",
      obrigatoria: false,
      ajuda:
        "Opcional. Nome da caracteristica que guarda o nome da embalagem (FARDO, CAIXA, PACOTE), para a tela do PDV exibir '2 fardos = 30 un'. Sem ela, a tela fala genericamente."
    }
  ],

  capacidades: [
    {
      id: "PRODUTOS",
      rotulo: "Produtos",
      descricao: "Importa o cadastro de produtos e mantem o vinculo SKU local x produto da OMIE.",
      prioridade: "NORMAL",
      intervaloPadraoMs: 60 * MINUTO,
      executar: sincronizarProdutos
    },
    {
      id: "FATORES",
      rotulo: "Fatores de conversao",
      descricao:
        "Le, do cadastro de cada produto na OMIE, quantas unidades tem a embalagem em que o PDV pede. Conteudo que nao seja inteiro puro vira pendencia de cadastro, nunca fator adivinhado.",
      prioridade: "NORMAL",
      intervaloPadraoMs: 30 * MINUTO,
      executar: sincronizarFatores
    },
    {
      id: "EVIDENCIA_COMPRA",
      rotulo: "Evidencia de fator (historico de compra)",
      descricao:
        "Varre o historico de recebimento de NF-e e junta a evidencia documental de quantas unidades tem cada embalagem: o que o fornecedor faturou contra o que entrou no estoque. Nao decide nada -- so vira fator depois de uma pessoa aprovar.",
      prioridade: "BAIXA",
      // Fora do relogio: o historico nao muda sozinho e a varredura completa custa 48
      // chamadas. Roda sob demanda, pelo botao da tela de revisao.
      automatica: false,
      manual: true,
      intervaloPadraoMs: 24 * 60 * MINUTO,
      executar: sincronizarEvidenciaDeCompra
    },
    {
      id: "LOCAIS",
      rotulo: "Locais de estoque",
      descricao: "Importa os locais de estoque. Necessario antes de vincular cada PDV ao seu local.",
      prioridade: "NORMAL",
      intervaloPadraoMs: 6 * 60 * MINUTO,
      executar: sincronizarLocais
    },
    {
      id: "ESTOQUE_ALMOXARIFADO",
      rotulo: "Estoque do almoxarifado",
      descricao:
        "Traz o saldo do local de almoxarifado da OMIE para o estoque central dos produtos. E o saldo que a liberacao de pedido debita.",
      prioridade: "ALTA",
      intervaloPadraoMs: 15 * MINUTO,
      // Só esta capacidade depende do local; LOCAIS precisa poder rodar antes dela
      requerConfiguracao: ["local_almoxarifado"],
      executar: sincronizarEstoqueAlmoxarifado
    },
    {
      id: "SALDOS",
      rotulo: "Estoque dos PDVs",
      descricao:
        "Traz o saldo de cada local vinculado para o estoque daquele PDV, substituindo o valor atual. ATENCAO: enquanto a venda nao der baixa na OMIE, o saldo de PDV la so cresce e nao reflete o consumo -- rodar isto agora zera as unidades que o sistema acumulou pela liberacao de pedido.",
      prioridade: "ALTA",
      // O interruptor mora em omie.politica.js e vale tambem para o SALDO_ITEM, que a tarefa
      // de MOVIMENTOS enfileira sozinha. Fossem dois lugares, o lado PDV voltaria a ser
      // escrito pela porta dos fundos.
      automatica: SINCRONIZACAO_PDV_ATIVA,
      intervaloPadraoMs: 15 * MINUTO,
      executar: sincronizarSaldos
    },
    {
      id: "SALDO_ITEM",
      rotulo: "Saldo de um item",
      descricao: "Atualizacao pontual do saldo de um produto num local. Agendada quando chega movimento novo.",
      prioridade: "CRITICA",
      // So roda sob demanda: quem agenda e a tarefa de movimentos, nunca o relogio
      automatica: false,
      manual: false,
      executar: sincronizarSaldoDeItem
    },
    {
      id: "MOVIMENTOS",
      rotulo: "Movimentacoes",
      descricao: "Importa as movimentacoes de estoque ja registradas na OMIE (inclusive vendas vindas do Orion).",
      prioridade: "ALTA",
      intervaloPadraoMs: 5 * MINUTO,
      executar: sincronizarMovimentos
    },
    {
      id: "TRANSFERENCIAS",
      rotulo: "Transferencias para a OMIE",
      descricao:
        "Envia a transferencia ALMOXARIFADO -> PDV gerada pela confirmacao de retirada. Unica escrita do MyEstoque na OMIE: nunca venda, devolucao, compra, inventario ou saldo absoluto.",
      prioridade: "ALTA",
      // Escrita altera dado no sistema externo: o nucleo exige modo REAL explicito para enviar
      escrita: true,
      requerConfiguracao: ["local_almoxarifado"],
      // Roda pelo relogio para drenar sozinha quando a internet voltar -- sincronizacao
      // oportunista. Em simulacao ela so monta payload, entao ligar o relogio e seguro.
      intervaloPadraoMs: 5 * MINUTO,
      executar: enviarTransferencias
    },
    {
      id: "ESCRITA_FATOR",
      rotulo: "Gravar fator aprovado no cadastro",
      descricao:
        "Grava a caracteristica de unidades por embalagem no cadastro do produto na OMIE, somente para os produtos cujo fator uma pessoa aprovou na tela de revisao. Nunca grava sugestao nao aprovada.",
      prioridade: "NORMAL",
      // Altera o cadastro no sistema externo: o nucleo exige modo REAL explicito para enviar
      escrita: true,
      // Fora do relogio: gravar cadastro e ato deliberado, disparado depois da revisao. A API
      // tambem nao aceita chamada simultanea em inclusao/alteracao.
      automatica: false,
      manual: true,
      intervaloPadraoMs: 60 * MINUTO,
      executar: escreverFatoresAprovados
    },
    {
      id: "RECONCILIACAO",
      rotulo: "Reconciliacao",
      descricao: "Compara o espelho local com a OMIE e registra divergencias para revisao. Nao corrige sozinha.",
      prioridade: "BAIXA",
      intervaloPadraoMs: 12 * 60 * MINUTO,
      executar: reconciliarEstoque
    }
  ],

  // Chamada minima de leitura, so para provar que URL e credenciais estao certas.
  // Pede 1 registro: o que interessa e o total de produtos que a conta enxerga.
  async testarConexao({ integracao, segredos, fetchImpl }) {
    const resposta = await chamarOmie({
      integracao,
      segredos,
      endpoint: ENDPOINTS.PRODUTOS,
      call: "ListarProdutos",
      params: {
        pagina: 1,
        registros_por_pagina: 1,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N"
      },
      fetchImpl
    });

    return {
      duracaoMs: resposta.duracaoMs,
      total_de_produtos: totalDeRegistros(resposta.dados),
      amostra_recebida: extrairLista(resposta.dados, ["produto_servico_cadastro"]).length
    };
  }
};

export default providerOmie;

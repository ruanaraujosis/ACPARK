// Catálogo fixo dos cadastros do MyControl: entidades, campos do sistema e tipos de campo.
//
// REGRA ÚNICA DE ONDE MORA CADA VALOR (vale igual para colaborador, veículo e ferramenta):
//   - campo do SISTEMA (declarado aqui, `sistema: true` em mc_campos) -> COLUNA própria da tabela;
//   - campo criado pelo USUÁRIO na tela de Campos                   -> chave dentro de `dados` JSONB.
// Nunca o contrário. Assim consulta, índice e unicidade (placa, chave, identificador) ficam em
// coluna de verdade, e a tela pode acrescentar campos sem mexer na estrutura do banco.
//
// "Travado" = o campo não pode ser desativado nem excluído e o tipo não muda. O rótulo e a ordem
// sempre podem mudar. `obrigatorioFixo` trava também a obrigatoriedade (sem ele o cadastro não
// faz sentido: nome, cargo, placa...). Estas regras valem pelo CÓDIGO, não pelo que está no banco.

// Tipos que o usuário pode escolher ao criar um campo
export const TIPOS_CAMPO = Object.freeze([
  Object.freeze({ tipo: "texto", rotulo: "Texto curto" }),
  Object.freeze({ tipo: "texto_longo", rotulo: "Texto longo" }),
  Object.freeze({ tipo: "numero", rotulo: "Número" }),
  Object.freeze({ tipo: "data", rotulo: "Data" }),
  Object.freeze({ tipo: "selecao", rotulo: "Lista de opções" }),
  Object.freeze({ tipo: "sim_nao", rotulo: "Sim / Não" }),
  Object.freeze({ tipo: "telefone", rotulo: "Telefone" }),
  Object.freeze({ tipo: "foto", rotulo: "Foto" }),
  Object.freeze({ tipo: "assinatura", rotulo: "Assinatura" })
]);

// Tipos exclusivos de campos do sistema (não aparecem para o usuário escolher)
export const TIPOS_SO_SISTEMA = Object.freeze(["matricula", "cargo", "placa"]);

const TIPOS_DO_USUARIO = new Set(TIPOS_CAMPO.map((t) => t.tipo));

// Tipo existe na lista que o usuário pode escolher?
export function tipoDoUsuarioValido(tipo) {
  return TIPOS_DO_USUARIO.has(tipo);
}

// Campos do sistema de cada entidade, na ordem inicial. `coluna` é onde o valor mora.
const CAMPOS_SISTEMA = {
  colaborador: [
    { chave: "nome", rotulo: "Nome", tipo: "texto", coluna: "nome", travado: true, obrigatorio: true, obrigatorioFixo: true, max: 120 },
    // Gerada pelo servidor ao criar; nunca vem do formulário nem da API
    { chave: "matricula", rotulo: "Matrícula", tipo: "matricula", coluna: "matricula", travado: true, obrigatorio: true, obrigatorioFixo: true, gerado: true },
    { chave: "cargo", rotulo: "Cargo", tipo: "cargo", coluna: "cargo_id", travado: true, obrigatorio: true, obrigatorioFixo: true },
    { chave: "assinatura", rotulo: "Assinatura", tipo: "assinatura", coluna: "assinatura_id", travado: true, obrigatorio: false },
    { chave: "foto", rotulo: "Foto", tipo: "foto", coluna: "foto_id", travado: false, obrigatorio: false }
  ],
  veiculo: [
    { chave: "numero_chave", rotulo: "Número da chave", tipo: "texto", coluna: "numero_chave", travado: true, obrigatorio: true, obrigatorioFixo: true, max: 20, maiusculo: true },
    { chave: "nome", rotulo: "Nome", tipo: "texto", coluna: "nome", travado: true, obrigatorio: true, obrigatorioFixo: true, max: 120 },
    { chave: "placa", rotulo: "Placa", tipo: "placa", coluna: "placa", travado: true, obrigatorio: true, obrigatorioFixo: true },
    { chave: "foto", rotulo: "Foto", tipo: "foto", coluna: "foto_id", travado: false, obrigatorio: false },
    { chave: "descricao", rotulo: "Descrição", tipo: "texto_longo", coluna: "descricao", travado: false, obrigatorio: false }
  ],
  ferramenta: [
    { chave: "nome", rotulo: "Nome", tipo: "texto", coluna: "nome", travado: true, obrigatorio: true, obrigatorioFixo: true, max: 120 },
    { chave: "identificador", rotulo: "Identificador", tipo: "texto", coluna: "identificador", travado: true, obrigatorio: true, obrigatorioFixo: true, max: 40, maiusculo: true },
    { chave: "foto", rotulo: "Foto", tipo: "foto", coluna: "foto_id", travado: false, obrigatorio: false },
    { chave: "descricao", rotulo: "Descrição", tipo: "texto_longo", coluna: "descricao", travado: false, obrigatorio: false }
  ]
};

// Entidades cadastráveis: tabela, permissão que gerencia, caminho da API e nome na tela
export const ENTIDADES = Object.freeze({
  colaborador: Object.freeze({ tabela: "mc_colaboradores", permissao: "colaborador.gerenciar", rota: "colaboradores", singular: "Colaborador", plural: "Colaboradores" }),
  veiculo: Object.freeze({ tabela: "mc_veiculos", permissao: "veiculo.gerenciar", rota: "veiculos", singular: "Veículo", plural: "Veículos" }),
  ferramenta: Object.freeze({ tabela: "mc_ferramentas", permissao: "ferramenta.gerenciar", rota: "ferramentas", singular: "Ferramenta", plural: "Ferramentas" })
});

// Nome da entidade é um dos três conhecidos?
export function entidadeValida(entidade) {
  return Object.prototype.hasOwnProperty.call(ENTIDADES, entidade);
}

// Campos do sistema de uma entidade (cópia, para ninguém alterar o catálogo por engano)
export function camposDoSistema(entidade) {
  return (CAMPOS_SISTEMA[entidade] || []).map((campo) => ({ ...campo }));
}

// Definição do sistema para uma chave, ou null se for campo do usuário
export function campoDoSistema(entidade, chave) {
  return (CAMPOS_SISTEMA[entidade] || []).find((campo) => campo.chave === chave) || null;
}

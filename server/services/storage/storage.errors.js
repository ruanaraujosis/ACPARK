// Erro lancado quando o driver/credenciais de storage estao ausentes ou invalidos
export class StorageConfigurationError extends Error {
  constructor(message = "Storage nao configurado.") {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

// Erro lancado quando o arquivo enviado pelo usuario nao passa na validacao (tamanho/tipo)
export class StorageValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageValidationError";
    this.statusCode = 400;
  }
}

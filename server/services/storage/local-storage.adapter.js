import fs from "node:fs/promises";
import path from "node:path";

// Adaptador de storage que grava arquivos no disco local (uso em dev/local)
export class LocalStorageAdapter {
  constructor({ root }) {
    this.root = root;
  }

  // Resolve a chave para um caminho absoluto e impede path traversal fora da raiz
  safePath(key) {
    const resolved = path.resolve(this.root, key);
    const root = path.resolve(this.root);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Caminho de storage invalido.");
    return resolved;
  }

  async saveFile(key, buffer, _contentType = "application/octet-stream") {
    const target = this.safePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    return { key };
  }

  async readFile(key) {
    return fs.readFile(this.safePath(key));
  }

  async deleteFile(key) {
    await fs.rm(this.safePath(key), { force: true });
  }
}

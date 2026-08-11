import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, HASH_PREFIX } from "../server/db.js";

// Senhas do sistema (PDVs e almoxarifado) sao gravadas com pbkdf2_sha256.
// Estes testes garantem que o formato nao regrida e que senha em texto puro nunca autentique.

test("hashPassword gera o formato pbkdf2_sha256$iteracoes$salt$digest", () => {
  const hash = hashPassword("minha-senha");
  assert.match(hash, new RegExp(`^${HASH_PREFIX}\\$\\d+\\$[0-9a-f]+\\$`));
  // Cada hash usa salt proprio: senhas iguais nao podem gerar o mesmo valor
  assert.notEqual(hash, hashPassword("minha-senha"));
});

test("verifyPassword aceita a senha correta e recusa a errada", () => {
  const hash = hashPassword("senha-correta");
  assert.equal(verifyPassword("senha-correta", hash), true);
  assert.equal(verifyPassword("senha-errada", hash), false);
  assert.equal(verifyPassword("", hash), false);
  assert.equal(verifyPassword("senha-correta", ""), false);
});

test("senha gravada em texto puro nunca autentica", () => {
  // Antes existia um fallback que comparava texto puro quando o valor nao tinha hash.
  // Isso deixava um PDV com senha '123' logar normalmente -- o fallback foi removido.
  assert.equal(verifyPassword("123", "123"), false);
  assert.equal(verifyPassword("qualquer", "qualquer"), false);
  assert.equal(verifyPassword("admin", "admin"), false);
});

test("valor de hash malformado e recusado sem lancar excecao", () => {
  assert.equal(verifyPassword("x", `${HASH_PREFIX}$`), false);
  assert.equal(verifyPassword("x", `${HASH_PREFIX}$260000`), false);
  assert.equal(verifyPassword("x", `${HASH_PREFIX}$260000$salt`), false);
});

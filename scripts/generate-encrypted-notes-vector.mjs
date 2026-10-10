// Independent Node/OpenSSL oracle. Requires Node >= 24.7 with argon2Sync.
// All inputs are public test values; never use this generator with real content or passwords.
import { argon2Sync, createCipheriv } from "node:crypto";
import { writeFileSync } from "node:fs";

const passphrase = "test-only: 密码 café 🚀";
const plaintext = "\ufeff# Secret\n跨端测试 📝\n";
const identity = { objectId: "00112233-4455-4677-8899-aabbccddeeff", kind: "note", originalFormat: "markdown" };
const salt = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const dek = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const kdf = { algorithm: "argon2id", version: 19, memoryKiB: 65536, iterations: 3, parallelism: 4, salt: salt.toString("base64") };
const kek = argon2Sync("argon2id", { message: Buffer.from(passphrase), nonce: salt, memory: 65536, passes: 3, parallelism: 4, tagLength: 32 });
const aad = (purpose) => Buffer.from(JSON.stringify(["nowen-encrypted-content", 1, "AES-256-GCM", purpose, identity.objectId, identity.kind, identity.originalFormat]));
function seal(key, bytes, purpose, ivHex) {
  const iv = Buffer.from(ivHex, "hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(purpose));
  return { iv: iv.toString("base64"), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString("base64") };
}
const fixture = {
  generatedBy: "Node native Argon2id + OpenSSL AES-GCM (independent of hash-wasm/Web Crypto)",
  passphrase, plaintext, derivedKeyHex: kek.toString("hex"),
  aadKeyUtf8: aad("key").toString(), aadContentUtf8: aad("content").toString(),
  envelope: { ...identity, version: 1, algorithm: "AES-256-GCM", kdf,
    wrappedKey: seal(kek, dek, "key", "101112131415161718191a1b"),
    payload: seal(dek, Buffer.from(plaintext), "content", "202122232425262728292a2b"),
  },
};
writeFileSync(new URL("../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
console.log("Wrote public envelope v1 interoperability fixture.");

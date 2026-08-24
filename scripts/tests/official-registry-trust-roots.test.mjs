import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { validateTrustRoots } from "../generate-official-registry-trust-roots.mjs";

function publicPem(type = "ed25519") {
  const pair = type === "ed25519"
    ? crypto.generateKeyPairSync("ed25519")
    : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function root(overrides = {}) {
  const key = publicPem();
  return {
    sourceId: "official-v2",
    sourceName: "Nowen Official Registry",
    indexUrl: "https://extensions.nowen.example/v2/index.json",
    keyId: "root-2026",
    algorithm: "Ed25519",
    publicKey: key.publicKey,
    sequence: 1,
    state: "active",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("Official Registry root validator accepts one active Ed25519 HTTPS root", () => {
  const result = validateTrustRoots([root()]);
  assert.equal(result.length, 1);
  assert.equal(result[0].algorithm, "Ed25519");
  assert.match(result[0].publicKey, /BEGIN PUBLIC KEY/);
});

test("Official Registry root validator fails closed on missing release roots", () => {
  assert.throws(() => validateTrustRoots([]), /至少需要一个/);
  assert.deepEqual(validateTrustRoots([], { requireNonEmpty: false }), []);
});

test("Official Registry root validator rejects private and non-Ed25519 keys", () => {
  const ed = publicPem();
  const rsa = publicPem("rsa");
  assert.throws(() => validateTrustRoots([root({ publicKey: ed.privateKey })]), /不能包含私钥/);
  assert.throws(() => validateTrustRoots([root({ publicKey: rsa.publicKey })]), /必须是 Ed25519/);
});

test("Official Registry root validator requires HTTPS and one active root per source", () => {
  assert.throws(() => validateTrustRoots([root({ indexUrl: "http://extensions.nowen.example/v2/index.json" })]), /HTTPS/);
  const first = root({ keyId: "root-a", sequence: 1 });
  const second = root({ keyId: "root-b", sequence: 2 });
  assert.throws(() => validateTrustRoots([first, second]), /只能配置一个 active/);
});

test("Official Registry root validator allows historical revoked roots beside one active root", () => {
  const historical = root({ keyId: "root-old", sequence: 0, state: "revoked" });
  const active = root({ keyId: "root-current", sequence: 1, state: "active" });
  const result = validateTrustRoots([historical, active]);
  assert.equal(result.filter((item) => item.state === "active").length, 1);
  assert.equal(result.length, 2);
});

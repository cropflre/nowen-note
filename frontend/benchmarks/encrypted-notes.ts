import { runEncryptedContentOperation as run } from "../src/lib/encryptedNotes/workerClient";
import { EncryptedContentError, validateEnvelope } from "../src/lib/encryptedNotes/envelope";
import rawVector from "../src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json";

const vector = { ...rawVector, envelope: validateEnvelope(rawVector.envelope) };

// Exposed only in this separately built developer fixture, never on an application route.
const harness = { run, vector };
declare global { interface Window { cryptoBenchmark: typeof harness } }
window.cryptoBenchmark = harness;
const button = document.querySelector<HTMLButtonElement>("#run")!;
const output = document.querySelector<HTMLPreElement>("#result")!;
let controller: AbortController | undefined;
document.querySelector("#cancel")!.addEventListener("click", () => controller?.abort());
button.addEventListener("click", async () => {
  button.disabled = true;
  controller = new AbortController();
  output.textContent = "running";
  const timings: Record<string, number> = {};
  const measure = async <T>(name: string, operation: () => Promise<T>) => {
    const start = performance.now();
    const result = await operation();
    timings[name] = Math.round(performance.now() - start);
    return result;
  };
  try {
    const expected = vector.envelope;
    const fixtureText = await measure("independentVectorMs", () => run({ operation: "decrypt", input: { envelope: expected, expected, passphrase: vector.passphrase } }, controller!.signal));
    if (fixtureText !== vector.plaintext) throw new Error("Vector mismatch");
    const created = await measure("createMs", () => run({ operation: "create", input: { plaintext: vector.plaintext, passphrase: vector.passphrase, kind: "block", originalFormat: "tiptap-json" } }, controller!.signal));
    const updated = await measure("updateMs", () => run({ operation: "update", input: { envelope: created, expected: created, passphrase: vector.passphrase, plaintext: "updated 📝" } }, controller!.signal));
    const changed = await measure("changePassphraseMs", () => run({ operation: "change-passphrase", input: { envelope: updated, expected: updated, passphrase: vector.passphrase, newPassphrase: "test-only:new-password" } }, controller!.signal));
    const text = await measure("decryptMs", () => run({ operation: "decrypt", input: { envelope: changed, expected: changed, passphrase: "test-only:new-password" } }, controller!.signal));
    if (text !== "updated 📝" || JSON.stringify(changed.payload) !== JSON.stringify(updated.payload)) throw new Error("Round-trip mismatch");
    output.textContent = JSON.stringify({ status: "passed", timings }, null, 2);
  } catch (error) {
    output.textContent = error instanceof EncryptedContentError ? error.code : "self-test failed";
  } finally { controller = undefined; button.disabled = false; }
});

// @vitest-environment node
import { expect, it } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import { decryptEncryptedContent, unlockEncryptedContentKey, updateEncryptedContentWithKey } from "../crypto";
import { validateEnvelope } from "../envelope";

it("opens an existing v1 key once and writes interoperable ciphertext without a password", async () => {
  const envelope = validateEnvelope(fixture.envelope);
  const opened = await unlockEncryptedContentKey(envelope, fixture.passphrase, envelope);
  expect(opened.plaintext).toBe(fixture.plaintext);
  expect(opened.key.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("raw", opened.key)).rejects.toThrow();
  const first = await updateEncryptedContentWithKey(envelope, opened.key, envelope, "First private draft");
  const second = await updateEncryptedContentWithKey(first, opened.key, envelope, "Second private draft");
  expect(second.wrappedKey).toEqual(envelope.wrappedKey);
  expect(first.payload.iv).not.toBe(second.payload.iv);
  expect(await decryptEncryptedContent(second, fixture.passphrase, envelope)).toBe("Second private draft");
});

it("a session key cannot authorize another object or overwrite tampered ciphertext", async () => {
  const envelope = validateEnvelope(fixture.envelope);
  const { key } = await unlockEncryptedContentKey(envelope, fixture.passphrase, envelope);
  await expect(updateEncryptedContentWithKey({ ...envelope, objectId: crypto.randomUUID() }, key, envelope, "Overwrite")).rejects.toMatchObject({ code: "unlock-failed" });
  const broken = structuredClone(envelope);
  broken.payload.ciphertext = "A" + broken.payload.ciphertext.slice(1);
  await expect(updateEncryptedContentWithKey(broken, key, envelope, "Overwrite")).rejects.toMatchObject({ code: "unlock-failed" });
});

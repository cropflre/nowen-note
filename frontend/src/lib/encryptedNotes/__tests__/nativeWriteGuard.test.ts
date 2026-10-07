import { expect, it } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import { validateEncryptedNoteWrite } from "../noteDocument";

const note = { content: JSON.stringify(fixture.envelope), contentFormat: "encrypted-note-v1", contentText: "" };
it("accepts current ciphertext and metadata but refuses plaintext downgrade or implicit old writes", () => {
  expect(() => validateEncryptedNoteWrite(note)).not.toThrow();
  expect(() => validateEncryptedNoteWrite({ title: "New title" }, note)).not.toThrow();
  expect(() => validateEncryptedNoteWrite(note, note)).not.toThrow();
  for (const patch of [{ contentFormat: "markdown", content: "Secret" }, { content: note.content }, { contentText: "Secret" }]) {
    expect(() => validateEncryptedNoteWrite(patch, note)).toThrow();
  }
});
it("rejects future formats, malformed ciphertext, identity substitution and implicit conversion", () => {
  for (const value of [{ ...note, contentFormat: "encrypted-note-v99" }, { ...note, content: "Plaintext" },
    { ...note, content: JSON.stringify({ ...fixture.envelope, objectId: crypto.randomUUID() }) }]) {
    expect(() => validateEncryptedNoteWrite(value, note)).toThrow();
  }
  expect(() => validateEncryptedNoteWrite(note, { content: "Old plaintext", contentFormat: "markdown" })).toThrow();
});

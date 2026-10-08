import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import v2 from "./fixtures/envelope-v2.json";
import { ENCRYPTED_NOTE_FORMAT, readEncryptedNoteDocument, validateEncryptedNotePlaintext } from "../noteDocument";
import { stabilizeNoteMutationPayload } from "../../noteContentPersistence";
vi.mock("@/lib/noteAttachmentAccessBridge", () => ({ extractAttachmentId: () => null, getPersistentAttachmentUrl: () => null }));

describe("encrypted note persistence boundaries", () => {
  const note = { contentFormat: ENCRYPTED_NOTE_FORMAT, content: JSON.stringify(fixture.envelope), contentText: "" };
  it("preserves ciphertext byte-for-byte and rejects plaintext preview text", () => {
    expect(stabilizeNoteMutationPayload(note)).toBe(note);
    expect(() => stabilizeNoteMutationPayload({ ...note, contentText: "secret" })).toThrow();
    expect(() => stabilizeNoteMutationPayload({ ...note, content: "secret" })).toThrow();
  });
  it("preserves v2 ciphertext without ordinary attachment-source rewriting", () => {
    const encrypted = { content: JSON.stringify(v2.envelope), contentFormat: "encrypted-note-v2", contentText: "" };
    expect(stabilizeNoteMutationPayload(encrypted)).toBe(encrypted);
    expect(() => stabilizeNoteMutationPayload({ ...encrypted, contentText: "Private" })).toThrow();
    expect(() => stabilizeNoteMutationPayload({ ...encrypted, content: JSON.stringify({ ...v2.envelope, keyEpoch: 0 }) })).toThrow();
  });
  it("fails closed on unknown encrypted formats and block envelopes", () => {
    expect(() => readEncryptedNoteDocument({ ...note, contentFormat: "encrypted-note-v99" })).toThrow();
    expect(() => readEncryptedNoteDocument({ ...note, content: JSON.stringify({ ...fixture.envelope, kind: "block" }) })).toThrow();
  });
  it("accepts text-only Markdown and rich-text documents", () => {
    expect(() => validateEncryptedNotePlaintext("# Hello\nPrivate text", "markdown")).not.toThrow();
    expect(() => validateEncryptedNotePlaintext(JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret", marks: [{ type: "bold" }] }] }] }), "tiptap-json")).not.toThrow();
  });
  it.each(["![image](https://example.com/image.png)", '<audio src="/api/attachments/file">', "![[private.pdf]]", "<iframe src='https://example.com'>"])("rejects attachment/embed Markdown %s", (source) => {
    expect(() => validateEncryptedNotePlaintext(source, "markdown")).toThrow();
  });
  it.each(["image", "audio", "iframe", "mindMapEmbed", "fileAttachment"])("rejects rich-text %s nodes", (type) => {
    expect(() => validateEncryptedNotePlaintext(JSON.stringify({ type: "doc", content: [{ type }] }), "tiptap-json")).toThrow();
  });
});

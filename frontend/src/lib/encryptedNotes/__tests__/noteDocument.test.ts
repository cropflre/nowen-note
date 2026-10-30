import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import v2 from "./fixtures/envelope-v2.json";
import { ENCRYPTED_NOTE_FORMAT, readEncryptedNoteDocument, validateEncryptedNotePlaintext, sameConversionContent } from "../noteDocument";
import { stabilizeNoteMutationPayload } from "../../noteContentPersistence";
vi.mock("@/lib/noteAttachmentAccessBridge", () => ({ extractAttachmentId: () => null, getPersistentAttachmentUrl: () => null }));

describe("encrypted note persistence boundaries", () => {
  it("accepts only legacy empty rich-text markers and matches the rendered empty paragraph", () => {
    const empty = JSON.stringify({ type: "doc", content: [{ type: "paragraph", attrs: { textAlign: null, indent: 0 } }] });
    for (const source of ["", "{}", "{ }"]) {
      expect(() => validateEncryptedNotePlaintext(source, "tiptap-json")).not.toThrow();
      expect(sameConversionContent(source, empty, "tiptap-json")).toBe(true);
    }
    for (const source of ["null", "[]", '{"unknown":"private"}']) expect(() => validateEncryptedNotePlaintext(source, "tiptap-json")).toThrow();
    expect(sameConversionContent("{}", '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"unsaved"}]}]}', "tiptap-json")).toBe(false);
  });
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
  it("ignores only rich-text defaults and block IDs during conversion source comparison", () => {
    const original = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Keep", marks: [{ type: "bold" }] }] }] };
    const loaded = structuredClone(original);
    loaded.content[0].attrs = { level: 2, blockId: "loaded", textAlign: null, indent: 0, firstLineIndent: 0, lineHeight: null } as typeof loaded.content[0]["attrs"];
    expect(sameConversionContent(JSON.stringify(original), JSON.stringify(loaded), "tiptap-json")).toBe(true);
    loaded.content[0].content[0].text = "New edit";
    expect(sameConversionContent(JSON.stringify(original), JSON.stringify(loaded), "tiptap-json")).toBe(false);
    expect(sameConversionContent("body", "body\n", "markdown")).toBe(false);
    expect(sameConversionContent(JSON.stringify(original), JSON.stringify({ ...original, content: [{ ...original.content[0], attrs: { level: 3 } }] }), "tiptap-json")).toBe(false);
    expect(sameConversionContent(JSON.stringify(original), JSON.stringify({ ...original, content: [{ ...original.content[0], attrs: { level: 2, textAlign: "center" } }] }), "tiptap-json")).toBe(false);
  });
  it.each(["![image](https://example.com/image.png)", '<audio src="/api/attachments/file">', "![[private.pdf]]", "<iframe src='https://example.com'>"])("rejects attachment/embed Markdown %s", (source) => {
    expect(() => validateEncryptedNotePlaintext(source, "markdown")).toThrow();
  });
  it.each(["image", "audio", "iframe", "mindMapEmbed", "fileAttachment"])("rejects rich-text %s nodes", (type) => {
    expect(() => validateEncryptedNotePlaintext(JSON.stringify({ type: "doc", content: [{ type }] }), "tiptap-json")).toThrow();
  });
});

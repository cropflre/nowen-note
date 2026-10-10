import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import { ENCRYPTED_BLOCK_LANGUAGE, encryptedBlockFence, encryptedBlocksInContent, markdownEncryptedBlocks, assertEncryptedBlocksPreserved, readEncryptedBlock, withEncryptedBlocksSupport } from "../blockDocument";
import { convertNoteContent } from "../../noteFormatConversion";
import { stabilizeNoteContentForPersistence } from "../../noteContentPersistence";
vi.mock("@/lib/noteAttachmentAccessBridge", () => ({ extractAttachmentId: () => null, getPersistentAttachmentUrl: () => null }));
// Structural fixture only; crypto/browser tests authenticate actual kind=block ciphertext.
const envelope = { ...fixture.envelope, kind: "block" };
const source = JSON.stringify(envelope);
const fence = encryptedBlockFence(source);
const doc = (text = source, language = ENCRYPTED_BLOCK_LANGUAGE) => JSON.stringify({ type: "doc", content: [{ type: "blockquote", content: [{ type: "codeBlock", attrs: { language }, content: [{ type: "text", text }] }] }] });
describe("encrypted region document boundaries", () => {
  it.each(["", "> ", "- ", "> 1. "])("preserves offsets and container %s", (prefix) => {
    const content = `public before\n\n${encryptedBlockFence(source, prefix)}\n\npublic after`;
    const [block] = markdownEncryptedBlocks(content);
    expect(block.envelope).toEqual(envelope); expect(block.prefix).toBe(prefix);
    expect(content.slice(block.from, block.to)).toBe(encryptedBlockFence(source, prefix));
  });
  it("ignores literal fence examples", () => {
    expect(markdownEncryptedBlocks(`\`\`\`\`markdown\n${fence}\n\`\`\`\``)).toEqual([]);
  });
  it.each(["nowen-encrypted-v2", "nowen-encrypted", ENCRYPTED_BLOCK_LANGUAGE])("rejects unsupported/malformed %s", (language) => {
    const bad = `\`\`\`${language}\nnot encrypted\n\`\`\``;
    expect(() => markdownEncryptedBlocks(bad)).toThrow();
    expect(() => encryptedBlocksInContent(doc("not encrypted", language), "tiptap-json")).toThrow();
    expect(() => stabilizeNoteContentForPersistence(bad, "markdown")).toThrow();
  });
  it("rejects incomplete fences, note envelopes and unknown fields", () => {
    expect(() => markdownEncryptedBlocks(fence.slice(0, -3))).toThrow();
    expect(() => readEncryptedBlock(JSON.stringify(fixture.envelope))).toThrow();
    expect(() => readEncryptedBlock(JSON.stringify({ ...envelope, plaintext: "secret" }))).toThrow();
    expect(encryptedBlocksInContent(doc(), "tiptap-json")).toEqual([envelope]);
  });
  it("counts copies and rejects lost or changed envelopes", () => {
    expect(() => assertEncryptedBlocksPreserved(`${fence}\n\n${fence}`, "markdown", doc(), "tiptap-json")).toThrow();
    expect(() => assertEncryptedBlocksPreserved(fence, "markdown", "public", "markdown")).toThrow();
    const changed = JSON.stringify({ ...envelope, objectId: "00112233-4455-4677-8899-aabbccddee00" });
    expect(() => assertEncryptedBlocksPreserved(fence, "markdown", doc(changed), "tiptap-json")).toThrow();
  });
  it.each(["", "> ", "- "])("round trips production format converters for %s", (prefix) => {
    const markdown = `public before\n\n${encryptedBlockFence(source, prefix)}\n\npublic after`;
    const rich = convertNoteContent(markdown, "", "tiptap-json");
    const back = convertNoteContent(rich.content, rich.contentText, "markdown");
    expect(encryptedBlocksInContent(rich.content, rich.contentFormat)).toEqual([envelope]);
    expect(encryptedBlocksInContent(back.content, back.contentFormat)).toEqual([envelope]);
    expect(back.content).toContain("public before"); expect(back.content).not.toContain(fixture.plaintext);
  });
  it("round trips backend-generated markers without falsely repairing a valid language fence", () => {
    const markdown = `Public before ^blk_00112233-4455-4677-8899-aabbccddeeff\n\n${fence}\n^blk_00112233-4455-4677-8899-aabbccddee00\n\nPublic after`;
    const rich = convertNoteContent(markdown, "", "tiptap-json");
    expect(encryptedBlocksInContent(rich.content, rich.contentFormat)).toEqual([envelope]);
    expect(encryptedBlocksInContent(convertNoteContent(rich.content, "", "markdown").content, "markdown")).toEqual([envelope]);
  });
  it("validates final persistence when format is omitted", () => {
    expect(stabilizeNoteContentForPersistence(doc())).toBe(doc());
    expect(() => stabilizeNoteContentForPersistence(doc("{}"))).toThrow();
    expect(stabilizeNoteContentForPersistence(fence)).toBe(fence);
  });
});

it("declares current editor support without mutating the payload or altering ciphertext", () => {
  const payload = Object.freeze({ content: source, contentFormat: "markdown" });
  const marked = withEncryptedBlocksSupport(payload);
  expect(marked).toEqual({ ...payload, encryptedBlocksVersion: 1 });
  expect(marked.content).toBe(source);
  expect(payload).not.toHaveProperty("encryptedBlocksVersion");
  const metadata = { isPinned: 1 };
  expect(withEncryptedBlocksSupport(metadata as { content?: string })).toBe(metadata);
});

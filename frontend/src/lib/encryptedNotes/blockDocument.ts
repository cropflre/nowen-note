import { EncryptedContentError, validateEnvelope, type EncryptedContentEnvelope } from "./envelope";
import type { JSONContent } from "@tiptap/core";

export const ENCRYPTED_BLOCK_LANGUAGE = "nowen-encrypted-v1";
export const isEncryptedBlockLanguage = (language: unknown): boolean => typeof language === "string" && language.toLowerCase().startsWith("nowen-encrypted");
export function readEncryptedBlock(source: string, language = ENCRYPTED_BLOCK_LANGUAGE): EncryptedContentEnvelope {
  if (language.toLowerCase() !== ENCRYPTED_BLOCK_LANGUAGE) throw new EncryptedContentError("invalid");
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new EncryptedContentError("invalid"); }
  const envelope = validateEnvelope(value);
  if (envelope.kind !== "block") throw new EncryptedContentError("invalid");
  return envelope;
}
export function encryptedBlockFence(source: string, prefix = ""): string {
  readEncryptedBlock(source);
  const continuation = prefix.replace(/(?:[-+*]|\d+[.)])[ \t]+$/, (marker) => " ".repeat(marker.length));
  return `${prefix}\`\`\`${ENCRYPTED_BLOCK_LANGUAGE}\n${continuation}${source}\n${continuation}\`\`\``;
}
export type MarkdownEncryptedBlock = { from: number; to: number; source: string; prefix: string; envelope: EncryptedContentEnvelope };
/** Scan complete fences in order; examples inside another code fence stay literal. */
export function markdownEncryptedBlocks(content: string): MarkdownEncryptedBlock[] {
  const lines = content.split("\n"); const result: MarkdownEncryptedBlock[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^([ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/);
    if (!opening) { offset += lines[i].length + 1; continue; }
    const [, prefix, fence, info] = opening; const language = info.trim();
    let end = i + 1;
    while (end < lines.length) {
      const closing = lines[end].match(/^[ \t>]*(`{3,}|~{3,})[ \t]*\r?$/);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) break;
      end++;
    }
    const to = offset + lines.slice(i, Math.min(end + 1, lines.length)).join("\n").length;
    if (isEncryptedBlockLanguage(language)) {
      if (end === lines.length) throw new EncryptedContentError("invalid");
      const source = lines.slice(i + 1, end).map((line) => line.replace(/^[ \t]*(?:>[ \t]*)+/, "")).join("\n");
      result.push({ from: offset, to, source, prefix, envelope: readEncryptedBlock(source, language) });
    }
    offset = to + 1; i = end;
  }
  return result;
}
export function encryptedBlocksInContent(content: string, format?: string): EncryptedContentEnvelope[] {
  if (format === "markdown") return markdownEncryptedBlocks(content).map((block) => block.envelope);
  if (!["tiptap-json", "richtext"].includes(format || "")) return [];
  let doc: unknown;
  try { doc = JSON.parse(content); } catch { return []; }
  const blocks: EncryptedContentEnvelope[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 100) throw new EncryptedContentError("invalid");
    if (!value) return;
    const node = value as JSONContent;
    if (node.type === "codeBlock" && isEncryptedBlockLanguage(node.attrs?.language)) {
      if (!Array.isArray(node.content) || node.content.some((child) => child.type !== "text" || typeof child.text !== "string")) throw new EncryptedContentError("invalid");
      blocks.push(readEncryptedBlock(node.content.map((child) => child.text).join(""), node.attrs!.language));
      return;
    }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child, depth + 1);
  };
  walk(doc, 0); return blocks;
}
/** Format conversion must retain every complete authenticated envelope, including copies. */
export function assertEncryptedBlocksPreserved(before: string, format: string, after: string, nextFormat: string): void {
  const encoded = (content: string, kind: string) => encryptedBlocksInContent(content, kind).map((block) => JSON.stringify(block)).sort();
  if (JSON.stringify(encoded(before, format)) !== JSON.stringify(encoded(after, nextFormat))) throw new EncryptedContentError("invalid");
}

/** Transport declaration only; do not persist it as document content. */
export function withEncryptedBlocksSupport<T extends { content?: unknown }>(payload: T): T & { encryptedBlocksVersion?: 1 } {
  return typeof payload.content === "string" ? { ...payload, encryptedBlocksVersion: 1 } : payload;
}

export function isProtectedNotePayload(payload: { content?: unknown; contentFormat?: unknown } | null | undefined): boolean {
  if (typeof payload?.contentFormat === "string" && payload.contentFormat.startsWith("encrypted-")) return true;
  if (typeof payload?.content !== "string") return false;
  const format = typeof payload.contentFormat === "string" ? payload.contentFormat : payload.content.trim().startsWith("{") ? "tiptap-json" : "markdown";
  try { return encryptedBlocksInContent(payload.content, format).length > 0; }
  catch { return /nowen-encrypted/i.test(payload.content); }
}

import { EncryptedContentError, validateEnvelope, type EncryptedContentEnvelope } from "./envelope";
import type { JSONContent } from "@tiptap/core";

export const ENCRYPTED_NOTE_FORMAT = "encrypted-note-v1";
export const ENCRYPTED_NOTE_LEAVE_EVENT = "nowen:encrypted-note-before-leave";
export const isEncryptedNoteFormat = (format: unknown): boolean => typeof format === "string" && format.startsWith("encrypted-");
export function readEncryptedNoteDocument(note: { contentFormat?: string; content: string }): EncryptedContentEnvelope {
  if (note.contentFormat !== ENCRYPTED_NOTE_FORMAT) throw new EncryptedContentError("invalid");
  let value: unknown;
  try { value = JSON.parse(note.content); } catch { throw new EncryptedContentError("invalid"); }
  const envelope = validateEnvelope(value);
  if (envelope.kind !== "note") throw new EncryptedContentError("invalid");
  return envelope;
}

/** Text-only first delivery: no attachments, embeds, external images or opaque nodes. */
export function validateEncryptedNotePlaintext(content: string, format: EncryptedContentEnvelope["originalFormat"]): void {
  if (format === "markdown") {
    if (/!\[|!\[\[|<(?:img|audio|video|iframe|object|embed)\b|\/api\/attachments\/|data:(?:image|audio|video)\//i.test(content)) throw new EncryptedContentError("invalid");
    return;
  }
  let doc: unknown;
  try { doc = JSON.parse(content); } catch { throw new EncryptedContentError("invalid"); }
  const nodes = new Set(["doc", "paragraph", "heading", "text", "bulletList", "orderedList", "listItem", "blockquote", "hardBreak", "codeBlock", "horizontalRule"]);
  const marks = new Set(["bold", "italic", "strike", "code"]);
  const walk = (value: unknown, depth: number): void => {
    const node = value as JSONContent;
    if (!node || typeof node !== "object" || depth > 100 || !nodes.has(node.type || "")) throw new EncryptedContentError("invalid");
    if (node.marks !== undefined && (!Array.isArray(node.marks) || node.marks.some((mark) => !marks.has(mark?.type)))) throw new EncryptedContentError("invalid");
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) throw new EncryptedContentError("invalid");
      for (const child of node.content) walk(child, depth + 1);
    }
  };
  if ((doc as JSONContent)?.type !== "doc") throw new EncryptedContentError("invalid");
  walk(doc, 0);
}

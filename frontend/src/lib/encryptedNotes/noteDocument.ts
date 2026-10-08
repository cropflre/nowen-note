import { EncryptedContentError, validateEnvelope, type EncryptedContentEnvelope } from "./envelope";
import type { JSONContent } from "@tiptap/core";
import { ENCRYPTED_NOTE_V2_FORMAT, validateEnvelopeV2, type ContentEnvelopeV2 } from "./envelopeV2";

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

/** Storage boundary accepts both supported protocols without interpreting private document bodies. */
export function readEncryptedNoteEnvelope(note: { contentFormat?: string; content: string }): EncryptedContentEnvelope | ContentEnvelopeV2 {
  if (note.contentFormat !== ENCRYPTED_NOTE_V2_FORMAT) return readEncryptedNoteDocument(note);
  let value: unknown;
  try { value = JSON.parse(note.content); } catch { throw new EncryptedContentError("invalid"); }
  const envelope = validateEnvelopeV2(value);
  if (envelope.kind !== "note") throw new EncryptedContentError("invalid");
  return envelope;
}

/** Native writes/downloads share the server's fail-closed envelope/identity boundary. */
export function validateEncryptedNoteWrite(patch: Record<string, unknown>, current?: Record<string, unknown>): void {
  const wasEncrypted = isEncryptedNoteFormat(current?.contentFormat);
  if (!wasEncrypted && !isEncryptedNoteFormat(patch.contentFormat)) return;
  if (current && !wasEncrypted) throw new EncryptedContentError("invalid");
  if (patch.contentFormat !== undefined && ![ENCRYPTED_NOTE_FORMAT, ENCRYPTED_NOTE_V2_FORMAT].includes(patch.contentFormat as string)) throw new EncryptedContentError("invalid");
  if (wasEncrypted && patch.contentFormat !== undefined && patch.contentFormat !== current?.contentFormat) throw new EncryptedContentError("invalid");
  if (patch.contentText !== undefined && patch.contentText !== "") throw new EncryptedContentError("invalid");
  if (patch.content !== undefined || !current) {
    if (typeof patch.contentFormat !== "string" || typeof patch.content !== "string") throw new EncryptedContentError("invalid");
    const next = readEncryptedNoteEnvelope({ contentFormat: patch.contentFormat, content: patch.content });
    if (current) {
      if (typeof current.content !== "string" || typeof current.contentFormat !== "string") throw new EncryptedContentError("invalid");
      const previous = readEncryptedNoteEnvelope({ content: current.content, contentFormat: current.contentFormat });
      if (next.objectId !== previous.objectId || next.originalFormat !== previous.originalFormat) throw new EncryptedContentError("invalid");
      if (next.version === 2 && previous.version === 2 && (next.keyEpoch !== previous.keyEpoch || next.encryptionEpoch !== previous.encryptionEpoch)) throw new EncryptedContentError("invalid");
    }
  }
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

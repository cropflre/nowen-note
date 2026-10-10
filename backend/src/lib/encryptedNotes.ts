export const ENCRYPTED_NOTE_FORMAT = "encrypted-note-v1";
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_ENVELOPE_CHARACTERS = Math.ceil((MAX_PAYLOAD_BYTES + 16) / 3) * 4 + 2048;
export const isEncryptedNoteFormat = (value: unknown): boolean => typeof value === "string" && value.startsWith("encrypted-");

export class EncryptedNotePayloadError extends Error {
  readonly code = "INVALID_ENCRYPTED_NOTE";
  constructor() { super("加密笔记仅接受受支持的密文，不能降级或转换既有笔记"); }
}
export function encryptedRecord(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new EncryptedNotePayloadError();
  return value as Record<string, any>;
}
export function encryptedBytes(value: unknown, min: number, max = min): void {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new EncryptedNotePayloadError();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < min || decoded.length > max || decoded.toString("base64") !== value) throw new EncryptedNotePayloadError();
}
const object = encryptedRecord;
const bytes = encryptedBytes;
/** Structural verification only: the server never has a key and cannot authenticate GCM. */
export function parseEncryptedNote(content: unknown): { objectId: string; originalFormat: "markdown" | "tiptap-json" } {
  return parseEncryptedContent(content, "note");
}
export function parseEncryptedContent(content: unknown, kind: "note" | "block"): { objectId: string; originalFormat: "markdown" | "tiptap-json" } {
  if (typeof content !== "string" || content.length > MAX_ENVELOPE_CHARACTERS) throw new EncryptedNotePayloadError();
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new EncryptedNotePayloadError(); }
  const envelope = object(parsed, ["version", "algorithm", "objectId", "kind", "originalFormat", "kdf", "wrappedKey", "payload"]);
  if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM" || envelope.kind !== kind
    || typeof envelope.objectId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(envelope.objectId)
    || !["markdown", "tiptap-json"].includes(envelope.originalFormat)) throw new EncryptedNotePayloadError();
  const kdf = object(envelope.kdf, ["algorithm", "version", "memoryKiB", "iterations", "parallelism", "salt"]);
  if (kdf.algorithm !== "argon2id" || kdf.version !== 19 || kdf.memoryKiB !== 65536 || kdf.iterations !== 3 || kdf.parallelism !== 4) throw new EncryptedNotePayloadError();
  bytes(kdf.salt, 16);
  const wrapped = object(envelope.wrappedKey, ["iv", "ciphertext"]);
  const payload = object(envelope.payload, ["iv", "ciphertext"]);
  bytes(wrapped.iv, 12); bytes(wrapped.ciphertext, 48);
  bytes(payload.iv, 12); bytes(payload.ciphertext, 16, MAX_PAYLOAD_BYTES + 16);
  if (wrapped.iv === payload.iv) throw new EncryptedNotePayloadError();
  return { objectId: envelope.objectId, originalFormat: envelope.originalFormat };
}
export function guardEncryptedNoteMutation(body: Record<string, any>, current?: { content: string; contentFormat: string }): void {
  if (current && body.content === undefined && body.contentFormat !== undefined && body.contentFormat !== current.contentFormat
    && !isEncryptedNoteFormat(current.contentFormat) && encryptedBlocksInContent(current.content, current.contentFormat).length) throw new EncryptedNotePayloadError();
  if (typeof body.content === "string" && !isEncryptedNoteFormat(body.contentFormat) && !isEncryptedNoteFormat(current?.contentFormat)) {
    const nextFormat = body.contentFormat ?? current?.contentFormat ?? "tiptap-json";
    const next = encryptedBlocksInContent(body.content, nextFormat);
    const previous = current ? encryptedBlocksInContent(current.content, current.contentFormat) : [];
    if (previous.length && !["markdown", "tiptap-json", "richtext"].includes(nextFormat)) throw new EncryptedNotePayloadError();
    for (const block of next) {
      const old = previous.find((item) => item.objectId === block.objectId);
      if (old && old.originalFormat !== block.originalFormat) throw new EncryptedNotePayloadError();
    }
  }
  const wasEncrypted = isEncryptedNoteFormat(current?.contentFormat);
  const encrypted = wasEncrypted || isEncryptedNoteFormat(body.contentFormat);
  if (!encrypted) return;
  if (body.contentFormat !== undefined && body.contentFormat !== ENCRYPTED_NOTE_FORMAT) throw new EncryptedNotePayloadError();
  if (current && !wasEncrypted) throw new EncryptedNotePayloadError();
  if (body.contentText !== undefined && body.contentText !== "") throw new EncryptedNotePayloadError();
  if (body.content !== undefined || !current) {
    // An old client cannot overwrite an encrypted note through an unmarked whole-save.
    if (body.contentFormat !== ENCRYPTED_NOTE_FORMAT) throw new EncryptedNotePayloadError();
    const next = parseEncryptedNote(body.content);
    if (current) {
      const previous = parseEncryptedNote(current.content);
      if (next.objectId !== previous.objectId || next.originalFormat !== previous.originalFormat) throw new EncryptedNotePayloadError();
    }
    body.contentText = "";
  }
}

export const ENCRYPTED_BLOCK_LANGUAGE = "nowen-encrypted-v1";
export const isEncryptedBlockLanguage = (value: unknown): boolean => typeof value === "string" && value.toLowerCase().startsWith("nowen-encrypted");
export function encryptedBlocksInContent(content: string, format: string): Array<{ objectId: string; originalFormat: "markdown" | "tiptap-json"; serialized: string }> {
  const blocks: Array<{ objectId: string; originalFormat: "markdown" | "tiptap-json"; serialized: string }> = [];
  const add = (source: string, language: string) => {
    if (language.toLowerCase() !== ENCRYPTED_BLOCK_LANGUAGE) throw new EncryptedNotePayloadError();
    blocks.push({ ...parseEncryptedContent(source, "block"), serialized: JSON.stringify(JSON.parse(source)) });
  };
  if (format === "markdown") {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const opening = lines[i].match(/^([ \t>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/);
      if (!opening) continue;
      const [, , fence, info] = opening;
      let end = i + 1;
      while (end < lines.length) {
        const closing = lines[end].match(/^[ \t>]*(`{3,}|~{3,})[ \t]*\r?$/);
        if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) break;
        end++;
      }
      if (isEncryptedBlockLanguage(info.trim())) {
        if (end === lines.length) throw new EncryptedNotePayloadError();
        add(lines.slice(i + 1, end).map((line) => line.replace(/^[ \t]*(?:>[ \t]*)+/, "")).join("\n"), info.trim());
      }
      i = end;
    }
  } else if (["tiptap-json", "richtext"].includes(format)) {
    let doc: any;
    try { doc = JSON.parse(content); } catch { return blocks; }
    const walk = (node: any, depth: number): void => {
      if (depth > 100) throw new EncryptedNotePayloadError();
      if (!node) return;
      if (node.type === "codeBlock" && isEncryptedBlockLanguage(node.attrs?.language)) {
        if (!Array.isArray(node.content) || node.content.some((child: any) => child.type !== "text" || typeof child.text !== "string")) throw new EncryptedNotePayloadError();
        add(node.content.map((child: any) => child.text).join(""), node.attrs.language); return;
      }
      if (Array.isArray(node.content)) for (const child of node.content) walk(child, depth + 1);
    };
    walk(doc, 0);
  }
  return blocks;
}

/** Wire capability, not a secret or database field. Older writers cannot silently erase regions. */
export function withEncryptedBlocksSupport<T extends Record<string, any>>(payload: T): T & { encryptedBlocksVersion?: 1 } {
  return typeof payload.content === "string" ? { ...payload, encryptedBlocksVersion: 1 } : payload;
}
export function guardEncryptedBlockWriter(body: Record<string, any>, current?: { content: string; contentFormat: string }): boolean {
  if (typeof body.content !== "string" || isEncryptedNoteFormat(body.contentFormat) || isEncryptedNoteFormat(current?.contentFormat)) return false;
  const next = encryptedBlocksInContent(body.content, body.contentFormat ?? current?.contentFormat ?? "tiptap-json");
  const previous = current ? encryptedBlocksInContent(current.content, current.contentFormat) : [];
  const protectedWrite = next.length > 0 || previous.length > 0;
  if (protectedWrite && body.encryptedBlocksVersion !== 1) throw new EncryptedNotePayloadError();
  return protectedWrite;
}

export function isProtectedNotePayload(payload: Record<string, any> | null | undefined): boolean {
  if (isEncryptedNoteFormat(payload?.contentFormat)) return true;
  if (typeof payload?.content !== "string") return false;
  const format = typeof payload.contentFormat === "string" ? payload.contentFormat : payload.content.trim().startsWith("{") ? "tiptap-json" : "markdown";
  try { return encryptedBlocksInContent(payload.content, format).length > 0; }
  catch { return /nowen-encrypted/i.test(payload.content); }
}

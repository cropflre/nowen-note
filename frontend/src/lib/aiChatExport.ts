/**
 * Recognizes an AI chat export among files chosen for "Import notes", so it can go to the AI conversation
 * archive instead of becoming one huge note. Reads only the ZIP's central directory (nothing is unpacked)
 * or the start of a JSON file. Anything it cannot read confidently is left to the normal import.
 */
export type AIChatExport = { file: File; provider: "chatgpt" | "standard" };

const CHATGPT_CONVERSATIONS = /(^|\/)conversations(-\d+)?\.json$/i;
const ZIP_TAIL_BYTES = 22 + 65_535;
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
const JSON_SNIFF_BYTES = 64 * 1024;

async function bytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Entry names from a ZIP's central directory; null when it is not a plain (non-ZIP64) archive. */
export async function zipEntryNames(file: Blob): Promise<string[] | null> {
  const tailSize = Math.min(file.size, ZIP_TAIL_BYTES);
  if (tailSize < 22) return null;
  const tail = new DataView(await bytes(file.slice(file.size - tailSize)));
  let end = -1;
  for (let at = tail.byteLength - 22; at >= 0; at--) if (tail.getUint32(at, true) === 0x06054b50) { end = at; break; }
  if (end < 0) return null;
  const count = tail.getUint16(end + 10, true), size = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || size > MAX_DIRECTORY_BYTES || offset + size > file.size) return null;
  const directory = new DataView(await bytes(file.slice(offset, offset + size)));
  const decoder = new TextDecoder();
  const names: string[] = [];
  for (let at = 0; names.length < count;) {
    if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== 0x02014b50) return null;
    const nameLength = directory.getUint16(at + 28, true), extraLength = directory.getUint16(at + 30, true), commentLength = directory.getUint16(at + 32, true);
    if (at + 46 + nameLength > directory.byteLength) return null;
    names.push(decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

export async function detectAIChatExport(files: ReadonlyArray<{ file: File }>): Promise<AIChatExport | null> {
  if (files.length !== 1) return null;
  const file = files[0].file;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".zip")) {
      const names = await zipEntryNames(file);
      return names?.some((entry) => CHATGPT_CONVERSATIONS.test(entry)) ? { file, provider: "chatgpt" } : null;
    }
    if (!name.endsWith(".json")) return null;
    if (CHATGPT_CONVERSATIONS.test(name)) return { file, provider: "chatgpt" };
    const head = new TextDecoder().decode(await bytes(file.slice(0, JSON_SNIFF_BYTES)));
    if (/"format"\s*:\s*"nowen-ai-conversation"/.test(head)) return { file, provider: "standard" };
    if (/"mapping"\s*:/.test(head) && /"current_node"\s*:/.test(head)) return { file, provider: "chatgpt" };
    if (/"externalConversationId"\s*:/.test(head) && /"messages"\s*:/.test(head)) return { file, provider: "standard" };
    return null;
  } catch {
    return null;
  }
}

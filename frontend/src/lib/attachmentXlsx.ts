import { parseWorkbookXlsx, XLSX_PREVIEW_LIMITS, XlsxError } from "@/lib/sheetXlsx";

export async function loadAttachmentWorkbook(url: string, size: number, signal: AbortSignal) {
  if (size > XLSX_PREVIEW_LIMITS.fileBytes) throw new XlsxError("limit", "XLSX file size limit exceeded");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("Content-Length")) > XLSX_PREVIEW_LIMITS.fileBytes) {
    await response.body?.cancel();
    throw new XlsxError("limit", "XLSX file size limit exceeded");
  }
  const reader = response.body?.getReader();
  let buffer: ArrayBuffer;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > XLSX_PREVIEW_LIMITS.fileBytes) {
          await reader.cancel();
          throw new XlsxError("limit", "XLSX file size limit exceeded");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    buffer = bytes.buffer;
  } else {
    buffer = await response.arrayBuffer();
  }
  signal.throwIfAborted();
  return parseWorkbookXlsx(buffer);
}

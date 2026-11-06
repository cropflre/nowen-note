import type { jsPDF } from "jspdf";
import { AI_PROVENANCE_ATTRIBUTE, parseAiProvenanceJson, type AiProvenance } from "./aiContentProvenance";

/** jsPDF 4.x writes its document-properties dictionary into the PDF Info object.
 * Keep this adapter covered by a real PDF parse: its custom-property hook is private. */
export function addAiPdfMetadata(pdf: jsPDF, provenance: AiProvenance | null): void {
  if (!provenance) return;
  const adapter = pdf as unknown as { __private__?: { getDocumentProperties?: () => Record<string, string> } };
  const properties = adapter.__private__?.getDocumentProperties?.();
  if (!properties) throw new Error("AI_PDF_METADATA_UNAVAILABLE");
  properties.AIGC = JSON.stringify(provenance).replace(/[\u007f-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const XMP_HEADER = encoder.encode("http://ns.adobe.com/xap/1.0/\0");
const PNG_XMP_KEYWORD = "XML:com.adobe.xmp";
const AIGC_NAMESPACE = "http://www.tc260.org.cn/ns/AIGC/1.0";

function join(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(data.length + 12);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(encoder.encode(type), 4);
  output.set(data, 8);
  view.setUint32(output.length - 4, crc32(output.subarray(4, output.length - 4)));
  return output;
}

/** TC260 PNG XMP profile for fresh exports, without recompressing image pixels. */
export function addAiPngMetadata(bytes: Uint8Array, provenance: AiProvenance): Uint8Array {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new Error("INVALID_PNG");
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // TC260's sample uses a trailing slash. The detector recognizes this form.
  const xmp = aiXmpMetadata(provenance, AIGC_NAMESPACE + "/");
  let offset = 8, ended = false, inserted = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error("INVALID_PNG");
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, end - 4);
    if (!inserted && type === "IDAT") {
      // Keyword terminator, compression flag and method, empty language tag and translated keyword.
      parts.push(pngChunk("iTXt", encoder.encode(`${PNG_XMP_KEYWORD}\0\0\0\0\0${xmp}`)));
      inserted = true;
    }
    if (type === "IEND") {
      parts.push(bytes.subarray(offset, end));
      ended = true;
      if (end !== bytes.length) throw new Error("INVALID_PNG");
      break;
    }
    const keywordEnd = data.indexOf(0);
    const keyword = ["tEXt", "iTXt", "zTXt"].includes(type) && keywordEnd >= 0
      ? decoder.decode(data.subarray(0, keywordEnd)) : "";
    if (keyword === PNG_XMP_KEYWORD) {
      // Only replace packets written by this exporter. Preserve other metadata by failing closed.
      const packet = decoder.decode(data.subarray(keywordEnd + 5));
      const withoutValue = (value: string) => value.replace(/(<TC260:AIGC>)[^<]*(<\/TC260:AIGC>)/, "$1$2");
      if (type !== "iTXt" || !data.subarray(keywordEnd + 1, keywordEnd + 5).every(value => value === 0)
        || withoutValue(packet) !== withoutValue(xmp)) {
        throw new Error("UNEXPECTED_PNG_XMP");
      }
    } else if (keyword !== "AIGC") {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  if (!ended || !inserted) throw new Error("INVALID_PNG");
  return join(parts);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function aiXmpMetadata(provenance: AiProvenance, namespace = AIGC_NAMESPACE): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:TC260="${namespace}"><TC260:AIGC>${escapeXml(JSON.stringify(provenance))}</TC260:AIGC></rdf:Description></rdf:RDF></x:xmpmeta>`;
}

function jpegXmp(provenance: AiProvenance): Uint8Array {
  const payload = join([XMP_HEADER, encoder.encode(aiXmpMetadata(provenance))]);
  if (payload.length + 2 > 65535) throw new Error("AI_JPEG_METADATA_TOO_LARGE");
  const header = new Uint8Array([0xff, 0xe1, (payload.length + 2) >>> 8, (payload.length + 2) & 255]);
  return join([header, payload]);
}

/** Input is a fresh canvas JPEG. Never rewrite an uploaded user's image. */
export function addAiJpegMetadata(bytes: Uint8Array, provenance: AiProvenance): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("INVALID_JPEG");
  const parts: Uint8Array[] = [bytes.subarray(0, 2), jpegXmp(provenance)];
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error("INVALID_JPEG");
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      parts.push(bytes.subarray(offset));
      return join(parts);
    }
    if (offset + 4 > bytes.length) throw new Error("INVALID_JPEG");
    const length = bytes[offset + 2] * 256 + bytes[offset + 3], end = offset + 2 + length;
    if (length < 2 || end > bytes.length) throw new Error("INVALID_JPEG");
    const payload = bytes.subarray(offset + 4, end);
    const xmp = marker === 0xe1 && XMP_HEADER.every((value, index) => payload[index] === value);
    if (xmp) {
      const xml = decoder.decode(payload.subarray(XMP_HEADER.length));
      // Our generated JPEG has either no XMP or only this adapter's AIGC packet.
      // Fail closed rather than discard an unrelated packet from a changed renderer.
      if (!xml.includes('<TC260:AIGC>') || /<(?:dc|photoshop|exif):/.test(xml)) {
        throw new Error("UNEXPECTED_JPEG_XMP");
      }
    } else parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  throw new Error("INVALID_JPEG");
}

export async function addAiImageMetadata(blob: Blob, provenance: AiProvenance | null): Promise<Blob> {
  if (!provenance) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const output = blob.type === "image/png" ? addAiPngMetadata(bytes, provenance)
    : blob.type === "image/jpeg" ? addAiJpegMetadata(bytes, provenance) : null;
  if (!output) throw new Error("UNSUPPORTED_AI_IMAGE_FORMAT");
  return new Blob([output], { type: blob.type });
}

/** Includes labeled generated embeds whose content is hydrated only at export time. */
export function readHtmlAiProvenance(html: string): AiProvenance | null {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll(`[${AI_PROVENANCE_ATTRIBUTE}]`)) {
    const provenance = parseAiProvenanceJson(element.getAttribute(AI_PROVENANCE_ATTRIBUTE));
    if (provenance) return provenance;
  }
  return null;
}

/** Fresh OOXML reports: declare one custom AIGC property and link it through OPC. */
export async function addAiOoxmlMetadata(bytes: ArrayBuffer, provenance: AiProvenance | null): Promise<ArrayBuffer> {
  if (!provenance) return bytes;
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  if (zip.file("docProps/custom.xml")) throw new Error("UNEXPECTED_OOXML_CUSTOM_PROPERTIES");
  const types = await zip.file("[Content_Types].xml")?.async("string");
  const relationships = await zip.file("_rels/.rels")?.async("string");
  if (!types?.includes("</Types>") || !relationships?.includes("</Relationships>")) throw new Error("INVALID_OOXML_PACKAGE");
  zip.file("docProps/custom.xml", `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="AIGC"><vt:lpwstr>${escapeXml(JSON.stringify(provenance))}</vt:lpwstr></property></Properties>`);
  zip.file("[Content_Types].xml", types.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>'));
  zip.file("_rels/.rels", relationships.replace("</Relationships>", '<Relationship Id="rIdAigc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'));
  return zip.generateAsync({ type: "arraybuffer" });
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { jsPDF } from "jspdf";
import JSZip from "jszip";
import { addAiJpegMetadata, addAiPdfMetadata, addAiPngMetadata } from "../aiExportMetadata";
import { aiProvenanceParagraph, createAiProvenance } from "../aiContentProvenance";
import { tiptapToIr } from "@/office/serializers/tiptap-to-ir";
import { createDocx } from "@/office/serializers/docx-serializer";

const provenance = createAiProvenance("generation-123");
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+A6WQAAAAASUVORK5CYII=", "base64"));

function pngChunks(bytes: Uint8Array) {
  const chunks: Array<{ type: string; data: Uint8Array; crc: number }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset < bytes.length;) {
    const size = view.getUint32(offset);
    chunks.push({ type: new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)),
      data: bytes.subarray(offset + 8, offset + 8 + size), crc: view.getUint32(offset + 8 + size) });
    offset += size + 12;
  }
  return chunks;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("AI metadata in actual export files", () => {
  it("writes one valid AIGC PNG chunk and preserves compressed pixels", () => {
    const result = addAiPngMetadata(addAiPngMetadata(png, provenance), provenance);
    saveEngineeringFixture("fixture-ai.png", result);
    const chunks = pngChunks(result), metadata = chunks.filter(chunk => chunk.type === "iTXt");
    expect(metadata).toHaveLength(1);
    const text = new TextDecoder().decode(metadata[0].data);
    const prefix = "XML:com.adobe.xmp\0\0\0\0\0";
    expect(text.startsWith(prefix)).toBe(true);
    const xml = new DOMParser().parseFromString(text.slice(prefix.length), "application/xml");
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(JSON.parse(xml.getElementsByTagNameNS("http://www.tc260.org.cn/ns/AIGC/1.0/", "AIGC")[0].textContent!))
      .toEqual(provenance);
    const checksumInput = Buffer.concat([Buffer.from("iTXt"), metadata[0].data]);
    expect(metadata[0].crc).toBe(crc32(checksumInput));
    expect(chunks.filter(chunk => chunk.type === "IDAT").map(chunk => [...chunk.data]))
      .toEqual(pngChunks(png).filter(chunk => chunk.type === "IDAT").map(chunk => [...chunk.data]));
    expect(chunks.at(-1)?.type).toBe("IEND");
    expect(() => addAiPngMetadata(png.subarray(0, png.length - 5), provenance)).toThrow("INVALID_PNG");
  });

  it("writes TC260 XMP into JPEG without changing the scan data or duplicating the packet", () => {
    const original = new Uint8Array(readFileSync(path.join(process.cwd(), "src/assets/sponsor/weixin.jpg")));
    const result = addAiJpegMetadata(addAiJpegMetadata(original, provenance), provenance);
    saveEngineeringFixture("fixture-ai.jpg", result);
    const text = new TextDecoder().decode(result);
    expect(text.split("<TC260:AIGC>")).toHaveLength(2);
    const xml = text.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/)![0];
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(JSON.parse(parsed.getElementsByTagNameNS("http://www.tc260.org.cn/ns/AIGC/1.0", "AIGC")[0].textContent!))
      .toEqual(provenance);
    const scan = (bytes: Uint8Array) => Buffer.from(bytes).subarray(Buffer.from(bytes).indexOf(Buffer.from([255, 218])));
    expect(scan(result)).toEqual(scan(original));
    expect(() => addAiJpegMetadata(new Uint8Array([1, 2, 3]), provenance)).toThrow("INVALID_JPEG");
  });

  it("writes a dedicated AIGC field in a generated PDF's Info dictionary", () => {
    const pdf = new jsPDF();
    pdf.text("AI-generated content", 20, 20);
    addAiPdfMetadata(pdf, provenance);
    saveEngineeringFixture("fixture-ai.pdf", pdf.output("arraybuffer"));
    const output = pdf.output();
    const metadata = output.match(/\/AIGC \(([^\n]+)\)/)?.[1];
    expect(metadata).toBeTruthy();
    expect(JSON.parse(metadata!)).toEqual(provenance);
    expect(output).toContain("/Type /Page");
    const manual = new jsPDF();
    addAiPdfMetadata(manual, null);
    expect(manual.output()).not.toContain("/AIGC");
  });

  it("writes Word custom properties and OPC relationships while preserving the body", async () => {
    const doc = { type: "doc", content: [aiProvenanceParagraph(provenance),
      { type: "paragraph", content: [{ type: "text", text: "中文正文" }] }] };
    const ir = await tiptapToIr(doc);
    const bytes = await readBlob(await createDocx(ir));
    saveEngineeringFixture("fixture-ai.docx", bytes);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("docProps/custom.xml")!.async("string");
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.querySelectorAll('property[name="AIGC"]')).toHaveLength(1);
    expect(JSON.parse(parsed.querySelector('property[name="AIGC"]')!.textContent!)).toEqual(provenance);
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain('PartName="/docProps/custom.xml"');
    expect(await zip.file("_rels/.rels")!.async("string")).toContain('Target="docProps/custom.xml"');
    const body = await zip.file("word/document.xml")!.async("string");
    expect(body).toContain("中文正文");
    expect(body).toContain("AI 生成内容");
    const manualIr = await tiptapToIr({ type: "doc", content: doc.content.slice(1) });
    const manual = await JSZip.loadAsync(await readBlob(await createDocx(manualIr)));
    expect(manual.file("docProps/custom.xml")).toBeNull();
  });
});

// Optional engineering fixtures for independent format parsers. These are test data,
// not real model outputs or AppGallery evidence.
function saveEngineeringFixture(name: string, bytes: Uint8Array | ArrayBuffer) {
  const directory = process.env.NOWEN_AI_EXPORT_FIXTURES_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), new Uint8Array(bytes));
}

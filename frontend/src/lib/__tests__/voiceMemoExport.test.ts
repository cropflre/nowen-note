import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getExportNotes: vi.fn(), saveAs: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: mocks.saveAs }));
vi.mock("@/lib/api", () => ({ api: { getExportNotes: mocks.getExportNotes }, resolveAttachmentUrl: (src: string) => src }));
import { exportNotebook } from "../exportServiceCore";
import { readMarkdownFromZipWithMeta, convertToTiptapJson } from "../importService.base";

const id = "11fe46d6-1a50-4a3b-b251-8486a1e7e9ea";
const src = `/api/attachments/${id}`;
describe("voice memo export and import", () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/webm", "Content-Disposition": 'attachment; filename="voice.webm"' } }))); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it.each(["markdown", "tiptap-json"])("includes audio assets for %s notes, including inline image export mode", async (contentFormat) => {
    const content = contentFormat === "markdown" ? `<audio controls><source src="${src}" type="audio/webm"></audio>` : JSON.stringify({ type: "doc", content: [{ type: "voiceMemo", attrs: { attachmentId: id, src, filename: "voice.webm", mimeType: "audio/webm", durationMs: 1234 } }] });
    mocks.getExportNotes.mockResolvedValue([{ id: "note-1", title: "Voice", content, contentText: "", contentFormat, notebookId: "nb-1", notebookName: "Memo", createdAt: "2026-09-30", updatedAt: "2026-09-30" }]);
    expect(await exportNotebook({ notebookId: "nb-1", notebookName: "Memo", descendantNotebookIds: new Set(["nb-1"]) }, undefined, { inlineImages: true })).toBe(true);
    const exported = mocks.saveAs.mock.calls[0][0] as Blob;
    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(exported);
    });
    const zip = await JSZip.loadAsync(data);
    expect(zip.file("Memo/assets/voice.webm")).not.toBeNull();
    const markdown = await zip.file("Memo/Voice.md")!.async("string");
    expect(markdown).toContain("<audio"); expect(markdown).toContain("./assets/voice.webm"); expect(markdown).not.toContain(src);
    const file = Object.assign(new Uint8Array(data), { name: "Voice.zip" }) as unknown as File;
    const imported = await readMarkdownFromZipWithMeta(file);
    expect(JSON.stringify(imported)).toContain("data:audio/webm;base64,AQID");
    expect(convertToTiptapJson(imported.files[0])).toContain("data:audio/webm;base64,AQID");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { readYuqueExport, importYuqueFiles, yuqueImportNoteId } from "../yuqueFileImport";

const mocks = vi.hoisted(() => ({ getNote: vi.fn(), createNote: vi.fn(), notebooks: vi.fn(), createNotebook: vi.fn(), scope: "server:user" }));
vi.mock("../api", () => ({ api: {
  getNote: mocks.getNote, createNoteConfirmed: mocks.createNote,
  getNotebooks: mocks.notebooks, createNotebook: mocks.createNotebook,
} }));
vi.mock("../offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));

const options = { userId: "user-1", workspaceId: "personal", rootName: "语雀导入" };
const notes = new Map<string, any>();
beforeEach(() => {
  vi.clearAllMocks(); notes.clear();
  mocks.scope = "server:user";
  mocks.getNote.mockImplementation(async (id) => {
    const note = notes.get(id);
    if (!note) throw Object.assign(new Error("not found"), { status: 404 });
    return note;
  });
  mocks.notebooks.mockResolvedValue([]);
  mocks.createNotebook.mockImplementation(async (data) => ({ ...data, id: `folder-${mocks.createNotebook.mock.calls.length}` }));
  mocks.createNote.mockImplementation(async (data) => { notes.set(data.id, data); return data; });
});

async function archive(image = "image A") {
  const zip = new JSZip();
  zip.file("工作/项目/第一篇.md", '# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![图](images/a.png)\n\n```js\nconst value = 1;\n```');
  zip.file("工作/项目/images/a.png", image);
  zip.file("工作/其他/images/a.png", "different image");
  zip.file("工作/第二篇.md", "# 第二篇\n\n正文");
  return new File([await zip.generateAsync({ type: "uint8array" })], "工作.zip", { type: "application/zip" });
}

describe("Yuque Markdown file reading", () => {
  it("preserves directories, source Markdown and the correctly resolved bundled image", async () => {
    const docs = await readYuqueExport([await archive()]);
    expect(docs).toHaveLength(2);
    expect(docs[0].path).toEqual(["工作", "项目"]);
    expect(docs[0].content).toContain("| 1 | 2 |");
    expect(docs[0].content).toContain("const value = 1;");
    expect(docs[0].content).toContain("data:image/png;base64,aW1hZ2UgQQ==");
    expect(docs[0].images).toBe(1);
    expect(docs[0].warnings).toEqual([]);
  });
  it("reports remote and missing images without downloading or discarding references", async () => {
    const [doc] = await readYuqueExport([new File(['![remote](https://example.com/private.png)\n![missing](missing.png)'], "文档.md")]);
    expect(doc.warnings).toEqual(expect.arrayContaining(["remoteImage", "missingAsset"]));
    expect(doc.content).toContain("https://example.com/private.png");
    expect(doc.content).toContain("missing.png");
  });
  it("rejects unsupported formats and archives with no Markdown", async () => {
    await expect(readYuqueExport([new File(["lake"], "文档.lake")])).rejects.toThrow("YUQUE_UNSUPPORTED_FILE");
    const zip = new JSZip(); zip.file("native.lake", "body");
    await expect(readYuqueExport([new File([await zip.generateAsync({ type: "uint8array" })], "native.zip")])).rejects.toThrow("YUQUE_NO_MARKDOWN");
  });
  it("does not silently discard conflicting documents with the same source path", async () => {
    await expect(readYuqueExport([new File(["A"], "同名.md"), new File(["B"], "同名.md")])).rejects.toThrow("YUQUE_DUPLICATE_SOURCE");
  });
  it("keeps Markdown image examples inside fenced and inline code unchanged", async () => {
    const zip = new JSZip();
    const code = '```md\n![example](a.png)\n```\n\n`![inline](a.png)`';
    zip.file("doc.md", `${code}\n\n![real](a.png)`); zip.file("a.png", "image");
    const [doc] = await readYuqueExport([new File([await zip.generateAsync({ type: "uint8array" })], "book.zip")]);
    expect(doc.content).toContain(code);
    expect(doc.content).toContain("![real](data:image/png;base64,");
  });
});

describe("Yuque import persistence and retry", () => {
  it("skips the same source on reimport and never overwrites edits made in Nowen", async () => {
    const docs = await readYuqueExport([await archive()]);
    const first = await importYuqueFiles(docs, options);
    expect(first.created).toBe(2);
    for (const note of notes.values()) note.content = "Edited in Nowen";
    const repeated = await importYuqueFiles(docs, options);
    expect(repeated.skipped).toBe(2);
    expect(mocks.createNote).toHaveBeenCalledTimes(2);
    expect([...notes.values()].every((note) => note.content === "Edited in Nowen")).toBe(true);
  });
  it("creates a new copy when a bundled image changes and isolates users and targets", async () => {
    const original = await readYuqueExport([await archive()]);
    const changed = await readYuqueExport([await archive("image B")]);
    await importYuqueFiles(original, options);
    const result = await importYuqueFiles(changed, options);
    expect(result.created).toBe(1); expect(result.skipped).toBe(1);
    const id = await yuqueImportNoteId(original[0], "user-1", "personal", "root");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await yuqueImportNoteId(original[0], "other-user", "personal", "root")).not.toBe(id);
    expect(await yuqueImportNoteId(original[0], "user-1", "team", "root")).not.toBe(id);
    expect(await yuqueImportNoteId(original[0], "user-1", "personal", "other-target")).not.toBe(id);
  });
  it("continues after a failure and retries only failed documents", async () => {
    const docs = await readYuqueExport([await archive()]);
    mocks.createNote.mockRejectedValueOnce(new Error("temporary failure"));
    const first = await importYuqueFiles(docs, options);
    expect(first.created).toBe(1); expect(first.failed).toHaveLength(1);
    const retry = await importYuqueFiles(docs.filter((doc) => first.failed.some((item) => item.key === doc.key)), options);
    expect(retry.created).toBe(1); expect(retry.failed).toEqual([]);
    expect(notes.size).toBe(2);
  });
  it("recovers a committed note after the response is lost without duplicating it", async () => {
    const docs = await readYuqueExport([new File(["Body"], "文档.md")]);
    mocks.createNote.mockImplementationOnce(async (data) => { notes.set(data.id, data); throw new Error("response lost"); });
    expect((await importYuqueFiles(docs, options)).failed).toHaveLength(1);
    expect((await importYuqueFiles(docs, options)).skipped).toBe(1);
    expect(mocks.createNote).toHaveBeenCalledTimes(1);
  });
  it("does not treat permission or network errors as proof the note does not exist", async () => {
    const docs = await readYuqueExport([new File(["Body"], "文档.md")]);
    mocks.getNote.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    expect((await importYuqueFiles(docs, options)).failed).toHaveLength(1);
    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.createNotebook).not.toHaveBeenCalled();
  });
  it("uses the confirmed normal creation API and explicit scope without requiring bulk HTTP import", async () => {
    const docs = await readYuqueExport([new File(["Body"], "文档.md")]);
    await importYuqueFiles(docs, { ...options, workspaceId: "team-1", targetNotebookId: "target-folder" });
    expect(mocks.createNote.mock.calls[0][0]).toMatchObject({ notebookId: "target-folder", content: "Body", contentFormat: "markdown" });
    expect(mocks.notebooks).not.toHaveBeenCalled();
  });
  it("accepts the Android repository's missing-note response and creates through the normal bridge", async () => {
    const docs = await readYuqueExport([new File(["Body"], "文档.md")]);
    mocks.getNote.mockRejectedValue(new Error("笔记不存在"));
    expect((await importYuqueFiles(docs, options)).created).toBe(1);
    expect(mocks.createNote.mock.calls[0][0].contentFormat).toBe("markdown");
  });
  it("stops further folder and note writes when the account changes during a read", async () => {
    const docs = await readYuqueExport([await archive()]);
    mocks.notebooks.mockImplementationOnce(async () => { mocks.scope = "server:other-user"; return []; });
    await importYuqueFiles(docs, options);
    expect(mocks.createNotebook).not.toHaveBeenCalled();
    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.getNote).toHaveBeenCalledTimes(1);
  });
});

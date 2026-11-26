import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findKnowledgeTreeDropRow,
  formatMarkdownImportFailures,
  hasExternalFilePayload,
  isMarkdownDropFile,
  isPptDropFile,
  isSheetDropFile,
  isWordDropFile,
  knowledgeTreeFilesFromDataTransfer,
  markdownDropTitle,
  markdownFilesFromDataTransfer,
  pickMarkdownFiles,
} from "@/lib/knowledgeTreeMarkdownDrop";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("knowledgeTreeMarkdownDrop", () => {
  it("accepts md and markdown files case-insensitively", () => {
    expect(isMarkdownDropFile({ name: "README.md" })).toBe(true);
    expect(isMarkdownDropFile({ name: "说明.MARKDOWN" })).toBe(true);
    expect(isMarkdownDropFile({ name: "notes.md.txt" })).toBe(false);
    expect(isMarkdownDropFile({ name: "archive.zip" })).toBe(false);
  });

  it("accepts docx files but rejects legacy doc files", () => {
    expect(isWordDropFile({ name: "租赁合同.docx" })).toBe(true);
    expect(isWordDropFile({ name: "REPORT.DOCX" })).toBe(true);
    expect(isWordDropFile({ name: "legacy.doc" })).toBe(false);
    expect(isWordDropFile({ name: "document.docx.zip" })).toBe(false);
  });

  it("accepts pptx and sheet (xlsx/csv) files while rejecting legacy binary Office formats", () => {
    expect(isPptDropFile({ name: "产品评审.pptx" })).toBe(true);
    expect(isPptDropFile({ name: "DECK.PPTX" })).toBe(true);
    expect(isPptDropFile({ name: "legacy.ppt" })).toBe(false);
    expect(isSheetDropFile({ name: "预算.xlsx" })).toBe(true);
    expect(isSheetDropFile({ name: "DATA.CSV" })).toBe(true);
    expect(isSheetDropFile({ name: "legacy.xls" })).toBe(false);
  });

  it("derives the note title from the file name", () => {
    expect(markdownDropTitle("产品需求.md")).toBe("产品需求");
    expect(markdownDropTitle("folder\\release.notes.MARKDOWN")).toBe("release.notes");
    expect(markdownDropTitle(".md")).toBe("未命名 Markdown");
  });

  it("detects an external file payload before the drop exposes File objects", () => {
    expect(hasExternalFilePayload({
      types: ["Files"] as unknown as DataTransfer["types"],
      items: [] as unknown as DataTransferItemList,
    })).toBe(true);
    expect(hasExternalFilePayload({
      types: ["text/plain"] as unknown as DataTransfer["types"],
      items: [] as unknown as DataTransferItemList,
    })).toBe(false);
  });

  it("keeps only Markdown files from a mixed drop", () => {
    const files = [
      new File(["# A"], "a.md", { type: "text/markdown" }),
      new File(["hello"], "b.txt", { type: "text/plain" }),
      new File(["# C"], "c.markdown", { type: "text/markdown" }),
    ];
    const selected = markdownFilesFromDataTransfer({
      files: files as unknown as FileList,
    });
    expect(selected.map((file) => file.name)).toEqual(["a.md", "c.markdown"]);
  });

  it("keeps Markdown, DOCX, PPTX and sheet files for knowledge-tree drops", () => {
    const files = [
      new File(["# A"], "a.md", { type: "text/markdown" }),
      new File(["word"], "contract.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      new File(["ppt"], "roadmap.pptx", {
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
      new File(["xlsx"], "budget.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      new File(["a,b\n1,2"], "metrics.csv", { type: "text/csv" }),
      new File(["legacy"], "legacy.doc", { type: "application/msword" }),
      new File(["legacy"], "legacy.ppt", { type: "application/vnd.ms-powerpoint" }),
      new File(["legacy"], "legacy.xls", { type: "application/vnd.ms-excel" }),
      new File(["hello"], "b.txt", { type: "text/plain" }),
    ];

    expect(knowledgeTreeFilesFromDataTransfer({
      files: files as unknown as FileList,
    }).map((file) => file.name)).toEqual(["a.md", "contract.docx", "roadmap.pptx", "budget.xlsx", "metrics.csv"]);
  });

  it("opens a multi-file Markdown picker", async () => {
    let picker: HTMLInputElement | null = null;
    const nativeCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      const element = nativeCreateElement(tagName);
      if (tagName === "input") picker = element as HTMLInputElement;
      return element;
    }) as typeof document.createElement);
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function click(this: HTMLInputElement) {
      Object.defineProperty(this, "files", {
        configurable: true,
        value: [
          new File(["# A"], "a.md", { type: "text/markdown" }),
          new File(["# B"], "b.markdown", { type: "text/markdown" }),
        ],
      });
      this.onchange?.(new Event("change"));
    });

    const files = await pickMarkdownFiles();
    const pickerElement = picker as unknown as HTMLInputElement;

    expect(pickerElement.accept).toContain(".md");
    expect(pickerElement.accept).toContain(".markdown");
    expect(pickerElement.multiple).toBe(true);
    expect(files.map((file) => file.name)).toEqual(["a.md", "b.markdown"]);
  });

  it("summarizes multiple isolated import failures", () => {
    expect(formatMarkdownImportFailures([
      { name: "损坏.md", reason: "读取失败" },
      { name: "过大.markdown", reason: "文件过大" },
    ])).toBe("损坏.md：读取失败；过大.markdown：文件过大");
  });

  it("resolves a drop row only inside an embedded knowledge tree", () => {
    const tree = document.createElement("section");
    tree.dataset.nowenKnowledgeTree = "embedded";
    const row = document.createElement("div");
    row.dataset.knowledgeTreeNodeId = "folder-1";
    const label = document.createElement("span");
    row.appendChild(label);
    tree.appendChild(row);
    document.body.appendChild(tree);

    expect(findKnowledgeTreeDropRow(label)).toBe(row);

    const unrelated = document.createElement("div");
    unrelated.dataset.knowledgeTreeNodeId = "outside";
    document.body.appendChild(unrelated);
    expect(findKnowledgeTreeDropRow(unrelated)).toBeNull();
  });

  it("imports Markdown ZIP with ../assets relative paths, Windows backslashes, vault-root paths, raw %, and Obsidian embeds while blocking root escapes", async () => {
    const JSZip = (await import("jszip")).default;
    const { api } = await import("@/lib/api");
    const { knowledgeTreeApi } = await import("@/lib/knowledgeTreeApi");
    const { importMarkdownZipFileIntoKnowledgeTree } = await import("@/lib/knowledgeTreeMarkdownDrop");

    let nextAttachment = 1;
    const uploadedFiles: string[] = [];
    let savedContent = "";

    vi.spyOn(knowledgeTreeApi, "create").mockResolvedValue({
      id: "node-1",
      resourceId: "note-1",
      nodeType: "markdown",
    } as never);
    vi.spyOn(knowledgeTreeApi, "remove").mockResolvedValue({} as never);
    vi.spyOn(api.attachments, "upload").mockImplementation(async (_noteId, file) => {
      uploadedFiles.push(file.name);
      const id = `att-${nextAttachment++}`;
      return { id, url: `/api/attachments/${id}` } as never;
    });
    vi.spyOn(api.attachments, "remove").mockResolvedValue({} as never);
    vi.spyOn(api, "getNote").mockResolvedValue({ id: "note-1", version: 1 } as never);
    vi.spyOn(api, "updateNoteConfirmed").mockImplementation(async (_id, patch) => {
      savedContent = String(patch.content || "");
      return { id: "note-1", title: patch.title, content: savedContent } as never;
    });

    const zip = new JSZip();
    zip.file("公众号/文章.md", [
      "# 公众号文章",
      "![图1](../assets/pic 1.png)",
      "![图2](..\\assets\\pic2.png)",
      "![图3](assets/100%_chart.png)",
      "![[pic3.png|300]]",
      "`![[code-example.png]]`",
    ].join("\n"));
    zip.file("assets/pic 1.png", new Uint8Array([137, 80, 78, 71]));
    zip.file("assets/pic2.png", new Uint8Array([137, 80, 78, 71]));
    zip.file("assets/100%_chart.png", new Uint8Array([137, 80, 78, 71]));
    zip.file("assets/pic3.png", new Uint8Array([137, 80, 78, 71]));
    zip.file("assets/code-example.png", new Uint8Array([137, 80, 78, 71]));
    const zipBytes = await zip.generateAsync({ type: "uint8array" });
    const zipFile = new File([zipBytes], "wechat.zip", { type: "application/zip" });

    const result = await importMarkdownZipFileIntoKnowledgeTree(zipFile, null);
    expect(result.failures).toEqual([]);
    expect(result.imported).toHaveLength(1);
    expect(uploadedFiles.sort()).toEqual(["100%_chart.png", "pic 1.png", "pic2.png", "pic3.png"]);
    expect(savedContent).toContain("/api/attachments/att-1");
    expect(savedContent).toContain("/api/attachments/att-4");
    expect(savedContent).toContain("`![[code-example.png]]`");

    // 越界逃逸出 ZIP 根目录的 ../../ 仍必须严格拒绝
    const escapeZip = new JSZip();
    escapeZip.file("公众号/bad.md", "![bad](../../outside.png)");
    const escapeBytes = await escapeZip.generateAsync({ type: "uint8array" });
    const escapeFile = new File([escapeBytes], "escape.zip", { type: "application/zip" });
    await expect(importMarkdownZipFileIntoKnowledgeTree(escapeFile, null)).rejects.toThrow(/超出压缩包根目录/);
  });
});

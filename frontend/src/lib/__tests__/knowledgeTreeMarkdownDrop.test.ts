import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findKnowledgeTreeDropRow,
  hasExternalFilePayload,
  isMarkdownDropFile,
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

  it("keeps Markdown and DOCX files for knowledge-tree drops", () => {
    const files = [
      new File(["# A"], "a.md", { type: "text/markdown" }),
      new File(["word"], "contract.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      new File(["legacy"], "legacy.doc", { type: "application/msword" }),
      new File(["hello"], "b.txt", { type: "text/plain" }),
    ];

    expect(knowledgeTreeFilesFromDataTransfer({
      files: files as unknown as FileList,
    }).map((file) => file.name)).toEqual(["a.md", "contract.docx"]);
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
});

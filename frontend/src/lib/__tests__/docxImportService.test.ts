// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  DOCX_IMPORT_LIMITS,
  getDocxArchiveViolation,
  getDocxFileViolation,
  getImportedNoteIntegrityError,
  getImportedNoteSemanticError,
} from "@/lib/docxImportSafety";
import {
  convertDocxHtmlToTiptap,
  docxHtmlToPlainText,
  extractTitleFromDocxHtml,
  replaceDocxImagePlaceholders,
} from "@/lib/docxImportService";

describe("DOCX import preflight", () => {
  it("rejects unsupported and oversized files before parsing", () => {
    expect(getDocxFileViolation({ name: "legacy.doc", size: 1024 })?.code).toBe("UNSUPPORTED_FILE");
    expect(getDocxFileViolation({
      name: "large.docx",
      size: DOCX_IMPORT_LIMITS.maxFileBytes + 1,
    })?.code).toBe("FILE_TOO_LARGE");
    expect(getDocxFileViolation({ name: "normal.docx", size: 28.5 * 1024 * 1024 })).toBeNull();
  });

  it("rejects ZIP expansion, XML and image abuse with explicit reasons", () => {
    const base = {
      originalBytes: 10 * 1024 * 1024,
      entryCount: 100,
      uncompressedBytes: 50 * 1024 * 1024,
      xmlBytes: 20 * 1024 * 1024,
      imageCount: 20,
      largestImageBytes: 5 * 1024 * 1024,
    };
    expect(getDocxArchiveViolation(base)).toBeNull();
    expect(getDocxArchiveViolation({ ...base, entryCount: DOCX_IMPORT_LIMITS.maxEntries + 1 })?.code)
      .toBe("TOO_MANY_ENTRIES");
    expect(getDocxArchiveViolation({
      ...base,
      uncompressedBytes: DOCX_IMPORT_LIMITS.maxUncompressedBytes + 1,
    })?.code).toBe("UNCOMPRESSED_TOO_LARGE");
    expect(getDocxArchiveViolation({
      ...base,
      largestImageBytes: DOCX_IMPORT_LIMITS.maxSingleImageBytes + 1,
    })?.code).toBe("IMAGE_TOO_LARGE");
  });
});

describe("DOCX import conversion", () => {
  it("extracts a stable title and complete plain text", () => {
    const html = "<h1>季度 报告</h1><p>第一段</p><p>第二段</p>";
    expect(extractTitleFromDocxHtml(html, "fallback")).toBe("季度 报告");
    expect(docxHtmlToPlainText(html)).toBe("季度 报告第一段第二段");
  });

  it("replaces worker image placeholders with attachment URLs and removes Base64-free markers", () => {
    const html = [
      '<p>正文</p>',
      '<img src="nowen-docx-image://docx-image-1" data-docx-image-id="docx-image-1">',
      '<img src="nowen-docx-image://docx-image-2" data-docx-image-id="docx-image-2">',
    ].join("");
    const replaced = replaceDocxImagePlaceholders(html, new Map([
      ["docx-image-1", "/api/attachments/a1"],
      ["docx-image-2", "/api/attachments/a2"],
    ]));
    expect(replaced).toContain('/api/attachments/a1');
    expect(replaced).toContain('/api/attachments/a2');
    expect(replaced).not.toContain("nowen-docx-image://");
    expect(replaced).not.toContain("data-docx-image-id");
  });

  it("fails instead of silently deleting an image whose upload result is missing", () => {
    expect(() => replaceDocxImagePlaceholders(
      '<img src="nowen-docx-image://docx-image-1" data-docx-image-id="docx-image-1">',
      {},
    )).toThrow(/没有对应的附件地址/);
  });

  it("creates explicit Tiptap JSON for headings, tables and lists", () => {
    const content = convertDocxHtmlToTiptap(`
      <h1>费用清单</h1>
      <table><tr><th>内容</th><th>平台</th></tr><tr><td>运费</td><td>货拉拉</td></tr></table>
      <ul><li>保留列表</li></ul>
    `);
    const doc = JSON.parse(content);
    expect(doc.type).toBe("doc");
    expect(content).toContain("费用清单");
    expect(content).toContain("table");
    expect(content).toContain("bulletList");
  });
});

describe("DOCX import persistence verification", () => {
  const normalizedContent = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId: "server-added" },
      content: [{ type: "text", text: "正文" }],
    }, {
      type: "image",
      attrs: { src: "/api/attachments/a1" },
    }],
  });

  it("accepts backend block-id normalization while requiring text and attachment completeness", () => {
    expect(getImportedNoteSemanticError({
      expectedId: "note-1",
      expectedContentText: "正文",
      expectedContentFormat: "tiptap-json",
      expectedAttachmentUrls: ["/api/attachments/a1"],
      minimumVersion: 2,
      actual: {
        id: "note-1",
        content: normalizedContent,
        contentText: "正文",
        contentFormat: "tiptap-json",
        version: 2,
      },
    })).toBeNull();
  });

  it("detects missing images, truncated text and stale versions", () => {
    expect(getImportedNoteSemanticError({
      expectedId: "note-1",
      expectedContentText: "正文",
      expectedContentFormat: "tiptap-json",
      expectedAttachmentUrls: ["/api/attachments/missing"],
      minimumVersion: 2,
      actual: {
        id: "note-1",
        content: normalizedContent,
        contentText: "正文",
        contentFormat: "tiptap-json",
        version: 2,
      },
    })).toContain("缺少附件引用");

    expect(getImportedNoteSemanticError({
      expectedId: "note-1",
      expectedContentText: "完整正文",
      expectedContentFormat: "tiptap-json",
      expectedAttachmentUrls: [],
      minimumVersion: 2,
      actual: {
        id: "note-1",
        content: normalizedContent,
        contentText: "正文",
        contentFormat: "tiptap-json",
        version: 1,
      },
    })).toContain("版本");
  });

  it("requires the second GET to exactly match the server-confirmed snapshot", () => {
    expect(getImportedNoteIntegrityError({
      expectedId: "note-1",
      expectedContent: normalizedContent,
      expectedContentText: "正文",
      expectedContentFormat: "tiptap-json",
      minimumVersion: 2,
      actual: {
        id: "note-1",
        content: normalizedContent,
        contentText: "正文",
        contentFormat: "tiptap-json",
        version: 2,
      },
    })).toBeNull();

    expect(getImportedNoteIntegrityError({
      expectedId: "note-1",
      expectedContent: normalizedContent,
      expectedContentText: "正文",
      expectedContentFormat: "tiptap-json",
      minimumVersion: 2,
      actual: {
        id: "note-1",
        content: normalizedContent.slice(0, -5),
        contentText: "正文",
        contentFormat: "tiptap-json",
        version: 2,
      },
    })).toContain("刷新后正文");
  });
});

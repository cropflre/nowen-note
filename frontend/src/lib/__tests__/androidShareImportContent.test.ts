import { describe, expect, it } from "vitest";
import {
  appendAndroidShareToNote,
  buildAndroidShareNoteTitle,
} from "@/lib/androidShareImportContent";
import type { AndroidSharePayload } from "@/lib/androidShareImport";

function payload(overrides: Partial<AndroidSharePayload> = {}): AndroidSharePayload {
  return {
    id: "share-1",
    action: "android.intent.action.SEND",
    createdAt: Date.now(),
    sourcePackage: "com.android.chrome",
    sourceLabel: "Chrome",
    subject: "Nowen 分享标题",
    text: "正文内容\nhttps://example.com/article",
    url: "https://example.com/article",
    items: [],
    ...overrides,
  };
}

const attachments = [
  {
    id: "image-1",
    url: "/api/attachments/image-1",
    filename: "截图.png",
    mimeType: "image/png",
    size: 1024,
    category: "image" as const,
  },
  {
    id: "file-1",
    url: "/api/attachments/file-1",
    filename: "需求.pdf",
    mimeType: "application/pdf",
    size: 2048,
    category: "file" as const,
  },
];

describe("Android share note content", () => {
  it("derives a useful title from subject, file or URL", () => {
    expect(buildAndroidShareNoteTitle(payload())).toBe("Nowen 分享标题");
    expect(buildAndroidShareNoteTitle(payload({ subject: "", text: "", url: "", items: [{
      id: "1", name: "年度报告.pdf", mimeType: "application/pdf", declaredMimeType: "application/pdf",
      size: 1, status: "ready",
    }] }))).toBe("年度报告");
    expect(buildAndroidShareNoteTitle(payload({ subject: "", text: "https://www.example.com/a", url: "https://www.example.com/a" }))).toBe("example.com");
  });

  it("appends markdown without persisting an absolute server address", () => {
    const result = appendAndroidShareToNote(
      { content: "原正文", contentText: "原正文", contentFormat: "markdown" },
      payload(),
      attachments,
    );
    expect(result.contentFormat).toBe("markdown");
    expect(result.content).toContain("原正文");
    expect(result.content).toContain("![截图.png](/api/attachments/image-1)");
    expect(result.content).toContain("[📎 需求.pdf](/api/attachments/file-1)");
    expect(result.content).not.toContain("localhost");
    expect(result.content.match(/https:\/\/example\.com\/article/g)).toHaveLength(1);
  });

  it("preserves existing Tiptap JSON nodes and appends image/link nodes", () => {
    const existing = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "保留我" }] }] };
    const result = appendAndroidShareToNote(
      { content: JSON.stringify(existing), contentText: "保留我", contentFormat: "tiptap-json" },
      payload(),
      attachments,
    );
    const document = JSON.parse(result.content);
    expect(document.content[0].content[0].text).toBe("保留我");
    expect(document.content.some((node: any) => node.type === "image" && node.attrs.src === "/api/attachments/image-1")).toBe(true);
    expect(JSON.stringify(document)).toContain("/api/attachments/file-1");
  });

  it("refuses malformed rich-text data rather than replacing it", () => {
    expect(() => appendAndroidShareToNote(
      { content: "{broken", contentText: "important", contentFormat: "tiptap-json" },
      payload(),
      attachments,
    )).toThrow(/无法解析/);
  });
});

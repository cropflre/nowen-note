import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMarkdownVideoLine,
  preprocessMarkdownVideos,
} from "@/lib/markdownVideoSyntax";

describe("markdownVideoSyntax", () => {
  it("parses video syntax with title", () => {
    expect(parseMarkdownVideoLine('@[video](/api/attachments/abc?inline=1 "clip.mp4")')).toEqual({
      src: "/api/attachments/abc?inline=1",
      title: "clip.mp4",
    });
  });

  it("parses video syntax without title", () => {
    expect(parseMarkdownVideoLine("@[video](/api/attachments/abc?inline=1)")).toEqual({
      src: "/api/attachments/abc?inline=1",
      title: undefined,
    });
  });

  it("returns null for non-video syntax", () => {
    expect(parseMarkdownVideoLine("[video](/api/attachments/abc)")).toBeNull();
    expect(parseMarkdownVideoLine("before @[video](/api/attachments/abc)")).toBeNull();
  });

  it("rejects unsafe URLs", () => {
    expect(parseMarkdownVideoLine('@[video](javascript:alert(1) "x.mp4")')).toBeNull();
    expect(parseMarkdownVideoLine('@[video](data:text/html;base64,abc "x.mp4")')).toBeNull();
    expect(parseMarkdownVideoLine('@[video](file:///tmp/x.mp4 "x.mp4")')).toBeNull();
  });

  it("adds inline=1 for attachment URLs", () => {
    expect(parseMarkdownVideoLine('@[video](/api/attachments/abc "clip.mp4")')).toEqual({
      src: "/api/attachments/abc?inline=1",
      title: "clip.mp4",
    });
  });

  it("converts valid syntax into a nowen video image placeholder", () => {
    expect(preprocessMarkdownVideos('@[video](/api/attachments/abc "clip.mp4")')).toBe(
      "![nowen-video:clip.mp4](/api/attachments/abc?inline=1)",
    );
  });

  it("keeps normal images and links unchanged", () => {
    const markdown = [
      "![alt](/api/attachments/img)",
      "[link](https://example.com)",
    ].join("\n");
    expect(preprocessMarkdownVideos(markdown)).toBe(markdown);
  });

  it("does not convert video syntax inside fenced code blocks", () => {
    const markdown = [
      "```md",
      '@[video](/api/attachments/abc "clip.mp4")',
      "```",
    ].join("\n");
    expect(preprocessMarkdownVideos(markdown)).toBe(markdown);
  });
});

describe("markdown video source guards", () => {
  const componentsDir = path.resolve(__dirname, "../../components");
  const previewSource = readFileSync(path.join(componentsDir, "MarkdownPreview.tsx"), "utf8");
  const editorSource = readFileSync(path.join(componentsDir, "MarkdownEditorImpl.tsx"), "utf8");

  it("sanitizes the limited raw HTML surface in MarkdownPreview", () => {
    expect(previewSource).toContain("rehypeRaw");
    expect(previewSource).toContain("safeHtmlSchema");
    expect(previewSource).not.toContain("dangerouslySetInnerHTML");
  });

  it("adds a video picker without inserting raw video HTML", () => {
    expect(editorSource).toContain('input.accept = "video/*"');
    expect(editorSource).toContain("@[video](");
    expect(editorSource).not.toContain("<video");
    expect(editorSource).not.toContain("dangerouslySetInnerHTML");
  });
});

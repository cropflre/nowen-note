import { describe, expect, it } from "vitest";
import { normalizeImportedHtmlContent } from "@/lib/singleFileHtmlImport";

describe("normalizeImportedHtmlContent", () => {
  it("extracts the article root even when the source omits an explicit body tag", () => {
    const html = `<!doctype html>
      <head><title>Saved page</title><style>.hidden{display:none}</style></head>
      <div class="toolbar">not article</div>
      <div id="js_content" class="rich_media_content" style="color:red">
        <h2 id="heading">Article heading</h2>
        <p onclick="alert(1)">Article body</p>
      </div>
      <div class="footer">not article either</div>`;

    const normalized = normalizeImportedHtmlContent(html);

    expect(normalized).toContain("Article heading");
    expect(normalized).toContain("Article body");
    expect(normalized).not.toContain("not article");
    expect(normalized).not.toContain("style=");
    expect(normalized).not.toContain("onclick=");
  });

  it("replaces SingleFile data images with their retained remote source", () => {
    const embedded = `data:image/png;base64,${"A".repeat(20_000)}`;
    const html = `<main><p>正文</p><img src="${embedded}" data-src="https://mmbiz.qpic.cn/example.png" class="rich_pages wxw-img"></main>`;

    const normalized = normalizeImportedHtmlContent(html);

    expect(normalized).toContain('src="https://mmbiz.qpic.cn/example.png"');
    expect(normalized).toContain('loading="lazy"');
    expect(normalized).not.toContain("data:image/png;base64");
    expect(normalized.length).toBeLessThan(500);
  });

  it("keeps an embedded image when no recoverable remote source exists", () => {
    const embedded = "data:image/png;base64,QUJD";
    const normalized = normalizeImportedHtmlContent(`<article><img src="${embedded}" alt="cover"></article>`);

    expect(normalized).toContain(embedded);
    expect(normalized).toContain('alt="cover"');
  });

  it("removes scripts and javascript links from the selected content", () => {
    const normalized = normalizeImportedHtmlContent(`
      <article>
        <script>window.bad = true</script>
        <a href="javascript:alert(1)" title="unsafe">Click</a>
        <a href="https://example.com">Safe</a>
      </article>
    `);

    expect(normalized).not.toContain("window.bad");
    expect(normalized).not.toContain("javascript:");
    expect(normalized).toContain('href="https://example.com"');
  });
});

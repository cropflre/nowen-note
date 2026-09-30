import { describe, expect, it } from "vitest";
import { buildHtmlPlaygroundDocument, isHtmlPlaygroundLanguage } from "../htmlPlayground";

describe("HTML playground documents", () => {
  it.each(["html", "HTML", " htm "])("accepts the explicit HTML language %s", (language) => {
    expect(isHtmlPlaygroundLanguage(language)).toBe(true);
  });
  it.each(["", "auto", "xml", "javascript", "vue", "text"])("does not guess HTML from %s", (language) => {
    expect(isHtmlPlaygroundLanguage(language)).toBe(false);
  });
  it.each([
    '<h1>Fragment</h1><style>h1 { color: red }</style><script>window.demo = 1</script>',
    '<!DOCTYPE html><html lang="en"><head><title>Demo</title></head><body><button onclick="this.remove()">Click</button></body></html>',
    '</body></html><meta http-equiv="Content-Security-Policy" content="default-src *"><script>window.demo = 1</script>',
  ])("places restrictive CSP before user content while preserving scripts and markup", (source) => {
    const result = buildHtmlPlaygroundDocument(source);
    expect(result).toContain(source);
    const doc = new DOMParser().parseFromString(result, "text/html");
    const firstPolicy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(firstPolicy).toContain("default-src 'none'");
    expect(firstPolicy).toContain("script-src 'unsafe-inline'");
    for (const directive of ["connect-src", "frame-src", "object-src", "base-uri", "form-action"]) {
      expect(firstPolicy).toContain(`${directive} 'none'`);
    }
    expect(firstPolicy).not.toContain("unsafe-eval");
    expect(result.indexOf("Content-Security-Policy")).toBeLessThan(result.indexOf(source));
  });
});

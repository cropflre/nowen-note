import { describe, expect, it } from "vitest";
import { isExternalHttpLink, normalizeExternalHref } from "../SharedNoteView";

describe("SharedNoteView shared content links", () => {
  it("classifies only external http links for new-tab behavior", () => {
    expect(isExternalHttpLink("https://example.com")).toBe(true);
    expect(isExternalHttpLink("http://example.com")).toBe(true);
    expect(isExternalHttpLink("//example.com")).toBe(true);

    expect(isExternalHttpLink("#heading")).toBe(false);
    expect(isExternalHttpLink("note:abc")).toBe(false);
    expect(isExternalHttpLink("mailto:a@b.com")).toBe(false);
    expect(isExternalHttpLink("tel:123")).toBe(false);
    expect(isExternalHttpLink("sms:123")).toBe(false);
    expect(isExternalHttpLink("/api/attachments/file-id")).toBe(false);
  });

  it("normalizes protocol-relative external links before window.open", () => {
    expect(normalizeExternalHref("//example.com/path")).toBe("http://example.com/path");
    expect(normalizeExternalHref(" https://example.com/path ")).toBe("https://example.com/path");
  });
});

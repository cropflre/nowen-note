// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { extractEmbedPassword, fillEmbedPasswordDocument } from "@/lib/embedPassword";

describe("embedPassword", () => {
  it.each([
    ["https://example.com/embed?password=abc123", "abc123"],
    ["https://example.com/embed?pwd=7788", "7788"],
    ["https://example.com/embed#passcode=hello", "hello"],
    ["https://example.com/embed#提取码=中文密码", "中文密码"],
  ])("extracts passwords from %s", (url, expected) => {
    expect(extractEmbedPassword(url)).toBe(expected);
  });

  it("does not treat unrelated query values as passwords", () => {
    expect(extractEmbedPassword("https://example.com/embed?theme=dark&id=123")).toBeNull();
  });

  it("fills a common password field and emits framework-compatible events", () => {
    document.body.innerHTML = '<input id="password" type="password" />';
    const input = document.querySelector<HTMLInputElement>("#password")!;
    const inputListener = vi.fn();
    const changeListener = vi.fn();
    input.addEventListener("input", inputListener);
    input.addEventListener("change", changeListener);

    expect(fillEmbedPasswordDocument(document, "secret")).toBe(true);
    expect(input.value).toBe("secret");
    expect(inputListener).toHaveBeenCalledTimes(1);
    expect(changeListener).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { normalizePublicWebOrigin } from "@/lib/publicWebOrigin";
import { getShareSessionId } from "@/lib/shareSession";

describe("share access helpers", () => {
  beforeEach(() => sessionStorage.clear());
  it("keeps one anonymous session id inside a browser tab", () => {
    const first = getShareSessionId();
    expect(first).toBeTruthy();
    expect(getShareSessionId()).toBe(first);
  });
  it("normalizes only http public origins", () => {
    expect(normalizePublicWebOrigin("https://note.example.com///")).toBe("https://note.example.com");
    expect(normalizePublicWebOrigin("javascript:alert(1)")).toBe("");
  });
});

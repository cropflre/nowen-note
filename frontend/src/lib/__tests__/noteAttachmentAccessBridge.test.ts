// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));

import {
  extractAttachmentId,
  mergeSignedAttachmentUrl,
  registerAttachmentAccessUrls,
  resolveAttachmentAccessUrl,
} from "@/lib/noteAttachmentAccessBridge";

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";

describe("noteAttachmentAccessBridge", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/note/test");
  });

  it("recognizes only canonical note attachment ids", () => {
    expect(extractAttachmentId(`/api/attachments/${ATTACHMENT_ID}`)).toBe(ATTACHMENT_ID);
    expect(extractAttachmentId(`https://api.example.com/api/attachments/${ATTACHMENT_ID}?w=720`)).toBe(ATTACHMENT_ID);
    expect(extractAttachmentId("/api/task-attachments/123")).toBeNull();
    expect(extractAttachmentId("/api/attachments/not-a-uuid")).toBeNull();
  });

  it("keeps preview/download parameters and replaces stale access signatures", () => {
    const signed = `https://api.example.com/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    const merged = new URL(mergeSignedAttachmentUrl(
      `/api/attachments/${ATTACHMENT_ID}?download=1&w=720&exp=1&sig=old&scope=old`,
      signed,
    ));
    expect(merged.searchParams.get("download")).toBe("1");
    expect(merged.searchParams.get("w")).toBe("720");
    expect(merged.searchParams.get("exp")).toBe("2000000000");
    expect(merged.searchParams.get("sig")).toBe("server-value");
    expect(merged.searchParams.get("scope")).toBe("v2.scope");
  });

  it("resolves a relative signature against the attachment server origin", () => {
    const raw = `https://notes-api.example.com/api/attachments/${ATTACHMENT_ID}?w=240`;
    const signed = `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    const merged = new URL(mergeSignedAttachmentUrl(raw, signed));

    expect(merged.origin).toBe("https://notes-api.example.com");
    expect(merged.searchParams.get("w")).toBe("240");
  });

  it("resolves image, media and download requests from the same access map", () => {
    const signed = `https://api.example.com/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    expect(registerAttachmentAccessUrls({ [ATTACHMENT_ID]: signed })).toBe(1);

    const imageUrl = new URL(resolveAttachmentAccessUrl(`/api/attachments/${ATTACHMENT_ID}?w=320`));
    expect(imageUrl.origin).toBe("https://api.example.com");
    expect(imageUrl.searchParams.get("w")).toBe("320");
    expect(imageUrl.searchParams.get("sig")).toBe("server-value");

    const downloadUrl = new URL(resolveAttachmentAccessUrl(`/api/attachments/${ATTACHMENT_ID}?download=1`));
    expect(downloadUrl.searchParams.get("download")).toBe("1");
    expect(downloadUrl.searchParams.get("sig")).toBe("server-value");
  });

  it("ignores malformed access maps", () => {
    expect(registerAttachmentAccessUrls({
      "not-a-uuid": "https://api.example.com/api/attachments/not-a-uuid?sig=x",
      [ATTACHMENT_ID]: `/api/attachments/${ATTACHMENT_ID}`,
    })).toBe(0);
  });
});

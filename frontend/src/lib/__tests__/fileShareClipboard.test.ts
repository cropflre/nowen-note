import { describe, expect, it, vi } from "vitest";
import { stabilizeClipboardAttachmentLinks } from "@/lib/fileShareClipboard";

const ATTACHMENT_ID = "11111111-2222-4333-8444-555555555555";
const STABLE_URL = `https://notes.example/api/attachments/${ATTACHMENT_ID}?share=stable-token`;

function encodeScope(kind: "user" | "share" | "publication"): string {
  const payload = JSON.stringify({
    version: 2,
    kind,
    subjectId: kind === "user" ? "user-1" : "share-1",
    noteId: "note-1",
    allowDownload: true,
  });
  const bytes = new TextEncoder().encode(payload);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `v2.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

function signedUrl(kind: "user" | "share" | "publication" = "user"): string {
  return `https://notes.example/api/attachments/${ATTACHMENT_ID}?exp=4102444800&sig=deadbeef&scope=${encodeURIComponent(encodeScope(kind))}`;
}

describe("stabilizeClipboardAttachmentLinks", () => {
  it("keeps ordinary clipboard content unchanged without creating a share", async () => {
    const createShare = vi.fn(async () => STABLE_URL);
    const input = "hello https://example.com/image.png";

    await expect(stabilizeClipboardAttachmentLinks(input, createShare)).resolves.toBe(input);
    expect(createShare).not.toHaveBeenCalled();
  });

  it("replaces a user-scoped temporary attachment URL with a stable file-share URL", async () => {
    const createShare = vi.fn(async () => STABLE_URL);

    const result = await stabilizeClipboardAttachmentLinks(signedUrl("user"), createShare);

    expect(result).toBe(STABLE_URL);
    expect(result).not.toContain("exp=");
    expect(result).not.toContain("sig=");
    expect(result).not.toContain("scope=");
    expect(createShare).toHaveBeenCalledTimes(1);
    expect(createShare).toHaveBeenCalledWith(ATTACHMENT_ID);
  });

  it("replaces temporary URLs inside Markdown snippets", async () => {
    const createShare = vi.fn(async () => STABLE_URL);
    const input = `![demo.png](${signedUrl("user")})`;

    await expect(stabilizeClipboardAttachmentLinks(input, createShare)).resolves.toBe(
      `![demo.png](${STABLE_URL})`,
    );
  });

  it("preserves HTML escaping while replacing a temporary image src", async () => {
    const createShare = vi.fn(async () => `${STABLE_URL}&inline=1`);
    const htmlUrl = signedUrl("user").replace(/&/g, "&amp;");
    const input = `<img src="${htmlUrl}" alt="demo" />`;

    await expect(stabilizeClipboardAttachmentLinks(input, createShare)).resolves.toBe(
      `<img src="${STABLE_URL}&amp;inline=1" alt="demo" />`,
    );
  });

  it("does not convert public share or publication runtime scopes", async () => {
    const createShare = vi.fn(async () => STABLE_URL);
    const shareInput = signedUrl("share");
    const publicationInput = signedUrl("publication");

    await expect(stabilizeClipboardAttachmentLinks(shareInput, createShare)).resolves.toBe(shareInput);
    await expect(stabilizeClipboardAttachmentLinks(publicationInput, createShare)).resolves.toBe(publicationInput);
    expect(createShare).not.toHaveBeenCalled();
  });

  it("propagates stable-share creation failures instead of leaking the expiring URL", async () => {
    const createShare = vi.fn(async () => {
      throw new Error("share unavailable");
    });

    await expect(stabilizeClipboardAttachmentLinks(signedUrl("user"), createShare)).rejects.toThrow(
      "share unavailable",
    );
  });

  it("deduplicates multiple copies of the same attachment into one share request", async () => {
    const createShare = vi.fn(async () => STABLE_URL);
    const temp = signedUrl("user");
    const input = `${temp}\n![same](${temp})`;

    const result = await stabilizeClipboardAttachmentLinks(input, createShare);

    expect(result).toBe(`${STABLE_URL}\n![same](${STABLE_URL})`);
    expect(createShare).toHaveBeenCalledTimes(1);
  });
});

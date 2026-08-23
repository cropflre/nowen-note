// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadAttachment,
  resolveAttachmentDownloadUrl,
} from "@/lib/downloadFile";
import {
  registerAttachmentAccessUrls,
  resetAttachmentAccessStateForTests,
} from "@/lib/noteAttachmentAccessBridge";
import { setRuntimePublicWebOrigin } from "@/lib/publicWebOrigin";

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174242";

function signedUrl(sig = "server-value"): string {
  return `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=${sig}&scope=v2.scope`;
}

describe("downloadAttachment", () => {
  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    setRuntimePublicWebOrigin("", "current");
    window.history.replaceState({}, "", "/note/test");
  });

  afterEach(() => {
    resetAttachmentAccessStateForTests();
    setRuntimePublicWebOrigin("", "current");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the current signed URL when triggering a same-origin desktop download", async () => {
    const signed = new URL(`/api/attachments/${ATTACHMENT_ID}`, window.location.origin);
    signed.searchParams.set("exp", "2000000000");
    signed.searchParams.set("sig", "server-value");
    signed.searchParams.set("scope", "v2.scope");
    registerAttachmentAccessUrls({ [ATTACHMENT_ID]: signed.toString() });

    let clickedHref = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickedHref = this.href;
    });

    await downloadAttachment(`/api/attachments/${ATTACHMENT_ID}`, "report.pdf");

    const url = new URL(clickedHref);
    expect(url.searchParams.get("download")).toBe("1");
    expect(url.searchParams.get("sig")).toBe("server-value");
  });

  it("rebases only the active download to the configured public origin and preserves signatures", () => {
    registerAttachmentAccessUrls(
      { [ATTACHMENT_ID]: signedUrl("lan-signed") },
      "http://192.168.1.20:3001/api/attachments/access/urls?noteId=note-1",
    );

    const downloadUrl = new URL(resolveAttachmentDownloadUrl(
      `/api/attachments/${ATTACHMENT_ID}?w=720`,
      "https://notes.example.com/nowen-note",
    ));

    expect(downloadUrl.origin).toBe("https://notes.example.com");
    expect(downloadUrl.pathname).toBe(`/nowen-note/api/attachments/${ATTACHMENT_ID}`);
    expect(downloadUrl.searchParams.get("download")).toBe("1");
    expect(downloadUrl.searchParams.get("w")).toBe("720");
    expect(downloadUrl.searchParams.get("sig")).toBe("lan-signed");
    expect(downloadUrl.searchParams.get("scope")).toBe("v2.scope");
  });

  it("keeps the LAN attachment origin when no public origin is supplied", () => {
    registerAttachmentAccessUrls(
      { [ATTACHMENT_ID]: signedUrl("lan-signed") },
      "http://192.168.1.20:3001/api/attachments/access/urls?noteId=note-1",
    );

    const downloadUrl = new URL(resolveAttachmentDownloadUrl(
      `/api/attachments/${ATTACHMENT_ID}`,
      "",
    ));

    expect(downloadUrl.origin).toBe("http://192.168.1.20:3001");
    expect(downloadUrl.searchParams.get("download")).toBe("1");
    expect(downloadUrl.searchParams.get("sig")).toBe("lan-signed");
  });

  it("uses PUBLIC_WEB_ORIGIN for mobile downloads without changing the attachment access bridge", async () => {
    setRuntimePublicWebOrigin("https://notes.example.com", "environment");
    registerAttachmentAccessUrls(
      { [ATTACHMENT_ID]: signedUrl("mobile-signed") },
      "http://192.168.1.20:3001/api/attachments/access/urls?noteId=note-mobile",
    );

    // The render bridge must remain LAN-first; only the user-triggered download is public.
    const renderUrl = resolveAttachmentDownloadUrl(`/api/attachments/${ATTACHMENT_ID}`, "");
    expect(new URL(renderUrl).origin).toBe("http://192.168.1.20:3001");

    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36",
    );
    const fetchMock = vi.fn(async () => new Response(new Blob(["attachment"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:https://notes.example.com/download"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await downloadAttachment(`/api/attachments/${ATTACHMENT_ID}`, "mobile.pdf");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(url.origin).toBe("https://notes.example.com");
    expect(url.pathname).toBe(`/api/attachments/${ATTACHMENT_ID}`);
    expect(url.searchParams.get("download")).toBe("1");
    expect(url.searchParams.get("sig")).toBe("mobile-signed");
    expect(requestInit).toEqual({ credentials: "include" });
  });

  it("does not rewrite offline blob attachments through PUBLIC_WEB_ORIGIN", () => {
    const blobUrl = "blob:https://notes.example.com/offline-attachment";
    expect(resolveAttachmentDownloadUrl(blobUrl, "https://public.example.com"))
      .toBe(blobUrl);
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));

import {
  acquireAttachmentRenderUrl,
  extractAttachmentId,
  getAttachmentRenderSource,
  getPersistentAttachmentUrl,
  mergeSignedAttachmentUrl,
  registerAttachmentAccessUrls,
  registerOfflineAttachmentBlob,
  rememberAttachmentApiOrigin,
  resetAttachmentAccessStateForTests,
  resolveAttachmentAccessUrl,
  unregisterOfflineAttachmentObjectUrl,
} from "@/lib/noteAttachmentAccessBridge";

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";

describe("noteAttachmentAccessBridge", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:https://notes.example.com/default"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    resetAttachmentAccessStateForTests();
    window.history.replaceState({}, "", "/note/test");
  });

  it("recognizes only canonical note attachment ids", () => {
    expect(extractAttachmentId(`/api/attachments/${ATTACHMENT_ID}`)).toBe(ATTACHMENT_ID);
    expect(extractAttachmentId(`https://api.example.com/api/attachments/${ATTACHMENT_ID}?w=720`)).toBe(ATTACHMENT_ID);
    expect(extractAttachmentId("/api/task-attachments/123")).toBeNull();
    expect(extractAttachmentId("/api/attachments/not-a-uuid")).toBeNull();
  });

  it("keeps preview/download parameters and replaces stale access signatures", () => {
    rememberAttachmentApiOrigin("https://api.example.com/api/notes/note-1");
    const signed = `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    const merged = new URL(mergeSignedAttachmentUrl(
      `/api/attachments/${ATTACHMENT_ID}?download=1&w=720&exp=1&sig=old&scope=old`,
      signed,
    ));
    expect(merged.origin).toBe("https://api.example.com");
    expect(merged.searchParams.get("download")).toBe("1");
    expect(merged.searchParams.get("w")).toBe("720");
    expect(merged.searchParams.get("exp")).toBe("2000000000");
    expect(merged.searchParams.get("sig")).toBe("server-value");
    expect(merged.searchParams.get("scope")).toBe("v2.scope");
  });

  it("resolves a relative signature against the observed attachment API origin", () => {
    rememberAttachmentApiOrigin("https://notes-api.example.com/api/notes/note-1");
    const raw = `http://127.0.0.1:3001/api/attachments/${ATTACHMENT_ID}?w=240`;
    const signed = `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    const merged = new URL(mergeSignedAttachmentUrl(raw, signed));

    expect(merged.origin).toBe("https://notes-api.example.com");
    expect(merged.searchParams.get("w")).toBe("240");
  });

  it("does not let a later stale loopback request replace a trusted API origin", () => {
    expect(rememberAttachmentApiOrigin("https://notes.example.com/api/notes/note-1"))
      .toBe("https://notes.example.com");
    expect(rememberAttachmentApiOrigin(`http://127.0.0.1:3001/api/attachments/${ATTACHMENT_ID}`))
      .toBe("https://notes.example.com");
  });

  it("rebases an absolute loopback signed URL to the request origin", () => {
    const badSigned = `http://127.0.0.1:3001/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    const accessEndpoint = "https://notes.example.com/api/attachments/access/urls?noteId=note-1";

    expect(registerAttachmentAccessUrls({ [ATTACHMENT_ID]: badSigned }, accessEndpoint)).toBe(1);

    const resolved = new URL(resolveAttachmentAccessUrl(
      `http://127.0.0.1:3001/api/attachments/${ATTACHMENT_ID}?w=640`,
    ));
    expect(resolved.origin).toBe("https://notes.example.com");
    expect(resolved.pathname).toBe(`/api/attachments/${ATTACHMENT_ID}`);
    expect(resolved.searchParams.get("w")).toBe("640");
    expect(resolved.searchParams.get("sig")).toBe("server-value");
  });

  it("repairs a legacy loopback attachment URL before the signature map is ready", () => {
    rememberAttachmentApiOrigin("https://notes.example.com/api/notes/note-1");
    const resolved = new URL(resolveAttachmentAccessUrl(
      `http://127.0.0.1:3001/api/attachments/${ATTACHMENT_ID}?w=320`,
    ));

    expect(resolved.origin).toBe("https://notes.example.com");
    expect(resolved.searchParams.get("w")).toBe("320");
  });

  it("resolves image, media and download requests from the same access map", () => {
    const signed = `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    expect(registerAttachmentAccessUrls(
      { [ATTACHMENT_ID]: signed },
      "https://api.example.com/api/attachments/access/urls?noteId=note-1",
    )).toBe(1);

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

  it("keeps an offline render URL alive until the mounted consumer releases it", () => {
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://notes.example.com/offline-a");
    const signed = `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=server-value&scope=v2.scope`;
    registerAttachmentAccessUrls({ [ATTACHMENT_ID]: signed }, "https://notes.example.com/api/notes/note-1");
    const objectUrl = registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["image"]));
    const release = acquireAttachmentRenderUrl(objectUrl!);

    unregisterOfflineAttachmentObjectUrl(ATTACHMENT_ID);

    expect(resolveAttachmentAccessUrl(`/api/attachments/${ATTACHMENT_ID}`)).toContain("sig=server-value");
    expect(revokeObjectUrl).not.toHaveBeenCalledWith(objectUrl);

    release();
    expect(revokeObjectUrl).toHaveBeenCalledWith(objectUrl);
  });

  it("publishes a replacement object URL before revoking the leased previous URL", () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:https://notes.example.com/offline-old")
      .mockReturnValueOnce("blob:https://notes.example.com/offline-new");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const oldUrl = registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["old"]))!;
    const releaseOldUrl = acquireAttachmentRenderUrl(oldUrl);

    const newUrl = registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["replacement-image"]))!;

    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(resolveAttachmentAccessUrl(`/api/attachments/${ATTACHMENT_ID}`)).toBe(newUrl);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith(oldUrl);

    releaseOldUrl();
    expect(revokeObjectUrl).toHaveBeenCalledWith(oldUrl);
  });

  it("recovers persistent identity from both active and retired object URLs", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://notes.example.com/offline-a");
    const objectUrl = registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["image"]))!;

    expect(getPersistentAttachmentUrl(objectUrl)).toBe(`/api/attachments/${ATTACHMENT_ID}`);
    unregisterOfflineAttachmentObjectUrl(ATTACHMENT_ID);
    expect(getPersistentAttachmentUrl(objectUrl)).toBe(`/api/attachments/${ATTACHMENT_ID}`);
  });

  it("reports render-source diagnostics without exposing note content", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://notes.example.com/offline-a");
    registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["image"]));

    expect(getAttachmentRenderSource(`/api/attachments/${ATTACHMENT_ID}`)).toMatchObject({
      attachmentId: ATTACHMENT_ID,
      persistentSrc: `/api/attachments/${ATTACHMENT_ID}`,
      resolvedSrc: "blob:https://notes.example.com/offline-a",
      offlineObjectUrlHit: true,
      signedUrlPresent: false,
    });
  });
});

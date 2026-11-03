// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => {
  const state = {
    resolve: (src: string | null | undefined) => src || "",
    platform: "web",
  };
  return {
    state,
    getBaseUrl: vi.fn(() => "https://notes.example.com/api"),
    resolveAttachmentUrl: vi.fn((src: string | null | undefined) => state.resolve(src)),
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => apiMock.state.platform,
  },
}));

vi.mock("@/lib/api", () => ({
  getBaseUrl: apiMock.getBaseUrl,
  resolveAttachmentUrl: apiMock.resolveAttachmentUrl,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/lib/localStore", () => ({
  getOfflineAttachmentsByNote: vi.fn(async () => []),
  markOfflineAttachmentsAccessed: vi.fn(async () => undefined),
}));

import { AttachmentNoteContext, useAttachmentImageRenderSource } from "@/hooks/useAttachmentImageRenderSource";
import {
  registerAttachmentAccessUrls,
  resetAttachmentAccessStateForTests,
  resolveAttachmentAccessUrl,
  registerOfflineAttachmentBlob,
  registerNativeAttachmentUrl,
} from "@/lib/noteAttachmentAccessBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";

function Probe({ src, preferOriginal = false }: { src: string; preferOriginal?: boolean }) {
  const image = useAttachmentImageRenderSource(src, { preferOriginal });
  return (
    <div
      data-testid="probe"
      data-persistent-src={image.persistentSrc}
      data-resolved-src={image.resolvedSrc}
      data-render-src={image.renderSrc}
      data-error={image.error ? "1" : "0"}
      data-loading={image.loading ? "1" : "0"}
    >
      <button type="button" onClick={image.onError}>fail</button>
    </div>
  );
}

describe("full-resolution preview attachment access", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    localStorage.clear();
    apiMock.resolveAttachmentUrl.mockClear();
    apiMock.state.platform = "web";
    apiMock.state.resolve = (src) => resolveAttachmentAccessUrl(src || "");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    resetAttachmentAccessStateForTests();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads full-resolution attachments without dropping authorization (DCC-006)", async () => {
    const src = `https://notes.example.com/proxy/api/attachments/${ATTACHMENT_ID}/image.heic?w=240&exp=2000000000&sig=signature&scope=v2.scope&share=opaque&inline=1`;
    await act(async () => root.render(<Probe src={src} preferOriginal />));
    const rendered = new URL(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.renderSrc!);
    expect(rendered.searchParams.has("w")).toBe(false);
    for (const key of ["sig", "exp", "scope", "share", "inline"]) {
      expect(rendered.searchParams.get(key)).toBe(new URL(src).searchParams.get(key));
    }
    expect(rendered.pathname).toBe(new URL(src).pathname);
  });

  it("preserves external signed image queries in original mode", async () => {
    const src = "https://images.example/photo.jpg?w=240&sig=external";
    await act(async () => root.render(<Probe src={src} preferOriginal />));
    expect(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.renderSrc).toBe(src);
  });

  it("removes thumbnail width after replacing a stale signature", async () => {
    registerAttachmentAccessUrls({ [ATTACHMENT_ID]: `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=fresh&scope=v2.new` }, "https://notes.example.com/api/attachments/access/urls?noteId=note-1");
    await act(async () => root.render(<Probe src={`/api/attachments/${ATTACHMENT_ID}?w=240&sig=old&exp=1&scope=old`} preferOriginal />));
    const rendered = new URL(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.renderSrc!);
    expect(rendered.searchParams.has("w")).toBe(false);
    expect(rendered.searchParams.get("sig")).toBe("fresh");
    expect(rendered.searchParams.get("scope")).toBe("v2.new");
  });

  it("keeps the native HEIC-compatible preview instead of forcing undecodable bytes", async () => {
    const preview = "https://localhost/_capacitor_file_/photo-preview.jpg";
    registerNativeAttachmentUrl(ATTACHMENT_ID, preview, "https://localhost/_capacitor_file_/photo.heic");
    await act(async () => root.render(<Probe src={`/api/attachments/${ATTACHMENT_ID}?w=240`} preferOriginal />));
    expect(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.renderSrc).toBe(preview);
  });

  it("fetches original resolution through the Android blob compatibility path", async () => {
    apiMock.state.platform = "android";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["image"], { type: "image/png" }))));
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:https://notes.example.com/android");
      static revokeObjectURL = vi.fn();
    });
    const src = `https://notes.example.com/api/attachments/${ATTACHMENT_ID}?w=480&exp=2000000000&sig=android&scope=v2.scope`;
    await act(async () => root.render(<Probe src={src} preferOriginal />));
    expect(fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(requested.searchParams.has("w")).toBe(false);
    expect(requested.searchParams.get("sig")).toBe("android");
    expect(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.renderSrc).toBe("blob:https://notes.example.com/android");
  });

  it("uses the offline blob in original mode without network access (DCC-009)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:https://notes.example.com/offline");
      static revokeObjectURL = vi.fn();
    });
    registerOfflineAttachmentBlob(ATTACHMENT_ID, new Blob(["image"], { type: "image/png" }));
    await act(async () => root.render(<Probe src={`/api/attachments/${ATTACHMENT_ID}?w=240`} preferOriginal />));
    expect(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.renderSrc).toBe("blob:https://notes.example.com/offline");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not leak signed URLs when Android original fetching fails", async () => {
    apiMock.state.platform = "android";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("failed URL with sig=secret")));
    await act(async () => root.render(<Probe src={`https://notes.example.com/api/attachments/${ATTACHMENT_ID}?w=240&sig=secret&exp=2000000000&scope=v2.scope`} preferOriginal />));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.error).toBe("1");
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    log.mockRestore();
  });

  it.each([403, 404])("does not bypass denied original access (%s)", async (status) => {
    localStorage.setItem("nowen-token", "jwt-token");
    const fetch = vi.fn().mockResolvedValue(new Response("denied", { status }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<AttachmentNoteContext.Provider value="note-1"><Probe src={`/api/attachments/${ATTACHMENT_ID}?w=240`} preferOriginal /></AttachmentNoteContext.Provider>));
    expect(fetch).toHaveBeenCalledTimes(1);
    const probe = host.querySelector<HTMLElement>('[data-testid="probe"]')!;
    expect(probe.dataset.renderSrc).toBe("");
    expect(probe.dataset.error).toBe("1");
  });
});

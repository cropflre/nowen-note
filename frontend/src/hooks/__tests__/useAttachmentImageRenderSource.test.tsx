// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => {
  const state = {
    resolve: (src: string | null | undefined) => src || "",
  };
  return {
    state,
    getBaseUrl: vi.fn(() => "https://notes.example.com/api"),
    resolveAttachmentUrl: vi.fn((src: string | null | undefined) => state.resolve(src)),
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "web",
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
} from "@/lib/noteAttachmentAccessBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";

function Probe({ src }: { src: string }) {
  const image = useAttachmentImageRenderSource(src);
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

describe("useAttachmentImageRenderSource", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    localStorage.clear();
    apiMock.resolveAttachmentUrl.mockClear();
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

  it("keeps runtime query parameters and upgrades a late signed mapping without changing persistence identity", async () => {
    const rawSrc = `https://notes.example.com/api/attachments/${ATTACHMENT_ID}?w=320`;

    await act(async () => {
      root.render(<Probe src={rawSrc} />);
    });

    const probe = () => host.querySelector<HTMLElement>('[data-testid="probe"]')!;

    expect(apiMock.resolveAttachmentUrl).toHaveBeenCalledWith(rawSrc);
    expect(probe().dataset.persistentSrc).toBe(`/api/attachments/${ATTACHMENT_ID}`);
    // An unsigned private attachment must NEVER be exposed as an <img> URL.
    // The original test expected the pre-auth URL to be renderable, which
    // contradicts the existing verified-attachment-access security boundary.
    expect(probe().dataset.renderSrc).toBe("");
    expect(probe().dataset.error).toBe("1");

    await act(async () => {
      registerAttachmentAccessUrls(
        {
          [ATTACHMENT_ID]:
            `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=late-signature&scope=v2.scope`,
        },
        "https://notes.example.com/api/attachments/access/urls?noteId=note-1",
      );
      await Promise.resolve();
    });

    const upgraded = new URL(probe().dataset.renderSrc!);
    expect(upgraded.origin).toBe("https://notes.example.com");
    expect(upgraded.pathname).toBe(`/api/attachments/${ATTACHMENT_ID}`);
    expect(upgraded.searchParams.get("w")).toBe("320");
    expect(upgraded.searchParams.get("sig")).toBe("late-signature");
    expect(probe().dataset.persistentSrc).toBe(`/api/attachments/${ATTACHMENT_ID}`);
  });

  it("clears an initial raw-url error when signed access arrives later", async () => {
    const rawSrc = `https://notes.example.com/api/attachments/${ATTACHMENT_ID}`;

    await act(async () => {
      root.render(<Probe src={rawSrc} />);
    });

    const probe = () => host.querySelector<HTMLElement>('[data-testid="probe"]')!;
    const failButton = () => host.querySelector<HTMLButtonElement>("button")!;

    await act(async () => {
      failButton().click();
    });
    expect(probe().dataset.error).toBe("1");

    await act(async () => {
      registerAttachmentAccessUrls(
        {
          [ATTACHMENT_ID]:
            `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=recovered-signature&scope=v2.scope`,
        },
        "https://notes.example.com/api/attachments/access/urls?noteId=note-1",
      );
      await Promise.resolve();
    });

    expect(probe().dataset.error).toBe("0");
    expect(new URL(probe().dataset.renderSrc!).searchParams.get("sig")).toBe("recovered-signature");
  });

  it("holds unsigned images until access arrives and shares one request across the note", async () => {
    localStorage.setItem("nowen-token", "jwt-token");
    let finish!: (response: Response) => void;
    const fetch = vi.fn((_url: RequestInfo | URL) => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const raw = `/api/attachments/${ATTACHMENT_ID}`;
    await act(async () => root.render(<AttachmentNoteContext.Provider value="note-1"><Probe src={raw}/><Probe src={raw}/></AttachmentNoteContext.Provider>));
    const probes = () => [...host.querySelectorAll<HTMLElement>('[data-testid="probe"]')];
    expect(probes().every((node) => node.dataset.renderSrc === "" && node.dataset.loading === "1")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("noteId=note-1");
    await act(async () => { finish(new Response(JSON.stringify({ urls: { [ATTACHMENT_ID]: `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=first-access&scope=v2.scope` } }), { status: 200 })); });
    expect(probes().every((node) => node.dataset.renderSrc?.includes("sig=first-access"))).toBe(true);
    expect(probes().every((node) => node.dataset.persistentSrc === raw)).toBe(true);
  });

  it("recovers a transient first authorization failure without a page refresh", async () => {
    localStorage.setItem("nowen-token", "jwt-token");
    const fetch = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ urls: { [ATTACHMENT_ID]: `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=recovered&scope=v2.scope` } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<AttachmentNoteContext.Provider value="note-1"><Probe src={`/api/attachments/${ATTACHMENT_ID}`}/></AttachmentNoteContext.Provider>));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.querySelector<HTMLElement>('[data-testid="probe"]')!.dataset.renderSrc).toContain("sig=recovered");
  });

  it.each([403, 404])("does not retry authorization denial (%s) or issue an unsigned image request", async (status) => {
    localStorage.setItem("nowen-token", "jwt-token");
    const fetch = vi.fn().mockResolvedValue(new Response("denied", { status }));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<AttachmentNoteContext.Provider value="note-1"><Probe src={`/api/attachments/${ATTACHMENT_ID}`}/></AttachmentNoteContext.Provider>));
    expect(fetch).toHaveBeenCalledTimes(1);
    const probe = host.querySelector<HTMLElement>('[data-testid="probe"]')!;
    expect(probe.dataset.renderSrc).toBe(""); expect(probe.dataset.error).toBe("1");
    expect(probe.dataset.loading).toBe("0");
  });

  it("stops after one retry when authorization remains unavailable", async () => {
    localStorage.setItem("nowen-token", "jwt-token");
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<AttachmentNoteContext.Provider value="note-1"><Probe src={`/api/attachments/${ATTACHMENT_ID}`}/></AttachmentNoteContext.Provider>));
    expect(fetch).toHaveBeenCalledTimes(2);
    const probe = host.querySelector<HTMLElement>('[data-testid="probe"]')!;
    expect(probe.dataset.renderSrc).toBe(""); expect(probe.dataset.error).toBe("1");
    expect(probe.dataset.loading).toBe("0");
  });

  it("keeps authorization scoped to each editor when two notes are open", async () => {
    localStorage.setItem("nowen-token", "jwt-token");
    const fetch = vi.fn(async (url: string) => {
      const note = new URL(url).searchParams.get("noteId")!;
      return new Response(JSON.stringify({ urls: { [ATTACHMENT_ID]: `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=${note}&scope=v2.scope` } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<><AttachmentNoteContext.Provider value="note-a"><Probe src={`/api/attachments/${ATTACHMENT_ID}`}/></AttachmentNoteContext.Provider><AttachmentNoteContext.Provider value="note-b"><Probe src={`/api/attachments/${ATTACHMENT_ID}`}/></AttachmentNoteContext.Provider></>));
    expect(fetch.mock.calls.map(([url]) => new URL(url).searchParams.get("noteId")).sort()).toEqual(["note-a", "note-b"]);
  });
});

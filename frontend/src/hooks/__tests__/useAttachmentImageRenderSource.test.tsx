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

import { useAttachmentImageRenderSource } from "@/hooks/useAttachmentImageRenderSource";
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
  });

  it("keeps runtime query parameters and upgrades a late signed mapping without changing persistence identity", async () => {
    const rawSrc = `https://notes.example.com/api/attachments/${ATTACHMENT_ID}?w=320`;

    await act(async () => {
      root.render(<Probe src={rawSrc} />);
    });

    const probe = () => host.querySelector<HTMLElement>('[data-testid="probe"]')!;

    expect(apiMock.resolveAttachmentUrl).toHaveBeenCalledWith(rawSrc);
    expect(probe().dataset.persistentSrc).toBe(`/api/attachments/${ATTACHMENT_ID}`);
    expect(new URL(probe().dataset.renderSrc!).searchParams.get("w")).toBe("320");
    expect(new URL(probe().dataset.renderSrc!).searchParams.get("sig")).toBeNull();

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
});

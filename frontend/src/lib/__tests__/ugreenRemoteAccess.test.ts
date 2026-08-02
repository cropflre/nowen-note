import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getUgreenRemoteAccessUrl,
  installUgreenCredentialedFetch,
  isUgreenRemoteAccessUrl,
  openUgreenRemoteWorkspace,
} from "@/lib/ugreenRemoteAccess";

describe("UGREEN remote access", () => {
  const originalFetch = window.fetch;

  afterEach(() => {
    delete (window as any).nowenDesktop;
    delete (window as any).__nowenUgreenCredentialedFetchInstalled;
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("recognizes HTTPS UGREENlink application addresses", () => {
    expect(isUgreenRemoteAccessUrl("https://app-3001-device.cn57.ugdocker.link/"))
      .toBe(true);
    expect(getUgreenRemoteAccessUrl("https://app-3001-device.cn57.ugdocker.link/api/health"))
      .toBe("https://app-3001-device.cn57.ugdocker.link");
  });

  it("recognizes the official UGREENlink host with an id path", () => {
    expect(getUgreenRemoteAccessUrl("https://ug.link/my-nas/"))
      .toBe("https://ug.link/my-nas");
  });

  it("rejects insecure or lookalike hosts", () => {
    expect(isUgreenRemoteAccessUrl("http://app-3001-device.cn57.ugdocker.link"))
      .toBe(false);
    expect(isUgreenRemoteAccessUrl("https://ugdocker.link.example.com"))
      .toBe(false);
    expect(isUgreenRemoteAccessUrl("https://notes.example.com"))
      .toBe(false);
  });

  it("opens UGREEN access inside the Electron desktop client", async () => {
    const openUgreenRemoteWorkspaceInDesktop = vi.fn(async () => ({ ok: true }));
    (window as any).nowenDesktop = {
      isDesktop: true,
      openUgreenRemoteWorkspace: openUgreenRemoteWorkspaceInDesktop,
    };
    const windowOpen = vi.spyOn(window, "open");

    await openUgreenRemoteWorkspace("https://app-3001-device.cn57.ugdocker.link/");

    expect(openUgreenRemoteWorkspaceInDesktop).toHaveBeenCalledWith(
      "https://app-3001-device.cn57.ugdocker.link",
    );
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("includes the shared UGREEN session only for UGREEN requests", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    window.fetch = fetchMock as typeof window.fetch;
    (window as any).nowenDesktop = { isDesktop: true };
    installUgreenCredentialedFetch();

    await window.fetch("https://app-3001-device.cn57.ugdocker.link/api/me");
    await window.fetch("https://notes.example.com/api/me");

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "https://app-3001-device.cn57.ugdocker.link/api/me",
      { credentials: "include" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "https://notes.example.com/api/me",
      undefined,
    );
  });
});

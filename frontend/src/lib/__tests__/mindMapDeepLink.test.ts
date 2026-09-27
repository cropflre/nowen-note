import { describe, expect, it, vi } from "vitest";
import {
  buildMindMapAppPath,
  buildMindMapDeepLinkUrl,
  getCurrentMindMapAppId,
  isMindMapId,
  parseMindMapAppPath,
  subscribeMindMapAppPath,
} from "@/lib/mindMapDeepLink";

const ID = "11111111-1111-4111-8111-111111111111";

describe("mind map deep links", () => {
  it("parses the module route and a concrete mind map route", () => {
    expect(parseMindMapAppPath("/mindmaps")).toEqual({ matched: true, mindMapId: null });
    expect(parseMindMapAppPath("/mindmaps/")).toEqual({ matched: true, mindMapId: null });
    expect(parseMindMapAppPath(`/mindmaps/${ID}`)).toEqual({ matched: true, mindMapId: ID });
  });

  it("rejects malformed IDs instead of treating them as a source reference", () => {
    expect(isMindMapId(ID)).toBe(true);
    expect(isMindMapId("<uuid>")).toBe(false);
    expect(parseMindMapAppPath("/mindmaps/not-a-uuid")).toEqual({ matched: false, mindMapId: null });
    expect(parseMindMapAppPath("/notes/" + ID)).toEqual({ matched: false, mindMapId: null });
  });

  it("builds canonical app paths without exposing a manual UUID workflow", () => {
    expect(buildMindMapAppPath()).toBe("/mindmaps");
    expect(buildMindMapAppPath(ID)).toBe(`/mindmaps/${ID}`);
    expect(buildMindMapAppPath("invalid")).toBe("/mindmaps");
  });

  it("builds a normal web deep-link URL", () => {
    expect(buildMindMapDeepLinkUrl(ID, "https://note.example.com/")).toBe(
      `https://note.example.com/mindmaps/${ID}`,
    );
  });

  it("keeps Electron file entry parameters while storing the deep link as app path", () => {
    const href =
      "file:///C:/Program%20Files/Nowen/frontend/index.html?serverUrl=http%3A%2F%2F127.0.0.1%3A3001";
    const deepLink = new URL(buildMindMapDeepLinkUrl(ID, href));
    expect(deepLink.protocol).toBe("file:");
    expect(deepLink.searchParams.get("serverUrl")).toBe("http://127.0.0.1:3001");
    expect(deepLink.searchParams.get("nowenAppPath")).toBe(`/mindmaps/${ID}`);
  });

  it("notifies tree selection on in-app navigation and browser history changes", () => {
    const originalUrl = window.location.href;
    const listener = vi.fn();
    const unsubscribe = subscribeMindMapAppPath(listener);
    try {
      window.history.pushState(null, "", `/mindmaps/${ID}`);
      window.dispatchEvent(new Event("nowen:app-path-changed"));
      expect(getCurrentMindMapAppId()).toBe(ID);
      expect(listener).toHaveBeenCalledTimes(1);

      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(getCurrentMindMapAppId()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      window.history.replaceState(null, "", originalUrl);
    }
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

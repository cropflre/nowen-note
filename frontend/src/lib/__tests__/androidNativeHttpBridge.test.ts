import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorState = vi.hoisted(() => ({
  native: true,
  platform: "android",
  request: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.native,
    getPlatform: () => capacitorState.platform,
  },
  CapacitorHttp: {
    request: capacitorState.request,
  },
}));

import {
  installAndroidNativeHttpBridge,
  shouldUseAndroidNativeHttp,
} from "@/lib/androidNativeHttpBridge";

describe("androidNativeHttpBridge", () => {
  let cleanup: (() => void) | null = null;
  let browserFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, "Capacitor");
    capacitorState.native = true;
    capacitorState.platform = "android";
    capacitorState.request.mockReset();
    browserFetch = vi.fn();
    window.fetch = browserFetch as typeof fetch;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.restoreAllMocks();
  });

  it("routes Android startup auth through CapacitorHttp first", async () => {
    capacitorState.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { user: { id: "u1", username: "alice" } },
    });
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("https://note.example.com/api/auth/verify", {
      headers: { Authorization: "Bearer token-1" },
    });

    await expect(response.json()).resolves.toEqual({ user: { id: "u1", username: "alice" } });
    expect(capacitorState.request).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://note.example.com/api/auth/verify",
      method: "GET",
      headers: expect.objectContaining({ authorization: "Bearer token-1" }),
      responseType: "text",
    }));
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("routes JSON API reads through CapacitorHttp", async () => {
    capacitorState.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: [{ id: "n1" }],
    });
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("https://note.example.com/api/notes", {
      headers: { "Content-Type": "application/json" },
    });

    await expect(response.json()).resolves.toEqual([{ id: "n1" }]);
    expect(capacitorState.request).toHaveBeenCalledTimes(1);
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("preserves JSON null responses from CapacitorHttp", async () => {
    capacitorState.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: null,
    });
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("https://note.example.com/api/notebooks/nb-1/share-link", {
      headers: { "Content-Type": "application/json" },
    });

    await expect(response.json()).resolves.toBeNull();
    expect(capacitorState.request).toHaveBeenCalledTimes(1);
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("falls back to WebView fetch when the native request fails", async () => {
    capacitorState.request.mockRejectedValueOnce(new Error("native network failed"));
    browserFetch.mockResolvedValueOnce(new Response(JSON.stringify([{ id: "n1" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("https://note.example.com/api/notes", {
      headers: { "Content-Type": "application/json" },
    });

    await expect(response.json()).resolves.toEqual([{ id: "n1" }]);
    expect(capacitorState.request).toHaveBeenCalledTimes(1);
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });

  it("routes JSON API mutations through CapacitorHttp", async () => {
    capacitorState.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { id: "nb-1", name: "Work" },
    });
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("https://note.example.com/api/notebooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Work" }),
    });

    await expect(response.json()).resolves.toEqual({ id: "nb-1", name: "Work" });
    expect(capacitorState.request).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://note.example.com/api/notebooks",
      method: "POST",
      data: { name: "Work" },
    }));
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("keeps binary API reads on the existing fetch path", async () => {
    browserFetch.mockResolvedValueOnce(new Response("binary-data", { status: 200 }));
    cleanup = installAndroidNativeHttpBridge();

    await fetch("https://note.example.com/api/attachments/file-1/download");

    expect(capacitorState.request).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["/api/attachments/", "/proxy/publicapi/attachments/", "/api/sync/v2/blob/"])(
    "reads attachment bytes through native HTTP without corrupting binary data: %s",
    async (prefix) => {
      const bytes = [137, 80, 78, 71, 13, 10, 26, 10, 0, 255];
      const url = `http://192.168.1.10:3002${prefix}123e4567-e89b-42d3-a456-426614174216?exp=2000000000&sig=image-signature&scope=v2.scope&w=320`;
      capacitorState.request.mockResolvedValueOnce({
        status: 200,
        headers: { "Content-Type": "image/png" },
        data: btoa(String.fromCharCode(...bytes)),
      });
      cleanup = installAndroidNativeHttpBridge();

      const response = await fetch(url, { headers: { Authorization: "Bearer token-1" } });
      const blob = await response.blob();

      expect(blob.type).toBe("image/png");
      expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(bytes);
      expect(capacitorState.request).toHaveBeenCalledWith(expect.objectContaining({
        url,
        method: "GET",
        responseType: "arraybuffer",
        headers: expect.objectContaining({ authorization: "Bearer token-1" }),
      }));
      expect(browserFetch).not.toHaveBeenCalled();
    },
  );

  it("preserves attachment permission errors as JSON instead of decoding them as base64", async () => {
    capacitorState.request.mockResolvedValueOnce({
      status: 403,
      headers: { "Content-Type": "application/json" },
      data: { error: "附件访问权限已失效" },
    });
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("http://192.168.1.10:3002/api/attachments/123e4567-e89b-42d3-a456-426614174216");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "附件访问权限已失效" });
    expect(capacitorState.request).toHaveBeenCalledOnce();
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("keeps uploads and streaming requests on their existing transport", () => {
    const url = "http://192.168.1.10:3002/api/sync/v2/blob/123e4567-e89b-42d3-a456-426614174216";
    expect(shouldUseAndroidNativeHttp(url, { method: "PUT", body: new Blob(["image"]) })).toBe(false);
    expect(shouldUseAndroidNativeHttp(url, { headers: { Accept: "text/event-stream" } })).toBe(false);
    capacitorState.platform = "ios";
    expect(shouldUseAndroidNativeHttp(url)).toBe(false);
  });

  it("preserves original JSON file bytes when Capacitor has already parsed the attachment", async () => {
    capacitorState.request.mockResolvedValueOnce({
      status: 200,
      headers: { "Content-Type": "application/json" },
      data: { value: 1 },
    });
    const originalFile = '{\n  "value": 1\n}\n';
    browserFetch.mockResolvedValueOnce(new Response(originalFile, { status: 200 }));
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("https://note.example.com/api/sync/v2/blob/123e4567-e89b-42d3-a456-426614174216");

    await expect(response.text()).resolves.toBe(originalFile);
    expect(browserFetch).toHaveBeenCalledOnce();
  });

  it("preserves HEAD attachment response headers without creating a body", async () => {
    capacitorState.request.mockResolvedValueOnce({
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": "1024" },
      data: "",
    });
    cleanup = installAndroidNativeHttpBridge();

    const response = await fetch("http://192.168.1.10:3002/api/sync/v2/blob/123e4567-e89b-42d3-a456-426614174216", { method: "HEAD" });

    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("1024");
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("aborts a pending native image read without falling back to WebView fetch", async () => {
    capacitorState.request.mockReturnValueOnce(new Promise(() => undefined));
    cleanup = installAndroidNativeHttpBridge();
    const controller = new AbortController();

    const pending = fetch("http://192.168.1.10:3002/api/attachments/123e4567-e89b-42d3-a456-426614174216", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("does not send an image request that was already aborted", async () => {
    cleanup = installAndroidNativeHttpBridge();
    const controller = new AbortController();
    controller.abort();

    await expect(fetch("http://192.168.1.10:3002/api/attachments/123e4567-e89b-42d3-a456-426614174216", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(capacitorState.request).not.toHaveBeenCalled();
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("blocks every API transport while Android is in unsigned local mode", async () => {
    Object.assign(window, { Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      platform: "android",
    } });
    cleanup = installAndroidNativeHttpBridge();

    await expect(fetch("https://note.example.com/api/attachments/file-1/download"))
      .rejects.toMatchObject({ code: "MOBILE_LOCAL_ONLY" });
    expect(capacitorState.request).not.toHaveBeenCalled();
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("does not intercept non-API resources", async () => {
    browserFetch.mockResolvedValueOnce(new Response("image", { status: 200 }));
    cleanup = installAndroidNativeHttpBridge();

    await fetch("https://cdn.example.com/assets/avatar.png");

    expect(capacitorState.request).not.toHaveBeenCalled();
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });

  it("does not install outside native Capacitor runtime", () => {
    capacitorState.platform = "web";

    cleanup = installAndroidNativeHttpBridge();

    expect(cleanup).toBeNull();
    expect(shouldUseAndroidNativeHttp("https://note.example.com/api/notes", {
      headers: { "Content-Type": "application/json" },
    })).toBe(false);
  });
});

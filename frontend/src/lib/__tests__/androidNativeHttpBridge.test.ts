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
      headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
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

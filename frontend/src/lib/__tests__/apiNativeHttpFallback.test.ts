import { afterEach, describe, expect, it, vi } from "vitest";

const capacitorHttpRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", () => ({
  CapacitorHttp: {
    request: capacitorHttpRequestMock,
  },
}));

import { api, shouldTryNativeHttpFallback } from "@/lib/api";

describe("shouldTryNativeHttpFallback", () => {
  it("returns true for network-like GET failures", () => {
    expect(shouldTryNativeHttpFallback(new TypeError("Failed to fetch"), "GET")).toBe(true);
    expect(shouldTryNativeHttpFallback(new DOMException("timeout", "AbortError"), "GET")).toBe(true);
  });

  it("does not fallback for mutation requests", () => {
    expect(shouldTryNativeHttpFallback(new TypeError("Failed to fetch"), "POST")).toBe(false);
    expect(shouldTryNativeHttpFallback(new TypeError("Failed to fetch"), "PUT")).toBe(false);
  });
});

describe("api native HTTP fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capacitorHttpRequestMock.mockReset();
    localStorage.clear();
    delete (window as any).Capacitor;
  });

  it("uses CapacitorHttp for Android native GET requests when fetch fails", async () => {
    localStorage.setItem("nowen-server-url", "https://note.example.com");
    localStorage.setItem("nowen-token", "token-1");
    (window as any).Capacitor = { isNativePlatform: () => true };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    capacitorHttpRequestMock.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { id: "u1", username: "alice" },
    });

    const result = await api.getMe();

    expect(result).toEqual({ id: "u1", username: "alice" });
    expect(capacitorHttpRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://note.example.com/api/me",
      method: "GET",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      responseType: "json",
    }));
  });

  it("does not use CapacitorHttp outside native Capacitor", async () => {
    localStorage.setItem("nowen-server-url", "https://note.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(api.getMe()).rejects.toThrow("Failed to fetch");

    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });

  it("does not use CapacitorHttp for failed POST requests", async () => {
    localStorage.setItem("nowen-server-url", "https://note.example.com");
    (window as any).Capacitor = { isNativePlatform: () => true };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(api.createNotebook({ name: "Work" })).rejects.toThrow("Failed to fetch");

    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });
});


describe("api native HTTP fallback with IPv6 server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capacitorHttpRequestMock.mockReset();
    localStorage.clear();
    delete (window as any).Capacitor;
  });

  it("passes a bracketed IPv6 API URL to CapacitorHttp", async () => {
    localStorage.setItem("nowen-server-url", "240e:35c:41f:4c00::1d0/128");
    localStorage.setItem("nowen-token", "token-ipv6");
    (window as any).Capacitor = { isNativePlatform: () => true };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    capacitorHttpRequestMock.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { id: "u-ipv6", username: "ipv6-user" },
    });

    await expect(api.getMe()).resolves.toEqual({ id: "u-ipv6", username: "ipv6-user" });
    expect(capacitorHttpRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://[240e:35c:41f:4c00::1d0]/api/me",
      method: "GET",
    }));
  });
});

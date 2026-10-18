import { afterEach, describe, expect, it, vi } from "vitest";
import { testServerConnection } from "../api";
import { inspectAndroidServerTls } from "../serverConnectionDiagnostics";

const native = vi.hoisted(() => ({ inspect: vi.fn(), android: false }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.android, getPlatform: () => native.android ? "android" : "web" },
  registerPlugin: () => ({ inspect: native.inspect }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  native.inspect.mockReset();
  native.android = false;
  localStorage.clear();
});

describe("server connection failure diagnostics", () => {
  it("identifies HTTP sent to an HTTPS port without retrying credentials or changing protocol", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("<h1>The plain HTTP request was sent to HTTPS port</h1>", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const result = await testServerConnection("http://notes.example.com:12151");
    expect(result).toMatchObject({ ok: false, diagnostic: { kind: "httpsRequired" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("http://notes.example.com:12151/api/health");
    expect(native.inspect).not.toHaveBeenCalled();
    expect(localStorage.getItem("nowen-server-url")).toBeNull();
  });

  it("does not mislabel an ordinary HTTP 400 as a protocol error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad request", { status: 400 })));
    const result = await testServerConnection("http://notes.example.com");
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("uses Android TLS diagnostics to show expiry even when fetch hides the cause", async () => {
    native.android = true;
    native.inspect.mockResolvedValue({ kind: "certificateExpired", expiresAt: 1782691199000 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Chain validation failed"); }));
    const result = await testServerConnection("https://notes.example.com:12151/nowen");
    expect(result).toMatchObject({ ok: false, diagnostic: { kind: "certificateExpired", expiresAt: 1782691199000 } });
    expect(native.inspect).toHaveBeenCalledWith({ url: "https://notes.example.com:12151" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["java.security.cert.CertificateExpiredException", "certificateExpired"],
    ["Hostname notes.example.com not verified", "hostnameMismatch"],
    ["No subjectAltNames on the certificate match", "hostnameMismatch"],
    ["Trust anchor for certification path not found", "certificateUntrusted"],
    ["SSLHandshakeException: handshake failed", "tlsFailed"],
    ["CertificateNotYetValidException", "certificateNotYetValid"],
    ["ERR_CERT_DATE_INVALID", "tlsFailed"],
  ])("classifies specific transport errors: %s", async (message, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(message); }));
    expect(await testServerConnection("https://notes.example.com")).toMatchObject({ ok: false, diagnostic: { kind } });
  });

  it("preserves unknown failures on Web and shells without the diagnostic plugin", async () => {
    native.android = true;
    native.inspect.mockRejectedValue(new Error("Plugin not implemented"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const result = await testServerConnection("https://notes.example.com");
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toBeUndefined();
    expect(native.inspect).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps probing compatibility paths after a normal HTTP error", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", service: "nowen-note" }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await testServerConnection("https://notes.example.com")).toMatchObject({ ok: true, apiPath: "/public/api" });
    expect(native.inspect).not.toHaveBeenCalled();
  });

  it("sends only the HTTPS origin to native inspection and preserves an unavailable diagnosis", async () => {
    native.android = true;
    native.inspect.mockResolvedValue({});
    expect(await inspectAndroidServerTls("https://notes.example.com:12151/nowen?token=secret#private")).toBeUndefined();
    expect(native.inspect).toHaveBeenCalledWith({ url: "https://notes.example.com:12151" });
    native.inspect.mockClear();
    expect(await inspectAndroidServerTls("https://user:password@notes.example.com")).toBeUndefined();
    expect(native.inspect).not.toHaveBeenCalled();
  });

  it("bounds native inspection time even if the shell never replies", async () => {
    native.android = true;
    native.inspect.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const result = inspectAndroidServerTls("https://notes.example.com");
    await vi.waitFor(() => expect(native.inspect).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(12000);
    expect(await result).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

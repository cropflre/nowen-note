import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
  // Production plugin proxies end in the injected bridge's nativePromise.
  CapacitorHttp: {
    request: (options: unknown) => (window as unknown as NativeWindow).Capacitor.nativePromise("CapacitorHttp", "request", options),
  },
}));
vi.mock("../authSession", () => ({
  getAccessToken: () => "token",
  fetchWithAuthRefresh: (input: RequestInfo | URL, init: RequestInit, _base: string, fetchImpl: typeof fetch) => fetchImpl(input, init),
}));

import { installAndroidNativeHttpBridge } from "../androidNativeHttpBridge";
import { MobileSyncEngine } from "../mobileSyncEngine";

/**
 * Android upload transport with the real Capacitor 8 JavaScript bridge.
 *
 * The bridge script is loaded unchanged. Only the Java side is emulated, following
 * @capacitor/android 8.4.3: CapacitorHttpUrlConnection.setRequestBody (request bytes),
 * HttpRequestHandler.readData (HEAD has no error stream; getInputStream() throws for HTTP >= 400)
 * and WebViewLocalServer.handleCapacitorHttpRequest (the interceptor fails the same way).
 */
interface NativeWindow {
  Capacitor: { nativePromise(plugin: string, method: string, options: unknown): Promise<unknown> };
  androidBridge: { postMessage(message: string): void; onmessage?: (event: { data: string }) => void };
  CapacitorHttpAndroidInterface: { isEnabled(): boolean };
  WEBVIEW_SERVER_URL: string;
}
interface NativeOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  data?: unknown;
  dataType?: string;
  responseType?: string;
}
interface WireResponse { status: number; headers: Record<string, string>; body?: string }
type Server = (request: { method: string; url: string; body: Uint8Array }) => WireResponse;

const NATIVE_BRIDGE = path.resolve(__dirname, "../../../node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js");
const SERVER = "http://192.168.1.10:3001";
const ATTACHMENT_ID = "123e4567-e89b-42d3-a456-426614174216";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const header = (headers: Record<string, string> = {}, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] || "";
const json = (status: number, value: unknown): WireResponse => ({
  status, headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(value),
});

function installAndroidRuntime(server: Server): void {
  const runtime = window as unknown as NativeWindow;
  const nativeRequest = (options: NativeOptions) => {
    const method = options.method.toUpperCase();
    let body = new Uint8Array();
    const contentType = header(options.headers, "content-type");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && options.data != null && contentType) {
      const text = typeof options.data === "string" ? options.data : JSON.stringify(options.data);
      body = !contentType.includes("application/json") && options.dataType === "file"
        ? Uint8Array.from(atob(text), (character) => character.charCodeAt(0))
        : new TextEncoder().encode(text);
    }
    const response = server({ method, url: options.url, body });
    if (method === "HEAD" && response.status >= 400) {
      throw { message: options.url, code: "FileNotFoundException" };
    }
    const text = response.body || "";
    const data = header(response.headers, "content-type").includes("application/json")
      ? (text.trim() ? JSON.parse(text) : "")
      : response.status < 400 && options.responseType === "arraybuffer" ? btoa(text) : text;
    return { status: response.status, headers: response.headers, url: options.url, data };
  };
  // Capacitor stores this as CapacitorWebFetch; only its HTTP interceptor URL is used here.
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method || "GET").toUpperCase();
    if (url.pathname !== "/_capacitor_http_interceptor_") throw new TypeError("Failed to fetch");
    const response = server({ method, url: url.searchParams.get("u") || "", body: new Uint8Array() });
    // The interceptor returns null after the native exception; nothing serves https://localhost.
    if (method === "HEAD" && response.status >= 400) throw new TypeError("Failed to fetch");
    return new Response(method === "HEAD" ? null : response.body || null, { status: response.status, headers: response.headers });
  }) as typeof fetch;
  runtime.WEBVIEW_SERVER_URL = "https://localhost";
  runtime.CapacitorHttpAndroidInterface = { isEnabled: () => true };
  runtime.androidBridge = {
    postMessage(message: string) {
      const call = JSON.parse(message) as { callbackId: string; pluginId: string; methodName: string; options: NativeOptions };
      if (call.pluginId !== "CapacitorHttp" || call.methodName !== "request") return;
      queueMicrotask(() => {
        let result: Record<string, unknown>;
        try { result = { success: true, data: nativeRequest(call.options) }; }
        catch (error) { result = { success: false, error }; }
        runtime.androidBridge.onmessage?.({ data: JSON.stringify({ callbackId: call.callbackId, pluginId: call.pluginId, methodName: call.methodName, ...result }) });
      });
    },
  };
  // jsdom AbortSignal is foreign to Node's Request; a WebView has a single realm.
  const NodeRequest = globalThis.Request;
  globalThis.Request = class extends NodeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, init && { ...init, signal: undefined }); }
  } as typeof Request;
  (0, eval)(readFileSync(NATIVE_BRIDGE, "utf8"));
}

/** Sync V2 blob route semantics; `missingHeadStatus` is 409 for v1.5.5 servers. */
function blobServer(expected: Uint8Array, mimeType: string, missingHeadStatus: number) {
  const stored = new Map<string, Uint8Array>();
  const methods: string[] = [];
  const handle: Server = ({ method, url, body }) => {
    methods.push(method);
    const id = new URL(url).pathname.split("/").pop() || "";
    if (method === "PUT") {
      if (sha256(body) !== sha256(expected)) return json(409, { error: "内容校验失败", code: "CHECKSUM_MISMATCH" });
      stored.set(id, body);
      return json(200, { attachmentId: id, size: body.length, hash: sha256(body), stored: true });
    }
    if (stored.has(id)) return { status: 200, headers: { "Content-Type": mimeType } };
    return { status: missingHeadStatus, headers: { "Content-Type": "application/json; charset=UTF-8" } };
  };
  return { stored, methods, handle };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; localStorage.clear(); });

/** Runs one Android attachment transfer round against the emulated native runtime. */
async function transferOnce(options: {
  mimeType: string; bytes: Uint8Array; missingHeadStatus: number; transferStatus?: string; alreadyStored?: boolean;
}) {
  const { mimeType, bytes, missingHeadStatus } = options;
  const server = blobServer(bytes, mimeType, missingHeadStatus);
  if (options.alreadyStored) server.stored.set(ATTACHMENT_ID, bytes);
  localStorage.setItem("nowen-token", "token"); // signed in to a server, not device-only mode
  installAndroidRuntime(server.handle);
  cleanup = installAndroidNativeHttpBridge();
  const row = {
    id: ATTACHMENT_ID, mimeType, size: bytes.length, hash: sha256(bytes),
    transferStatus: options.transferStatus || "pending_upload",
    transferError: (options.transferStatus === "failed" ? "网络不可用" : null) as unknown,
    available: 1, localPath: `files/${ATTACHMENT_ID}`,
  };
  const db = {
    query: vi.fn(async () => [row]),
    run: vi.fn(async (sql: string, params: unknown[] = []) => {
      const status = sql.match(/transferStatus='(\w+)'/)?.[1];
      if (status) row.transferStatus = status;
      if (status === "failed") row.transferError = params[0];
      if (status === "uploaded") row.transferError = null;
      return { changes: 1 };
    }),
  };
  const attachments = {
    read: vi.fn(async (_id: string, type?: string) => new Blob([bytes], { type })),
    exists: vi.fn(async () => true),
    save: vi.fn(),
  };
  const onNetworkUnavailable = vi.fn();
  const engine = new MobileSyncEngine({
    db, attachments, serverUrl: SERVER, token: "token", userId: "u", profileId: "p", deviceId: "d", onNetworkUnavailable,
  } as never);
  const internal = engine as unknown as { stopped: boolean; transferAttachments(scope: unknown): Promise<void> };
  internal.stopped = false;
  await internal.transferAttachments({ scopeKey: "personal", workspaceId: null });
  engine.stop();
  return { row, server, onNetworkUnavailable, attachments };
}

async function expectOriginalBytesStored(options: Parameters<typeof transferOnce>[0]): Promise<void> {
  const { row, server, onNetworkUnavailable } = await transferOnce(options);
  expect({ status: row.transferStatus, error: row.transferError, requests: server.methods })
    .toMatchObject({ status: "uploaded", error: null });
  expect(server.stored.get(ATTACHMENT_ID)).toEqual(options.bytes);
  expect(server.methods.filter((method) => method === "PUT")).toHaveLength(1);
  expect(onNetworkUnavailable).not.toHaveBeenCalled();
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x7b, 0x7d, 0xff, 0xd9]);

describe("Android attachment upload through Capacitor native HTTP", () => {
  it("DCC-003: Android native HTTP upload stores the original bytes of a new image", async () => {
    await expectOriginalBytesStored({ mimeType: "image/jpeg", bytes: JPEG, missingHeadStatus: 409 });
  });

  it("DCC-003: Android native HTTP upload stores the original bytes of a JSON attachment instead of base64 text", async () => {
    const json = Uint8Array.from(new TextEncoder().encode('{"notes":["原文"]}\n'));
    await expectOriginalBytesStored({ mimeType: "application/json", bytes: json, missingHeadStatus: 404 });
  });

  it("DCC-003: Android native HTTP upload stores the original bytes when retrying after a v1.5.5 HEAD 409", async () => {
    await expectOriginalBytesStored({ mimeType: "image/jpeg", bytes: JPEG, missingHeadStatus: 409, transferStatus: "failed" });
  });

  it("DCC-003: Android native HTTP upload stores the original bytes when retrying after a HEAD 404", async () => {
    await expectOriginalBytesStored({ mimeType: "image/jpeg", bytes: JPEG, missingHeadStatus: 404, transferStatus: "failed" });
  });

  it("DCC-003: Android native HTTP upload confirms a retried attachment whose bytes already landed without uploading again", async () => {
    const { row, server, onNetworkUnavailable, attachments } = await transferOnce({
      mimeType: "image/jpeg", bytes: JPEG, missingHeadStatus: 404, transferStatus: "failed", alreadyStored: true,
    });
    expect(row.transferStatus).toBe("uploaded");
    expect(server.methods).toEqual(["HEAD"]);
    expect(attachments.read).not.toHaveBeenCalled();
    expect(onNetworkUnavailable).not.toHaveBeenCalled();
  });
});

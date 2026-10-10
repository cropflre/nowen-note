import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, test } from "node:test";
import { aiOutboundFetch, getAIOutboundProxyStatus, shouldBypassAIProxy } from "../src/services/ai-outbound-fetch";

const previousProxy = process.env.NOWEN_AI_PROXY_URL;
const previousBypass = process.env.NOWEN_AI_NO_PROXY;
afterEach(() => {
  if (previousProxy === undefined) delete process.env.NOWEN_AI_PROXY_URL;
  else process.env.NOWEN_AI_PROXY_URL = previousProxy;
  if (previousBypass === undefined) delete process.env.NOWEN_AI_NO_PROXY;
  else process.env.NOWEN_AI_NO_PROXY = previousBypass;
});

test("Issue #815: AI proxy disabled by default and local AI model URLs bypass proxy", () => {
  const env = { NOWEN_AI_NO_PROXY: "ollama,.internal" };
  assert.equal(getAIOutboundProxyStatus(env).enabled, false);
  for (const host of ["localhost", "127.0.0.1", "192.168.1.8", "ollama", "chat.internal"]) {
    assert.equal(shouldBypassAIProxy(new URL("http://" + host + ":11434/v1"), env), true, host);
  }
  assert.equal(shouldBypassAIProxy(new URL("https://api.openai.com/v1"), env), false);
});

test("invalid proxy is rejected without returning secret credentials", async () => {
  process.env.NOWEN_AI_PROXY_URL = "socks5://u:secret@myproxy.example:1080";
  const status = getAIOutboundProxyStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.valid, false);
  assert.doesNotMatch(JSON.stringify(status), /secret|myproxy.example/);
  await assert.rejects(aiOutboundFetch("https://api.openai.com/v1/models"), /NOWEN_AI_PROXY_URL/);
});

test("without a proxy the native fetch path preserves headers and AbortSignal", async () => {
  delete process.env.NOWEN_AI_PROXY_URL;
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response("direct-ok");
  };
  try {
    const abort = new AbortController();
    const result = await aiOutboundFetch("https://api.example.com/models", {
      headers: { Authorization: "Bearer sample" }, signal: abort.signal,
    });
    assert.equal(await result.text(), "direct-ok");
    assert.equal(calls[0].url, "https://api.example.com/models");
    assert.equal(calls[0].options?.signal, abort.signal);
  } finally {
    globalThis.fetch = previous;
  }
});

test("an outbound AI request reaches an upstream through HTTP CONNECT proxy", async () => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, "Bearer example");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "routed" }] }));
  });
  const proxy = http.createServer();
  const sockets = new Set<net.Socket>();
  proxy.on("connect", (_request, browserSocket, head) => {
    const upstreamSocket = net.connect((upstream.address() as net.AddressInfo).port, "127.0.0.1", () => {
      browserSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      browserSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(browserSocket);
    });
    sockets.add(browserSocket); sockets.add(upstreamSocket);
    browserSocket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => browserSocket.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    process.env.NOWEN_AI_PROXY_URL = "http://127.0.0.1:" + (proxy.address() as net.AddressInfo).port;
    const response = await aiOutboundFetch("http://api.example.test/v1/models", {
      headers: { Authorization: "Bearer example" }, signal: AbortSignal.timeout(3500),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: "routed" }] });
  } finally {
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
  }
});

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { callEmbeddings } from "../src/services/embedding-client";
import { embeddingRetryDecision, MAX_EMBEDDING_RETRIES } from "../src/services/embedding-retry-policy";

test("slow embedding batches respect the selected deadline and remain retryable", async (t) => {
  const nativeTimeout = AbortSignal.timeout;
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    deadlines.push(ms);
    return nativeTimeout(ms / 100);
  });
  const server = http.createServer((req, res) => {
    req.resume();
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: Array.from({ length: 8 }, (_, index) => ({ index, embedding: [index, 1] })) }));
    }, 620);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cfg = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: "fixture", apiKey: "", provider: "openai" };
  const inputs = Array(8).fill("synthetic chunk");
  try {
    await assert.rejects(callEmbeddings(cfg, inputs), (error: Error) => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /^Embedding request timed out after \d+ms \(limit: 30000ms\)$/);
      assert.equal(embeddingRetryDecision(error, 1).retry, true);
      assert.equal(embeddingRetryDecision(error, MAX_EMBEDDING_RETRIES).retry, false);
      return true;
    });
    const vectors = await callEmbeddings(cfg, inputs, undefined, 120_000);
    assert.equal(vectors.length, 8);
    assert.deepEqual(deadlines, [30_000, 120_000]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("caller cancellation is preserved instead of being reported as a timeout", async (t) => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled by caller", "AbortError");
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    controller.abort(reason);
    throw init.signal!.reason;
  });
  await assert.rejects(callEmbeddings({ url: "http://localhost", model: "fixture", apiKey: "", provider: "openai" }, ["query"], controller.signal), (error) => error === reason);
});

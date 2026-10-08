import assert from "node:assert/strict";
import test from "node:test";
import { SyncBlobClient } from "../src/sync/blob";
import { classifyHttpStatus, SyncError } from "../src/sync/errors";

const clientOptions = {
  serverUrl: "https://sync.example",
  credential: { serverUrl: "https://sync.example", token: "private-access-token" },
};

test("HTTP status classifier preserves server business codes without treating 403 as auth expiry", () => {
  assert.equal(classifyHttpStatus(403), "SCOPE_FORBIDDEN");
  assert.equal(classifyHttpStatus(403, "ACCESS_REVOKED"), "ACCESS_REVOKED");
  assert.equal(classifyHttpStatus(403, "AUTH_EXPIRED"), "AUTH_EXPIRED");
  assert.equal(classifyHttpStatus(409, "CHECKSUM_MISMATCH"), "VALIDATION_FAILED");
  assert.equal(classifyHttpStatus(401), "AUTH_EXPIRED");
  assert.equal(classifyHttpStatus(404), "SERVER_ERROR");
});

function clientFor(status: number, payload: unknown, method: string) {
  let calledMethod: string | undefined;
  const client = new SyncBlobClient({
    ...clientOptions,
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      calledMethod = init?.method;
      return new Response(method === "HEAD" ? null : JSON.stringify(payload), {
        status,
        headers: method === "HEAD" ? undefined : { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
  return { client, calledMethod: () => calledMethod };
}

test("HEAD 403 is a permission error, not an expired login", async () => {
  const { client, calledMethod } = clientFor(403, {}, "HEAD");
  await assert.rejects(client.exists("attachment-id"), (error: unknown) => (
    error instanceof SyncError && error.code === "SCOPE_FORBIDDEN"
  ));
  assert.equal(calledMethod(), "HEAD");
});

test("upload checksum mismatch is non-retryable validation failure", async () => {
  const { client } = clientFor(409, { code: "CHECKSUM_MISMATCH" }, "PUT");
  await assert.rejects(client.upload("attachment-id", Buffer.from("bad")), (error: unknown) => (
    error instanceof SyncError && error.code === "VALIDATION_FAILED" && error.retryable === false
  ));
});

test("explicit server permission failure survives download mapping", async () => {
  const { client } = clientFor(403, { code: "ACCESS_REVOKED", error: "private" }, "GET");
  await assert.rejects(client.download("attachment-id"), (error: unknown) => (
    error instanceof SyncError && error.code === "ACCESS_REVOKED" && !error.message.includes("private")
  ));
});

test("proxy HTML fallback never appears in sync error message", async () => {
  const client = new SyncBlobClient({
    ...clientOptions,
    fetchImpl: (async () => new Response("<html>secret-token</html>", {
      status: 502, headers: { "Content-Type": "text/html" },
    })) as typeof fetch,
  });
  await assert.rejects(client.download("attachment-id"), (error: unknown) => (
    error instanceof SyncError
      && error.code === "SERVER_ERROR"
      && !error.message.includes("secret-token")
  ));
});

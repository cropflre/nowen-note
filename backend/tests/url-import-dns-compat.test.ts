import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSystemLookupResolver } from "../src/lib/dnsSystemLookupCompat";

function runResolver(resolver: any, hostname: string, options?: unknown): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, records?: any[]) => {
      if (error) reject(error);
      else resolve(records || []);
    };
    if (options === undefined) resolver(hostname, callback);
    else resolver(hostname, options, callback);
  });
}

test("falls back to the operating-system resolver when c-ares resolution fails", async () => {
  const original = (_hostname: string, callback: (error: NodeJS.ErrnoException) => void) => {
    const error = new Error("queryA ETIMEOUT") as NodeJS.ErrnoException;
    error.code = "ETIMEOUT";
    setImmediate(() => callback(error));
  };
  const lookup = (_hostname: string, options: any, callback: any) => {
    assert.deepEqual(options, { all: true, family: 4, verbatim: true });
    setImmediate(() => callback(null, [
      { address: "203.0.113.20", family: 4 },
      { address: "203.0.113.20", family: 4 },
    ]));
  };

  const resolver = createSystemLookupResolver(4, original as any, lookup as any);
  assert.deepEqual(await runResolver(resolver, "mp.weixin.qq.com"), ["203.0.113.20"]);
});

test("preserves ttl-shaped resolve results for callers that request ttl", async () => {
  const pendingOriginal = () => { /* system lookup wins */ };
  const lookup = (_hostname: string, _options: any, callback: any) => {
    setImmediate(() => callback(null, [{ address: "2001:4860:4860::8888", family: 6 }]));
  };

  const resolver = createSystemLookupResolver(6, pendingOriginal as any, lookup as any);
  assert.deepEqual(await runResolver(resolver, "mp.weixin.qq.com", { ttl: true }), [
    { address: "2001:4860:4860::8888", ttl: 0 },
  ]);
});

test("reports failure only when both c-ares and the system resolver fail", async () => {
  const original = (_hostname: string, callback: (error: NodeJS.ErrnoException) => void) => {
    const error = new Error("c-ares failed") as NodeJS.ErrnoException;
    error.code = "ESERVFAIL";
    setImmediate(() => callback(error));
  };
  const lookup = (_hostname: string, _options: any, callback: any) => {
    const error = new Error("system lookup failed") as NodeJS.ErrnoException;
    error.code = "ENOTFOUND";
    setImmediate(() => callback(error));
  };

  const resolver = createSystemLookupResolver(4, original as any, lookup as any);
  await assert.rejects(runResolver(resolver, "invalid.example"), /c-ares failed/);
});

test("installs the compatibility layer before the legacy URL-import route is evaluated", () => {
  const entry = readFileSync(new URL("../src/index.hardened.ts", import.meta.url), "utf8");
  const compatIndex = entry.indexOf('import "./runtime/url-import-dns-compat.js"');
  const legacyIndex = entry.indexOf('import "./index.js"');
  assert.ok(compatIndex >= 0, "DNS compatibility bootstrap must be imported");
  assert.ok(legacyIndex > compatIndex, "DNS compatibility must load before index.js and url-import.ts");
});

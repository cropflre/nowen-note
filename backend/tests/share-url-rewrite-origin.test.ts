import assert from "node:assert/strict";
import test from "node:test";
import { resolvePublicOrigin } from "../src/lib/shareUrlRewrite";

function headers(values: Record<string, string | undefined>) {
  return (name: string): string | undefined => values[name.toLowerCase()];
}

test("container loopback Host is never advertised as a public attachment origin", () => {
  assert.equal(resolvePublicOrigin(headers({ host: "127.0.0.1:3001" })), null);
  assert.equal(resolvePublicOrigin(headers({ host: "localhost:3001" })), null);
  assert.equal(resolvePublicOrigin(headers({ host: "0.0.0.0:3001" })), null);
  assert.equal(resolvePublicOrigin(headers({ host: "[::1]:3001" })), null);
  assert.equal(resolvePublicOrigin(headers({
    host: "notes.example.com",
    "x-forwarded-host": "127.0.0.1:3001",
    "x-forwarded-proto": "https",
  })), null);
});

test("trusted reverse-proxy headers remain authoritative", () => {
  assert.equal(
    resolvePublicOrigin(headers({
      host: "127.0.0.1:3001",
      "x-forwarded-host": "notes.example.com",
      "x-forwarded-proto": "https",
    })),
    "https://notes.example.com",
  );
});

test("direct NAS and custom-port access keeps the reachable HTTP origin", () => {
  assert.equal(
    resolvePublicOrigin(headers({ host: "192.168.1.20:3001" })),
    "http://192.168.1.20:3001",
  );
  assert.equal(
    resolvePublicOrigin(headers({ host: "notes.example.com:8080" })),
    "http://notes.example.com:8080",
  );
});

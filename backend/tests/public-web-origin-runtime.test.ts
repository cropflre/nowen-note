import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePublicWebOrigin,
  resolvePublicWebOriginSettingUpdate,
  resolveRuntimePublicWebOrigin,
} from "../src/lib/public-web-origin";

test("normalizePublicWebOrigin accepts only clean HTTP(S) roots", () => {
  assert.equal(
    normalizePublicWebOrigin("https://note.example.com/public///"),
    "https://note.example.com/public",
  );
  assert.equal(normalizePublicWebOrigin("http://192.168.1.2:3001/"), "http://192.168.1.2:3001");
  assert.equal(normalizePublicWebOrigin("https://user:pass@example.com"), "");
  assert.equal(normalizePublicWebOrigin("https://example.com/?token=secret"), "");
  assert.equal(normalizePublicWebOrigin("file:///tmp/index.html"), "");
});

test("administrator setting has priority over the container environment", () => {
  assert.deepEqual(resolveRuntimePublicWebOrigin({
    storedOrigin: "https://admin.example.com",
    storedSource: "settings",
    envOrigin: "https://env.example.com",
  }), {
    origin: "https://admin.example.com",
    source: "settings",
  });
});

test("container environment supplies a runtime origin when no admin override exists", () => {
  assert.deepEqual(resolveRuntimePublicWebOrigin({
    storedOrigin: "",
    storedSource: "current",
    envOrigin: "https://env.example.com",
  }), {
    origin: "https://env.example.com",
    source: "environment",
  });
});

test("removing the environment does not retain a stale materialized value", () => {
  assert.deepEqual(resolveRuntimePublicWebOrigin({
    storedOrigin: "https://old-env.example.com",
    storedSource: "environment",
    envOrigin: "",
  }), {
    origin: "",
    source: "current",
  });
});

test("clearing an admin setting falls back to the runtime environment", () => {
  assert.deepEqual(resolvePublicWebOriginSettingUpdate("", {
    PUBLIC_WEB_ORIGIN: "https://env.example.com",
  }), {
    entries: [
      { key: "site_public_web_origin", value: "https://env.example.com" },
      { key: "site_public_web_origin_source", value: "environment" },
    ],
  });
});

test("invalid administrator values are rejected", () => {
  assert.deepEqual(resolvePublicWebOriginSettingUpdate("javascript:alert(1)", {}), {
    error: "公开分享域名必须是有效的 HTTP/HTTPS 地址，且不能包含账号、查询参数或锚点",
  });
});

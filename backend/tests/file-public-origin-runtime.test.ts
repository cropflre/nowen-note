import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFilePublicOriginSettingUpdate,
  resolveRuntimeFilePublicOrigin,
} from "../src/lib/file-public-origin";

test("administrator file origin has priority over FILE_PUBLIC_ORIGIN", () => {
  assert.deepEqual(resolveRuntimeFilePublicOrigin({
    storedOrigin: "https://files.admin.example.com",
    storedSource: "settings",
    envOrigin: "https://files.env.example.com",
  }), {
    origin: "https://files.admin.example.com",
    source: "settings",
  });
});

test("FILE_PUBLIC_ORIGIN is used when no administrator override exists", () => {
  assert.deepEqual(resolveRuntimeFilePublicOrigin({
    storedOrigin: "",
    storedSource: "inherit",
    envOrigin: "https://files.env.example.com/base",
  }), {
    origin: "https://files.env.example.com/base",
    source: "environment",
  });
});

test("removing FILE_PUBLIC_ORIGIN falls back to inherited public web origin", () => {
  assert.deepEqual(resolveRuntimeFilePublicOrigin({
    storedOrigin: "https://old-env.example.com",
    storedSource: "environment",
    envOrigin: "",
  }), {
    origin: "",
    source: "inherit",
  });
});

test("clearing administrator file origin falls back to FILE_PUBLIC_ORIGIN", () => {
  assert.deepEqual(resolveFilePublicOriginSettingUpdate("", {
    FILE_PUBLIC_ORIGIN: "https://files.env.example.com",
  }), {
    entries: [
      { key: "site_file_public_origin", value: "https://files.env.example.com" },
      { key: "site_file_public_origin_source", value: "environment" },
    ],
  });
});

test("clearing administrator file origin without env marks it as inherited", () => {
  assert.deepEqual(resolveFilePublicOriginSettingUpdate("", {}), {
    entries: [
      { key: "site_file_public_origin", value: "" },
      { key: "site_file_public_origin_source", value: "inherit" },
    ],
  });
});

test("invalid public file origins are rejected", () => {
  assert.deepEqual(resolveFilePublicOriginSettingUpdate("javascript:alert(1)", {}), {
    error: "文件公开地址必须是有效的 HTTP/HTTPS 地址，且不能包含账号、查询参数或锚点",
  });
  assert.deepEqual(resolveFilePublicOriginSettingUpdate("https://user:pass@example.com", {}), {
    error: "文件公开地址必须是有效的 HTTP/HTTPS 地址，且不能包含账号、查询参数或锚点",
  });
});

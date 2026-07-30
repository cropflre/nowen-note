import assert from "node:assert/strict";
import test from "node:test";

import { getDb } from "../src/db/schema";
import {
  clearBackupWebDavConfig,
  getBackupWebDavConfig,
  saveBackupWebDavConfig,
  testBackupWebDavConnection,
} from "../src/services/backup-webdav";

process.env.BACKUP_WEBDAV_ENCRYPTION_KEY = "backup-webdav-test-key-at-least-32-bytes";

test("WebDAV credentials are encrypted at rest and never returned by the public config", () => {
  clearBackupWebDavConfig();
  const publicConfig = saveBackupWebDavConfig({
    enabled: true,
    endpoint: "https://dav.example.test/root/",
    username: "backup-user",
    password: "very-secret-password",
    remotePath: "/nowen-note//backups/",
    uploadOnAutoBackup: true,
  });

  assert.equal(publicConfig.endpoint, "https://dav.example.test/root");
  assert.equal(publicConfig.username, "backup-user");
  assert.equal(publicConfig.passwordSet, true);
  assert.equal(publicConfig.remotePath, "nowen-note/backups");
  assert.equal(publicConfig.uploadOnAutoBackup, true);
  assert.equal("password" in publicConfig, false);

  const row = getDb().prepare("SELECT value FROM system_settings WHERE key = 'backup:webdav'").get() as {
    value: string;
  };
  assert.equal(row.value.includes("very-secret-password"), false);
  assert.match(JSON.parse(row.value).passwordEnc, /^v1:/);

  const preserved = saveBackupWebDavConfig({
    enabled: true,
    endpoint: "https://dav.example.test/root",
    username: "backup-user",
    remotePath: "archive",
    uploadOnAutoBackup: false,
  });
  assert.equal(preserved.passwordSet, true);
  assert.equal(preserved.remotePath, "archive");
});

test("WebDAV config rejects unsafe URL forms and remote traversal", () => {
  clearBackupWebDavConfig();
  assert.throws(
    () => saveBackupWebDavConfig({ enabled: true, endpoint: "ftp://dav.example.test" }),
    /仅支持 http:\/\/ 或 https:\/\//,
  );
  assert.throws(
    () => saveBackupWebDavConfig({ enabled: true, endpoint: "https://user:pass@dav.example.test" }),
    /不要把账号密码写在 WebDAV URL/,
  );
  assert.throws(
    () => saveBackupWebDavConfig({ enabled: true, endpoint: "https://dav.example.test?a=1" }),
    /不能包含查询参数/,
  );
  assert.throws(
    () => saveBackupWebDavConfig({ enabled: true, endpoint: "https://dav.example.test", remotePath: "../escape" }),
    /远端目录格式不合法/,
  );
});

test("WebDAV connection test probes the root and creates each missing directory segment", async () => {
  clearBackupWebDavConfig();
  saveBackupWebDavConfig({
    enabled: true,
    endpoint: "https://dav.example.test/root",
    username: "u",
    password: "p",
    remotePath: "nowen-note/backups",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const statuses = [207, 201, 201, 207];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: String(init?.method || "GET"),
      authorization: headers.get("Authorization"),
    });
    return new Response("", { status: statuses.shift() || 207 });
  }) as typeof fetch;

  try {
    await testBackupWebDavConnection();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => call.method), ["PROPFIND", "MKCOL", "MKCOL", "PROPFIND"]);
  assert.equal(calls[0].url, "https://dav.example.test/root/");
  assert.equal(calls[1].url, "https://dav.example.test/root/nowen-note/");
  assert.equal(calls[2].url, "https://dav.example.test/root/nowen-note/backups/");
  assert.match(calls[0].authorization || "", /^Basic /);

  const config = getBackupWebDavConfig();
  assert.equal(config.status.lastTestOk, true);
  assert.equal(config.status.lastError, null);
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { getDb } from "../src/db/schema";
import { getBackupManager } from "../src/services/backup";
import {
  clearBackupWebDavConfig,
  getBackupWebDavConfig,
  saveBackupWebDavConfig,
  testBackupWebDavConnection,
  parseRemoteBackupList,
  listRemoteBackups,
  importRemoteBackup,
} from "../src/services/backup-webdav";

process.env.BACKUP_WEBDAV_ENCRYPTION_KEY = "backup-webdav-test-key-at-least-32-bytes";

test("remote backup listing accepts namespaced DAV responses and excludes traversal, directories and failed properties", () => {
  const directory = "https://dav.example.test/root/backups/";
  const row = (href: string, status = "HTTP/1.1 200 OK", collection = "") => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection}</d:resourcetype><d:getcontentlength>128</d:getcontentlength><d:getlastmodified>Wed, 07 Oct 2026 09:02:00 GMT</d:getlastmodified></d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
  const xml = `<d:multistatus xmlns:d="DAV:">${[
    row("/root/backups/good%20backup.zip"), row("/root/backups/database.bak"),
    row("/root/backups/good%20backup.zip"), row("https://evil.test/backup.zip"),
    row("/root/elsewhere.zip"), row("/root/backups/sub/backup.zip"),
    row("/root/backups/.partial.zip"), row("/root/backups/failed.zip", "HTTP/1.1 404 Not Found"),
    row("/root/backups/folder.zip", undefined, "<d:collection/>"),
  ].join("")}</d:multistatus>`;
  assert.deepEqual(parseRemoteBackupList(xml, directory).map((item) => [item.filename, item.type, item.size]), [
    ["good backup.zip", "full", 128], ["database.bak", "db-only", 128],
  ]);
});

test("remote backup reads use the configured directory and reject invalid imports before networking", async () => {
  saveBackupWebDavConfig({ enabled: true, endpoint: "https://dav.example.test/root", remotePath: "backups" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://dav.example.test/root/backups/");
    assert.equal(init?.method, "PROPFIND");
    assert.equal(new Headers(init?.headers).get("Depth"), "1");
    return new Response('<multistatus xmlns="DAV:"/>', { status: 207 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await listRemoteBackups(), []);
    await assert.rejects(importRemoteBackup("../escape.zip"), /格式不合法/);
    await assert.rejects(importRemoteBackup("sub\\escape.zip"), /格式不合法/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("remote import caps streamed size and validates the downloaded archive before ingestion", async () => {
  saveBackupWebDavConfig({ enabled: true, endpoint: "https://dav.example.test/root", remotePath: "backups" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("x", { headers: { "Content-Length": String(501 * 1024 * 1024) } })) as typeof fetch;
  try {
    await assert.rejects(importRemoteBackup("large.zip"), /500 MB/);
    globalThis.fetch = (async () => new Response("corrupt archive")) as typeof fetch;
    await assert.rejects(importRemoteBackup("corrupt.zip"));
  } finally { globalThis.fetch = originalFetch; }
});

test("valid remote backup is ingested into the local repository without restoring current data", async () => {
  saveBackupWebDavConfig({ enabled: true, endpoint: "https://dav.example.test/root", remotePath: "backups" });
  const manager = getBackupManager();
  const original = await manager.createBackup({ type: "db-only", description: "remote import fixture" });
  const bytes = fs.readFileSync(manager.getBackupPath(original.filename)!);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), "https://dav.example.test/root/backups/remote.bak");
    assert.equal(init?.redirect, "error");
    return new Response(bytes);
  }) as typeof fetch;
  try {
    const imported = await importRemoteBackup("remote.bak");
    assert.equal(imported.type, "db-only");
    assert.notEqual(imported.filename, original.filename);
    assert.ok(manager.listBackups().some((row) => row.filename === imported.filename));
    assert.ok(manager.getBackupPath(original.filename));
    assert.doesNotThrow(() => getDb().prepare("SELECT count(*) FROM notes").get());
  } finally { globalThis.fetch = originalFetch; }
});

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

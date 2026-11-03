import fs from "fs";
import http from "http";
import path from "path";
import Database from "better-sqlite3";
import { assertSchemaCompatibility, DatabaseUpgradeRequiredError } from "./db/schema-compatibility.js";

const dbPath = process.env.DB_PATH || path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "nowen-note.db");

function check(): void {
  if (!fs.existsSync(dbPath)) return;
  // Load the complete registry before inspecting data. Never import the application.
  const { CURRENT_SCHEMA_VERSION } = require("./db/migrations.js") as typeof import("./db/migrations.js");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assertSchemaCompatibility(db, CURRENT_SCHEMA_VERSION);
  } finally {
    db.close();
  }
}

function serveUpgradePrompt(error: DatabaseUpgradeRequiredError): void {
  const appVersion = process.env.NOWEN_APP_VERSION || "unknown";
  const escapedVersion = appVersion.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>请升级服务端 · Nowen Note</title>
<style>body{margin:0;padding:24px;min-height:90vh;display:grid;place-items:center;background:#f5f7fb;color:#1f2937;font:16px/1.7 system-ui,sans-serif}main{max-width:520px;padding:32px;border:1px solid #e5e7eb;border-radius:16px;background:white}h1{font-size:24px}p{color:#4b5563}</style>
<main><strong>Nowen Note</strong><h1>请升级服务端</h1><p>此数据库曾由更高版本的程序使用，当前程序无法安全打开。请更新服务端镜像或安装包后重试。</p><p>当前程序版本：${escapedVersion}</p><p>请保留并备份原数据目录，不要清空数据或手动修改数据库版本。更新后继续使用原来的数据目录。</p></main></html>`;
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    const route = request.url?.split("?")[0] || "/";
    const readable = request.method === "GET" || request.method === "HEAD";
    if (readable && route === "/api/version") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ appVersion, schemaVersion: error.databaseSchemaVersion, codeSchemaVersion: error.codeSchemaVersion, code: error.code }));
    } else if (route.startsWith("/api/") || !readable) {
      response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ code: error.code, error: "请升级服务端程序后重试，保留原数据目录。" }));
    } else {
      response.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    }
  });
  server.listen(Number(process.env.PORT || 3001), "0.0.0.0", () => {
    console.log(`[startup] Upgrade prompt listening on port ${(server.address() as import("net").AddressInfo).port}`);
  });
}

try {
  check();
} catch (error) {
  if (!(error instanceof DatabaseUpgradeRequiredError)) throw error;
  console.error(`[startup] ${error.message}`);
  if (process.argv.includes("--serve")) serveUpgradePrompt(error);
  else process.exitCode = 78;
}

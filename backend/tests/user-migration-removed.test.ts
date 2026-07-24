import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { closeDb, getDb } from "../src/db/schema";
import { signLoginToken } from "../src/lib/auth-security";

test("一次性数据迁移 API 已移除", async (t) => {
  const userId = "removed-migration-user";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  const token = signLoginToken({ userId, username: userId, tokenVersion: 0 });
  const port = "38429";
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", PORT: port, DISABLE_MDNS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill();
    closeDb();
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  await new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (!output.includes(`http://localhost:${port}`)) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve();
    }, 25);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`等待后端启动超时\n${output}`));
    }, 8_000);
    child.once("exit", (code) => {
      clearInterval(interval);
      clearTimeout(timeout);
      reject(new Error(`后端提前退出 (${code})\n${output}`));
    });
  });

  for (const pathname of ["/api/user-migration/export-light", "/api/user-migration/v2/preflight"]) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 404, `${pathname} 不应继续注册`);
  }
});

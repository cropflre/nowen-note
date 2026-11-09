/**
 * 独立 Android 端进程：真实 native SQLite + 真实 MobileSyncEngine + 真实 /ws。
 * 由 Playwright 以 Electron 内置 Node 启动，通过 stdin/stdout 的 JSON 行通信，
 * 与浏览器里的 Web / PC 端连到同一个真实后端进程。
 *
 * 命令：{"cmd":"wait","noteId","text"} / {"cmd":"edit","noteId","text"} / {"cmd":"stop"}
 * 事件：{"event":"ready"} / {"event":"converged","ms"} / {"event":"pushed"} / {"event":"error","message"}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { NativeLocalRepository } from "../../frontend/src/lib/nativeLocalRepository";
import { MobileSyncEngine } from "../../frontend/src/lib/mobileSyncEngine";
import { NATIVE_TASK_REPEAT_COLUMNS } from "../../frontend/src/lib/nativeTaskFields";
import { NATIVE_TASK_DELETION_STATEMENTS } from "../../frontend/src/lib/nativeTaskRecurrenceDeletion";
import type { NativeDatabase } from "../../frontend/src/lib/nativeDatabase";

const serverUrl = process.argv[2];
const token = process.argv[3];
if (!serverUrl || !token) throw new Error("usage: three-end-android-client <serverUrl> <token>");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-android-client-"));
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";
Object.assign(globalThis, { window: new EventTarget() });

const send = (payload: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(payload)}\n`);

function openClientDb(file: string): NativeDatabase {
  const raw = new Database(file);
  raw.pragma("foreign_keys = ON");
  const source = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/lib/nativeDatabase.ts"), "utf8");
  const scopeCheck = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const entityTypes = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1];
  for (const [, sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    raw.exec(sql.replaceAll("${SCOPE_CHECK}", scopeCheck).replaceAll("${ENTITY_TYPE_CHECK}", entityTypes));
  }
  const taskColumns = new Set((raw.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const [field, type] of Object.entries(NATIVE_TASK_REPEAT_COLUMNS)) {
    if (!taskColumns.has(field)) raw.exec(`ALTER TABLE tasks ADD COLUMN ${field} ${type}`);
  }
  for (const statement of NATIVE_TASK_DELETION_STATEMENTS) raw.exec(statement);
  let queue = Promise.resolve();
  const schedule = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  const tx: NativeDatabase = {
    async run(sql, values = []) { return { changes: raw.prepare(sql).run(...values).changes }; },
    async query<T>(sql: string, values: unknown[] = []) { return raw.prepare(sql).all(...values) as T[]; },
    async transaction(work) { return work(tx); },
    async close() { raw.close(); },
  };
  return {
    run: (sql, values) => schedule(() => tx.run(sql, values)),
    query: <T>(sql: string, values?: unknown[]) => schedule(() => tx.query<T>(sql, values)),
    transaction: (work) => schedule(async () => {
      raw.exec("BEGIN IMMEDIATE");
      try { const result = await work(tx); raw.exec("COMMIT"); return result; }
      catch (error) { raw.exec("ROLLBACK"); throw error; }
    }),
    close: () => schedule(() => tx.close()),
  };
}

async function main() {
  const me = await (await fetch(`${serverUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json() as { id: string };
  const userId = me.id;
  const deviceId = `android-${process.pid}`;
  const profileId = `profile-${deviceId}`;
  const db = openClientDb(path.join(tmpDir, "android.db"));
  await db.run(`INSERT INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt)
    VALUES (?,?,?,?,1,'now','now')`, [profileId, deviceId, serverUrl, userId]);
  await db.run("INSERT INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES (?,?,'android','now')", [profileId, deviceId]);

  const engine = new MobileSyncEngine({
    db, attachments: { remove: async () => undefined } as never, profileId, deviceId, serverUrl, token, userId,
    onApplied: () => undefined,
  });
  const repository = new NativeLocalRepository({ db, attachments: {} as never, accountId: deviceId, userId, getScopeKey: () => "personal" });

  const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as { type: string };
    if (message.type === "sync.changed") engine.requestSync(150);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("android ws connect timeout")), 15000);
    socket.on("message", (raw) => {
      if ((JSON.parse(String(raw)) as { type: string }).type === "connected") { clearTimeout(timer); resolve(); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
  engine.start();
  send({ event: "ready", deviceId, userId });

  const waitFor = async (noteId: string, text: string, timeoutMs = 30000) => {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    for (;;) {
      const row = (await db.query<{ content: string }>("SELECT content FROM notes WHERE id=?", [noteId]))[0];
      if (row && String(row.content || "").includes(text)) { send({ event: "converged", noteId, ms: Date.now() - startedAt }); return; }
      if (Date.now() > deadline) { send({ event: "error", message: `android 未在 ${timeoutMs}ms 内看到 ${text}` }); return; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void (async () => {
      try {
        const command = JSON.parse(line) as { cmd: string; noteId?: string; text?: string };
        if (command.cmd === "wait" && command.noteId && command.text) await waitFor(command.noteId, command.text);
        if (command.cmd === "edit" && command.noteId && command.text) {
          await repository.notes.update(command.noteId, { content: command.text, contentText: command.text });
          engine.requestSync(0);
          send({ event: "pushed", noteId: command.noteId });
        }
        if (command.cmd === "stop") {
          engine.stop(); socket.close(); await db.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
          process.exit(0);
        }
      } catch (error) {
        send({ event: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

main().catch((error) => { send({ event: "error", message: error instanceof Error ? error.stack || error.message : String(error) }); process.exit(1); });

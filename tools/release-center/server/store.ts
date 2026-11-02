import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Audit, Plan, Task } from "../shared.ts";
import { AppError, redact, redactValue } from "./errors.ts";

export class Store {
  db: DatabaseSync;
  constructor(
    path: string,
    private secrets: string[] = [],
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cloud_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cloud_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_cloud_active ON cloud_requests(active) WHERE active=1;
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active ON tasks(active) WHERE active=1;
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT, at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  audit(taskId: string | null, event: string, detail: string) {
    const safe = redact(detail, this.secrets);
    const excerpt =
      safe.length > 100_000
        ? `${safe.slice(0, 50_000)}\n[日志已截断；保留首尾各 50,000 字符，完整日志见 GitHub]\n${safe.slice(-50_000)}`
        : safe;
    this.db
      .prepare("INSERT INTO audit(taskId,at,event,detail) VALUES(?,?,?,?)")
      .run(taskId, new Date().toISOString(), event, excerpt);
  }
  audits(taskId?: string): Audit[] {
    return (taskId
      ? this.db
          .prepare(
            "SELECT * FROM (SELECT * FROM audit WHERE taskId=? ORDER BY seq DESC LIMIT 500) ORDER BY seq",
          )
          .all(taskId)
      : this.db
          .prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT 500")
          .all()) as unknown as Audit[];
  }
  since(seq: number): Audit[] {
    return this.db
      .prepare("SELECT * FROM audit WHERE seq>? ORDER BY seq DESC LIMIT 500")
      .all(seq) as unknown as Audit[];
  }
  savePlan(plan: Plan) {
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO plans VALUES(?,?)")
        .run(plan.id, JSON.stringify(redactValue(plan, this.secrets)));
      this.audit(
        null,
        "plan.created",
        JSON.stringify({ id: plan.id, sha: plan.sha, ready: plan.ready }),
      );
    });
  }
  plan(id: string): Plan {
    const row = this.db.prepare("SELECT data FROM plans WHERE id=?").get(id);
    if (!row) throw new AppError(404, "计划不存在");
    return JSON.parse(String(row.data));
  }
  tasks(active = false): Task[] {
    return this.db
      .prepare(
        `SELECT data FROM tasks ${active ? "WHERE active=1" : ""} ORDER BY rowid DESC LIMIT 100`,
      )
      .all()
      .map((r) => JSON.parse(String(r.data)));
  }
  task(id: string): Task {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    if (!row) throw new AppError(404, "任务不存在");
    return JSON.parse(String(row.data));
  }
  byKey(key: string, fingerprint: string): Task | undefined {
    const row = this.db
      .prepare("SELECT data,fingerprint FROM tasks WHERE key=?")
      .get(key);
    if (!row) return;
    if (row.fingerprint !== fingerprint)
      throw new AppError(409, "幂等键已用于其他请求");
    return JSON.parse(String(row.data));
  }
  create(task: Task, fingerprint: string, beforeInsert?: () => void): Task {
    return this.transaction(() => {
      const existing = this.byKey(task.key, fingerprint);
      if (existing) return existing;
      if (this.tasks(true).length || this.db.prepare("SELECT id FROM cloud_requests WHERE active=1").get())
        throw new AppError(409, "已有活动任务，请等待完成或取消");
      // Keep an optional version reservation in the same SQLite transaction.
      // If the task cannot be created, no version remains accidentally reserved.
      beforeInsert?.();
      this.db
        .prepare("INSERT INTO tasks VALUES(?,?,?,?,?)")
        .run(
          task.id,
          task.key,
          fingerprint,
          1,
          JSON.stringify(redactValue(task, this.secrets)),
        );
      this.audit(task.id, "task.created", `${task.mode} SHA=${task.plan.sha}`);
      return task;
    });
  }
  save(task: Task, event: string, detail: string) {
    task.updatedAt = new Date().toISOString();
    // Redact before persisting, including API errors and logs recovered after restart.
    const data = JSON.stringify(redactValue(task, this.secrets));
    const active = ["queued", "running", "reconciling", "cancelling"].includes(
      task.state,
    )
      ? 1
      : 0;
    this.transaction(() => {
      this.db
        .prepare("UPDATE tasks SET active=?,data=? WHERE id=?")
        .run(active, data, task.id);
      this.audit(task.id, event, detail);
    });
  }
  close() {
    this.db.close();
  }
}

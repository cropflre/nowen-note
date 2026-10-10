import type Database from "better-sqlite3";

/**
 * Change Feed 抑制开关（服务端侧）。
 *
 * 触发器运行在 SQLite 内部，读不到 Node 进程里的 AsyncLocalStorage，
 * 所以需要一张数据库内的开关表。apply 远端变更时置 1，触发器跳过记录，
 * 结束后复位。
 *
 * 安全要点：
 * - 置位与业务写入必须在同一事务内，否则并发请求会看到被抑制的窗口，
 *   导致别人的正常写入丢失 feed 记录；
 * - 无论成功失败都要复位，因此统一由 runSuppressed 包裹，
 *   不暴露裸的 set 接口给业务代码；
 * - 计数式嵌套：内层结束不能提前复位外层。
 */

let depth = 0;

function setSuppressed(db: Database.Database, value: boolean): void {
  db.prepare("UPDATE sync_v2_suppression SET suppressed = ? WHERE id = 1")
    .run(value ? 1 : 0);
}

export function isChangeFeedSuppressed(db: Database.Database): boolean {
  const row = db.prepare("SELECT suppressed FROM sync_v2_suppression WHERE id = 1")
    .get() as { suppressed: number } | undefined;
  return Number(row?.suppressed || 0) === 1;
}

/**
 * 在抑制状态下执行远端变更应用。
 *
 * 调用方必须已经处于事务中（或由本函数的调用链保证），
 * 这样抑制窗口不会泄漏到其他并发写入。
 */
export function runChangeFeedSuppressed<T>(
  db: Database.Database,
  fn: () => T,
): T {
  depth += 1;
  if (depth === 1) setSuppressed(db, true);
  try {
    return fn();
  } finally {
    depth -= 1;
    if (depth === 0) {
      // 即使 fn 抛出也必须复位，否则后续所有写入都不再进入 feed，
      // 等价于同步永久静默失效。
      try {
        setSuppressed(db, false);
      } catch {
        // 复位失败时降级为强制写入，避免开关卡在 1。
        try { db.exec("UPDATE sync_v2_suppression SET suppressed = 0 WHERE id = 1"); } catch { /* ignore */ }
      }
    }
  }
}

/**
 * 进程启动时强制复位。
 *
 * 上一次运行若在抑制窗口内被强杀，开关会留在 1，
 * 导致此后所有写入都不进 feed。启动复位是唯一可靠的兜底。
 */
export function resetChangeFeedSuppression(db: Database.Database): void {
  depth = 0;
  try {
    setSuppressed(db, false);
  } catch {
    // 表还没建立（迁移未跑完）时忽略，迁移完成后下次启动会复位。
  }
}

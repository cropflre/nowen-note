/**
 * 带乐观锁 + 409 reconcile 的 PUT 封装。
 *
 * 背景：
 *   项目里有多个地方需要"带 version 发 PUT，冲突时拿最新 version 再发一次"：
 *     - EditorPane.handleUpdate：日常 debounce 自动保存
 *     - EditorPane.toggleEditorMode：切换 RTE→MD 时的规范化 PUT
 *     - 将来可能的导入 / 手动同步流程
 *
 *   各自粘贴同一段 reconcile 代码，导致：
 *     1) 行为微妙不一致（有的加了"切笔记时放弃"，有的没加）
 *     2) 409 的错误形状（`err.currentVersion` vs 从 body 读 `body.currentVersion`）
 *        到处重复判断
 *     3) 修复 bug 时容易漏改某一份
 *
 *   本模块收敛这段逻辑：调用方只需要提供"怎么发 PUT"和"如何拿到最新 version"。
 *
 * 关键不变量：
 *   - 首发带 initialVersion；409 时用 err.currentVersion（或 fetchLatestVersion 兜底）
 *     重放一次，**不**无限循环重试（避免"409 风暴"）。
 *   - onAbort 返回 true 时直接取消（例如切笔记了，不该把旧内容写入新笔记）。
 *   - 非 409 错误原样抛出，由调用方处理（通常置 syncStatus=error）。
 */

import { api } from "@/lib/api";

export interface PutWithReconcileOptions<T> {
  /** 首发 version */
  initialVersion: number;
  /** 实际发送 PUT 的函数；必须带上指定 version */
  send: (version: number) => Promise<T>;
  /**
   * 当错误里拿不到 currentVersion 时的兜底取 latestVersion 方法。
   * 典型实现：`() => api.getNote(id).then(n => n.version)`
   */
  fetchLatestVersion?: () => Promise<number | undefined>;
  /**
   * 在重放前调用；返回 true 表示"放弃这次保存"（比如切笔记了）。
   * 返回 false / undefined 则继续 reconcile。
   */
  onAbort?: () => boolean;
}

/** 判断是否为 409 冲突错误 */
export function is409Error(err: any): boolean {
  if (!err) return false;
  if (err.status === 409) return true;
  const msg = String(err.message || "");
  return /409|conflict/i.test(msg);
}

/**
 * 执行一次带 reconcile 的 PUT。
 *
 * 行为：
 *   1. send(initialVersion)
 *   2. 非 409 失败 → 直接抛
 *   3. 409：
 *      a. onAbort() 返回 true → 抛 AbortError
 *      b. 从 err.currentVersion 取 latest；没有则调 fetchLatestVersion()
 *      c. 都没有 → 抛原错误（调用方按失败处理）
 *      d. send(latest) 最终一次；不再 reconcile
 */
export async function putWithReconcile<T>(
  opts: PutWithReconcileOptions<T>,
): Promise<T> {
  const { initialVersion, send, fetchLatestVersion, onAbort } = opts;
  try {
    return await send(initialVersion);
  } catch (err: any) {
    if (!is409Error(err)) throw err;

    if (onAbort?.()) {
      // 抛一个可识别的 Abort 错误；调用方自己决定如何处理（通常静默丢弃）
      const aborted = new Error("putWithReconcile aborted");
      (aborted as any).aborted = true;
      throw aborted;
    }

    let latestVersion: number | undefined = err?.currentVersion;
    if (typeof latestVersion !== "number" && fetchLatestVersion) {
      try {
        latestVersion = await fetchLatestVersion();
      } catch {
        /* 吞掉：下面会抛原错误 */
      }
    }
    if (typeof latestVersion !== "number") throw err;

    if (onAbort?.()) {
      const aborted = new Error("putWithReconcile aborted");
      (aborted as any).aborted = true;
      throw aborted;
    }

    return await send(latestVersion);
  }
}

/** 判断错误是否为 putWithReconcile 抛出的"主动放弃" */
export function isAborted(err: any): boolean {
  return !!(err && err.aborted === true);
}

/**
 * 便捷助手：为笔记 id 生成"GET 最新 version"的函数。
 * 传给 putWithReconcile.fetchLatestVersion 使用。
 */
export function makeFetchLatestNoteVersion(noteId: string) {
  return async (): Promise<number | undefined> => {
    try {
      const latest = await api.getNote(noteId);
      return latest?.version;
    } catch {
      return undefined;
    }
  };
}

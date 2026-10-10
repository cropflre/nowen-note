import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Outbox 抑制上下文：Sync V2 的防回环原语。
 *
 * 没有它就会形成死循环：
 *   Server → Pull → 写 Local SQLite → 变更捕获 → 进入 Outbox → 再 Push → …
 *
 * 因此"应用远端变更"必须能声明自己不是用户本地修改。约定：
 * - 只有 apply remote changes 路径可以进入抑制上下文；
 * - 用户经 UI / REST 产生的写入永远不得被抑制，否则修改将永久不上传；
 * - 抑制范围必须尽可能小，只包裹真正写入远端数据的那段事务。
 *
 * 采用 AsyncLocalStorage 而非模块级布尔量的原因：
 * - 异常时自动恢复，不存在 try/finally 漏写导致状态永久卡住；
 * - 并发的异步任务互不污染（模块级计数器在 await 交错时会误伤其他写入）；
 * - 嵌套调用天然安全。
 */
const outboxSuppression = new AsyncLocalStorage<true>();

/** 当前是否处于"应用远端变更"上下文。变更捕获层据此跳过 Outbox 记录。 */
export function isOutboxSuppressed(): boolean {
  return outboxSuppression.getStore() === true;
}

/**
 * 在抑制上下文内执行远端变更应用。
 *
 * 同步与异步回调都支持；回调抛出时上下文同样自动解除。
 */
export function runWithOutboxSuppressed<T>(fn: () => T): T {
  return outboxSuppression.run(true, fn);
}

/**
 * 断言当前不处于抑制上下文。
 *
 * 供未来的用户写入路径做防御性检查：如果用户修改在抑制上下文里被提交，
 * 它将永远不会进入 Outbox，等价于静默丢失用户数据，必须尽早暴露。
 */
export function assertNotOutboxSuppressed(operation: string): void {
  if (isOutboxSuppressed()) {
    throw new Error(
      `[sync-v2] ${operation} 不能在 outbox 抑制上下文中执行，否则本地修改将永远不会同步`,
    );
  }
}

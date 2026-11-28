import type Database from "better-sqlite3";
import type { NoteVersionRebase } from "./push";

/**
 * 同步引擎改动本机笔记后，让本机正在打开它的编辑器跟上。
 *
 * 桌面端编辑器连的是内嵌后端：编辑器手里握着笔记版本号做乐观锁，Markdown 还有本机
 * Yjs 房间按版本号落盘。同步引擎在后台改了笔记（拉到其他设备的修改、推送确认改写版本号）
 * 却不告诉它们，结果是编辑器继续显示旧内容、下一次保存被判 409 只存进草稿，或者
 * Yjs 落盘因版本号对不上被静默拒绝——这些修改从此到不了其他设备。
 *
 * Sync 层不直接依赖 realtime / yjs（会形成循环依赖，单测也不需要 WebSocket），
 * 由 index.ts 启动时注入实现；未注入时全部是空操作。
 */
export interface LocalNoteHooks {
  /** 拉取覆盖本机笔记前，把本机 Yjs 房间里尚未落盘的输入写回 notes（与 REST 整篇保存前的 yFlush 相同）。 */
  flushNote(noteId: string): void;
  /** 远端修改已落到本机库：刷新本机 Yjs 房间，并通知打开这篇笔记的编辑器和侧栏列表。 */
  announceAppliedNotes(userId: string, changes: Array<{ noteId: string; operation: "upsert" | "delete" }>): void;
  /** 推送确认改写了本机版本号（正文不变）：让 Yjs 房间与编辑器改用新版本号。 */
  announceVersionRebase(rebase: NoteVersionRebase): void;
}

let hooks: LocalNoteHooks | null = null;

export function setLocalNoteHooks(next: LocalNoteHooks | null): void {
  hooks = next;
}

export function flushLocalNote(noteId: string): void {
  try { hooks?.flushNote(noteId); } catch { /* 落盘失败时由 Yjs 自身重试；拉取仍按 Outbox 判断冲突 */ }
}

export function announceAppliedLocalNotes(
  userId: string,
  changes: Array<{ noteId: string; operation: "upsert" | "delete" }>,
): void {
  if (!changes.length) return;
  try { hooks?.announceAppliedNotes(userId, changes); } catch { /* 通知失败不影响已提交的数据 */ }
}

/**
 * 推送确认改写的版本号：noteId → 改号前后的版本。
 *
 * 只在本进程内有效。编辑器在收到改号通知前发出的保存仍带着旧版本号，
 * 只要笔记此后没有再被改过（当前版本仍是改号后的版本），这个旧版本号与当前版本
 * 指的是同一份正文，可以放行；笔记一旦再被写入，当前版本变化，旧版本号重新视为过期。
 * 记录绑定到当时的数据库连接，备份恢复换库后自动失效。
 */
const rebases = new Map<string, NoteVersionRebase & { db: Database.Database }>();
const MAX_REBASES = 2000;

export function recordNoteVersionRebase(db: Database.Database, rebase: NoteVersionRebase): void {
  rebases.delete(rebase.noteId);
  rebases.set(rebase.noteId, { ...rebase, db });
  while (rebases.size > MAX_REBASES) rebases.delete(rebases.keys().next().value as string);
  try { hooks?.announceVersionRebase(rebase); } catch { /* 编辑器下一次保存仍可凭改号记录放行 */ }
}

/** 编辑器提交的版本号是否正是推送确认改号前的版本，且笔记之后未再变化。 */
export function isRebasedNoteVersion(
  db: Database.Database,
  noteId: string,
  clientVersion: unknown,
  currentVersion: number,
): boolean {
  const rebase = rebases.get(noteId);
  return !!rebase && rebase.db === db
    && rebase.fromVersion === clientVersion
    && rebase.toVersion === currentVersion;
}

export function resetNoteVersionRebasesForTests(): void {
  rebases.clear();
}

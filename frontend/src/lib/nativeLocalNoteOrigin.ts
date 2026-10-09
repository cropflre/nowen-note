import type { NativeDatabase } from "./nativeDatabase";

/** 仅由本机创建事务写入，首次发送或收到远端笔记后撤销；不从 ID/版本/队列推断。 */
export function unsentLocalNoteKey(scopeKey: string, noteId: string): string {
  return `unsentLocalNote:${JSON.stringify([scopeKey, noteId])}`;
}

export async function forgetUnsentLocalNotes(db: NativeDatabase, scopeKey: string, noteIds: string[]): Promise<void> {
  // 在事务中按批次清理，避免每个远端条目都跨一次 Native bridge，也不超过 SQLite 变量上限。
  for (let offset = 0; offset < noteIds.length; offset += 400) {
    const keys = noteIds.slice(offset, offset + 400).map((id) => unsentLocalNoteKey(scopeKey, id));
    await db.run(`DELETE FROM native_runtime_meta WHERE key IN (${keys.map(() => "?").join(",")})`, keys);
  }
}

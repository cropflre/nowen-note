# 笔记删除 API 安全迁移 / Note deletion API migration

普通删除使用已有 `PUT /api/notes/:id`，body `{ "isTrashed": 1 }`。恢复用 `{ "isTrashed": 0 }` 或统一回收站恢复 API。正文、历史、附件在软删期间保留。

Permanent deletion uses `DELETE /api/notes/:id/permanent` and requires an already trashed, unlocked note plus management permission. The legacy `DELETE /api/notes/:id` retains permanent semantics and enforces the same rule. An active note returns HTTP 409 with `NOTE_NOT_TRASHED` before any attachment, history, tree or deletion-queue change.

SDK 推荐：

```ts
await client.trashNote(id);                 // 普通删除，可恢复
await client.restoreNote(id);               // 恢复
// 只有用户明确要求永久删除已经在回收站的笔记时：
await client.permanentlyDeleteNote(id);
```

SDK `deleteNote()` remains a deprecated alias for explicit permanent deletion; it does not silently trash first. Existing SDK/API callers that permanently delete active notes must migrate their workflow and handle `NOTE_NOT_TRASHED`.

MCP 默认 `permanent=false`，CLI 默认不加 `--permanent`，继续软删。选择永久删除时先在回收站确认目标；不自动重试为“软删再永久删除”。锁定、restricted/deny、共享 editor 和跨账号仍受原权限约束。

MCP `permanent=true` and CLI `--permanent` now use the explicit permanent endpoint and require a trashed target. Android failed-import cleanup explicitly trashes its newly created empty placeholder before requesting permanent cleanup. If cleanup fails, the recoverable resource remains; no general active-note exemption is added.

回滚旧代码会恢复旧删除语义，不会恢复已经永久删除的数据。上线前应保存完整备份并验证恢复；同源回收站 UI、SDK/MCP、同步墓碑和附件引用回归需一起完成。

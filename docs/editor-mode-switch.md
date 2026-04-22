# 编辑器模式切换协议（MD ↔ Tiptap）

> 本文档描述 `EditorPane` 的 `toggleEditorMode` 在 MD（Markdown / CodeMirror + CRDT）和
> RTE（富文本 / Tiptap）之间切换时的完整数据流协议。
>
> 如果你要修改切换相关逻辑，**先读这里**，否则很容易踩坑破坏数据一致性。

## 为什么切换是个难题

两个编辑器看似只是 UI 不同，实际持久化模型完全不同：

| 维度           | MD 模式                                    | RTE 模式                                  |
| -------------- | ------------------------------------------ | ----------------------------------------- |
| 权威内容       | y room 里的 `yText("content")`（CRDT）     | `notes.content`（REST PUT 写入）          |
| 持久化路径     | yjs update 流 → `note_yupdates` / snapshot | REST `PUT /notes/:id` → `notes.content`   |
| 本地 debounce  | 仅 meta（title）                           | content + meta 整体 PUT                   |
| 数据格式       | markdown 纯文本                            | Tiptap ProseMirror JSON 字符串            |

因此切换不是"换一个组件"，而是一次**跨持久化模型的数据迁移**。

## 四条核心不变量

1. **切换点必须是同步原子**：新编辑器 mount 时读到的 `activeNote.content` 必须已经是
   目标格式（MD ↔ JSON），否则会短暂闪烁旧内容甚至丢字。
2. **没有并发 PUT**：切换期间，旧编辑器的 debounce PUT 与切换本身的规范化 PUT
   必须**串行**，否则 409 reconcile 可能回放旧内容覆盖规范化结果。
3. **yDoc 与 notes.content 对齐**：MD→RTE 前，RTE 期间的任何 PUT 不经过 yDoc；
   下次切回 MD 时 yDoc 不清空就会拿到陈旧内容。
4. **任何失败都必须回滚**：规范化 PUT 失败时，本地 `activeNote` 已被更新但 `editorMode`
   还没切，两侧不一致会导致视觉错乱；必须回滚。

## 切换步骤（toggleEditorMode）

```
入口守卫
  ├─ modeSwitchInflightRef 防重入
  ├─ 若 collabReady && !collabSynced → 拒绝并 toast
  └─ 记录 preSwitchNote 快照（失败回滚用）

同步等待
  └─ await saveInflightRef.current    # 等 handleUpdate 在途 PUT 完成（不变量 2）

取本地快照
  └─ editorHandleRef.current.getSnapshot()

flush 策略
  ├─ MD→RTE: flushSave()     # MD 的 meta PUT 无副作用，可安全发
  └─ RTE→MD: discardPending() # Tiptap JSON PUT 会与规范化 PUT 竞态，必须丢弃

MD→RTE 专属：CRDT 漂移兜底
  └─ yDoc.getText("content") → 回填 activeNote.content
     # （没这步，用户最近几百毫秒的 MD 输入会丢）

RTE→MD 专属：规范化 PUT（不变量 1 + 3）
  ├─ normalizeToMarkdown(snapshot.content) → markdown
  ├─ 本地先 setActiveNote（新编辑器 mount 就能读到）
  └─ api.updateNote({
       content: markdown,
       version,
       syncToYjs: true,              # 让服务端把 yText 也对齐
     }) 带 409 reconcile
  ├─ 成功：回填 version/updatedAt
  └─ 失败：回滚 preSwitchNote + toast.error + return（不变量 4）

副作用提交
  ├─ persistEditorMode(next)
  ├─ clearForcedModeFromUrl()
  └─ setEditorMode(next)

MD→RTE 专属后续（不变量 3）
  └─ api.releaseYjsRoom(noteId)       # 销毁服务端 yDoc + 清 yjs 历史表
```

## 后端支持点

| 路由                              | 用途                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| `PUT /notes/:id` `syncToYjs=true` | RTE→MD 切换时，把 body.content 作为 markdown 同步写入 yText，产生 y update |
| `POST /notes/:id/yjs/release-room`| MD→RTE 切换成功后，销毁内存 Y.Doc 并清空 note_yupdates / note_ysnapshots |

实现分别在：
- `backend/src/services/yjs.ts` 的 `yReplaceContentAsUpdate` / `yDestroyDoc`
- `backend/src/routes/notes.ts` 的 `syncToYjs` 分支 / `POST /:id/yjs/release-room`

## 相关模块

- `frontend/src/components/EditorPane.tsx` —— 切换协调者
- `frontend/src/lib/editorMode.ts` —— URL / localStorage 解析
- `frontend/src/lib/optimisticLockApi.ts` —— `putWithReconcile` 共用 409 协议
- `frontend/src/lib/contentFormat.ts` —— 双向格式转换
- `frontend/src/components/editors/types.ts` —— `NoteEditorHandle` 契约

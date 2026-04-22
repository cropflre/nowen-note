/**
 * 笔记编辑器统一契约（Tiptap / Markdown 两个引擎共用）
 * ----------------------------------------------------
 * 任何新编辑器引擎都应实现 `NoteEditorProps` 和可选的 `NoteEditorHandle`，
 * 保证 `EditorPane` 可以通过 `resolveEditorMode()` 无差别切换。
 *
 * 为何要集中定义：
 *   - 历史上两个编辑器的 props 形状靠"人工约定"保持一致，
 *     一旦一边改动忘了同步，就会出现类型正常但运行行为分裂的问题。
 *   - 通过显式共享类型，TS 编译期即可发现不对齐。
 */

import type { Note, Tag } from "@/types";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

/** 标题项（大纲/跳转用） */
export interface NoteEditorHeading {
  id: string;
  level: number;
  text: string;
  /**
   * Tiptap：ProseMirror 位置
   * Markdown：文档字符偏移
   * 调用方只需把它透传回编辑器的 `scrollTo`。
   */
  pos: number;
}

/** 编辑器更新回调载荷 */
export interface NoteEditorUpdatePayload {
  /** Phase 3 起：CRDT 模式下 content 由服务端 Y.Doc 持久化，前端不再传此字段 */
  content?: string;
  contentText?: string;
  title: string;
}

/** 两个编辑器引擎统一的 props 契约 */
export interface NoteEditorProps {
  note: Note;
  onUpdate: (data: NoteEditorUpdatePayload) => void;
  onTagsChange?: (tags: Tag[]) => void;
  onHeadingsChange?: (headings: NoteEditorHeading[]) => void;
  onEditorReady?: (scrollTo: (pos: number) => void) => void;
  editable?: boolean;
  /** 访客模式（分享页）：禁用依赖登录态的能力（TagInput、AI 助手等） */
  isGuest?: boolean;
  /**
   * Phase 3（可选）：CRDT 协同
   * 当同时提供 yDoc + awareness 时，编辑器应：
   *   - 把自身 doc 绑定到 yDoc.getText("content")（content 部分不再靠 note.content 驱动）
   *   - 不再对 content 做本地 debounce 保存（仅 meta 字段通过 onUpdate 通知）
   * MarkdownEditor 已实现；TiptapEditor 未实现时应忽略这两项（回退到 Phase 2 行为）。
   */
  yDoc?: Y.Doc | null;
  awareness?: Awareness | null;
}

/**
 * 通过 `useImperativeHandle` 暴露给父组件的命令式 API。
 *
 * - flushSave：切换编辑器 / 切换笔记 / 窗口关闭前把 debounce 中的 pending
 *   更新立即落盘。
 * - getSnapshot：**同步**读取编辑器实例当前最新内容，用于"切换编辑器"
 *   这种临界动作——flushSave 只是触发异步 PUT，activeNote.content 要等
 *   网络回包后才更新；而切换 MD↔RTE 是同步行为，新编辑器 mount 时拿到的
 *   还是旧 note.content。getSnapshot 让调用方可以在切换瞬间直接把新内容
 *   回填到 activeNote，新编辑器 mount 就能看到正确数据，不会闪一下旧内容、
 *   也不会因为 mount 时的 effect 误把旧内容当作"权威来源"反向覆盖用户输入。
 */
export interface NoteEditorHandle {
  /** 立即触发一次 onUpdate（跳过 debounce）。无 pending 更新时为 no-op。 */
  flushSave: () => void;
  /**
   * 丢弃 pending 的 debounce 更新（清 timer，不派发 onUpdate）。
   * 用于"切换编辑器"这类场景：调用方已经自己以规范化后的内容发起 PUT，
   * 不希望编辑器内部的 debounce 再额外派发一次可能带旧格式（如 Tiptap JSON）
   * 的 PUT 覆盖前一次。
   * 未实现或无 pending 时为 no-op。
   */
  discardPending?: () => void;
  /**
   * 同步取编辑器当前最新内容。
   * 未就绪（编辑器尚未 mount）时返回 null。
   * CRDT 模式下 content 由 yDoc 接管，返回的 content 仅供临时回填，不代表服务端权威。
   */
  getSnapshot?: () => { content: string; contentText: string } | null;
  /**
   * 编辑器是否已 mount 并可被命令式 API 安全调用。
   *
   * 背景：切换 MD↔RTE 的瞬间，旧编辑器组件会被卸载、新编辑器尚未 mount，
   * 调用方若在这段窗口误触 flushSave / getSnapshot，会读到 null 且无法区分
   * "编辑器真没内容"还是"编辑器还没装好"。isReady() 让调用方显式判断。
   *
   * 可选：不实现的旧适配返回 undefined，调用方应视为"假定就绪"。
   */
  isReady?: () => boolean;
}

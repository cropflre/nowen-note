/**
 * 笔记编辑（P2）
 *
 * ⚠️ 为什么用原生 <textarea> 而不是 CodeMirror / Tiptap：
 *   1. **中文输入法**：CodeMirror 自管输入事件，Android/iOS 上 IME 组合态容易被
 *      打断（打一半字跳掉、候选框错位）。textarea 走浏览器原生输入栈，中文最稳。
 *   2. 体积：textarea 是 0 依赖；CodeMirror 6 基础包就上百 KB。
 *   3. 手机上本来就是「大段打字」为主，语法高亮的收益远不如输入稳定性重要。
 *   代价：没有语法高亮。用「Markdown 工具栏 + 一键预览」来补。
 *
 * ⚠️ 并发保护（这是本节最重要的事）：
 *   服务端对内容类变更强制要求 version，不一致会返回
 *   409 { code: "VERSION_CONFLICT", currentVersion }。
 *   拿到冲突**绝不静默覆盖**，而是让用户二选一：
 *     · 载入最新（放弃我的修改）
 *     · 用我的版本覆盖（先取最新 version 再提交，保证是在"知道对方改了什么"的前提下覆盖）
 *
 * 可编辑格式：markdown / html（源码编辑）；tiptap-json 只读。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, ApiError } from "../api/rest";
import { fetchAttachmentAccessUrls } from "../api/client";
import { getClient } from "../api/client";
import { NoteBody } from "../lib/noteBody";
import { noteHref } from "../lib/router";
import { Dialog } from "../shell/Dialog";
import { TopBar } from "../App";
import type { Note } from "../../sdk/types";
import { logConflict, resolveConflict } from "../lib/conflictLog";

interface Draft {
  title: string;
  content: string;
  baseVersion: number;
  savedAt: string;
}

function draftKey(noteId: string): string {
  return `nowen-lite.draft.${noteId}`;
}

function readDraft(noteId: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(noteId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Draft;
    return typeof parsed?.content === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const FORMAT_LABEL: Record<string, string> = {
  markdown: "Markdown",
  html: "HTML 源码",
  "tiptap-json": "富文本（只读）",
};

export function NoteEditScreen({ noteId, title }: { noteId: string; title: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [content, setContent] = useState("");
  const [version, setVersion] = useState(0);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  const [conflict, setConflict] = useState<{ currentVersion: number } | null>(null);
  /** 本次冲突在台账里的 id（解决后要标记掉） */
  const [conflictId, setConflictId] = useState<string | null>(null);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const editable = note ? note.contentFormat !== "tiptap-json" : false;
  const isMarkdown = note?.contentFormat === "markdown";

  const load = useCallback(
    async (opts: { keepDraft?: boolean } = {}) => {
      const loaded = (await getClient().getNote(noteId)) as Note;
      setNote(loaded);
      setVersion(loaded.version);
      if (!opts.keepDraft) {
        setDraftTitle(loaded.title || "");
        setContent(loaded.content || "");
        setDirty(false);
      }
      setError(null);
    },
    [noteId],
  );

  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setError(null);
    setDirty(false);
    setMode("edit");
    void (async () => {
      try {
        // 并行取正文与附件签名 URL —— 预览里的图片必须用签名地址，
        // 否则会拿 /api/attachments/<id> 直接请求（<img> 带不了 Authorization）→ 401
        const [loaded, urls] = await Promise.all([
          getClient().getNote(noteId) as Promise<Note>,
          fetchAttachmentAccessUrls(noteId),
        ]);
        if (cancelled) return;
        setAttachmentUrls(urls);
        setNote(loaded);
        setVersion(loaded.version);
        setDraftTitle(loaded.title || "");
        setContent(loaded.content || "");
        // 有草稿就问用户要不要接着写（不静默覆盖，也不静默丢弃）
        const d = readDraft(noteId);
        if (d && d.content !== (loaded.content || "")) setPendingDraft(d);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // ---- 未保存的改动：落成本地草稿 ----
  //
  // ⚠️ 曾经想「拦截导航」（hashchange 时把 hash 拉回来 + 弹窗），实测不可行：
  //    切换 tab 会让本组件**卸载重挂**，状态直接丢失，对话框根本弹不出来。
  //    改用草稿落盘 —— 对手机其实更合适：
  //    接电话、切 App、被系统杀后台都不会丢，回来还能接着写。
  useEffect(() => {
    if (!dirty || !note) return;
    const timer = setTimeout(() => {
      try {
        const draft: Draft = {
          title: draftTitle,
          content,
          baseVersion: version,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem(draftKey(noteId), JSON.stringify(draft));
        setDraftSavedAt(draft.savedAt);
      } catch {
        /* 隐私模式或配额满，忽略 */
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [dirty, note, noteId, draftTitle, content, version]);

  // 整页关闭/刷新时也提醒一下
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  async function submit(useVersion: number) {
    if (!note) return;
    setSaving(true);
    setError(null);
    try {
      // contentText 不提交：服务端会从 content 派生，并明确忽略客户端值
      await apiFetch(`/api/notes/${encodeURIComponent(noteId)}`, {
        method: "PUT",
        body: {
          title: draftTitle.trim() || "无标题",
          content,
          contentFormat: note.contentFormat,
          version: useVersion,
        },
      });
      try {
        localStorage.removeItem(draftKey(noteId));
      } catch {
        /* ignore */
      }
      setDirty(false);
      setConflict(null);
      // 用户选择了「覆盖」并保存成功 → 这次冲突已解决
      if (conflictId) {
        resolveConflict(conflictId, "overwrite");
        setConflictId(null);
      }
      window.location.hash = noteHref(noteId, draftTitle.trim() || "无标题");
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        const cv = Number((err.body as { currentVersion?: number } | undefined)?.currentVersion);
        const serverVersion = Number.isFinite(cv) ? cv : 0;
        setConflict({ currentVersion: serverVersion });
        // 落到本机台账：这样「同步诊断 → 未解决冲突」是个真实数字，
        // 而不是弹一次对话框、点掉就再也想不起来哪几篇没处理
        setConflictId(
          logConflict({
            noteId,
            noteTitle: draftTitle || note?.title || "",
            localVersion: useVersion,
            serverVersion,
          }),
        );
      } else if (err instanceof ApiError && err.code === "NOTE_LOCKED") {
        setError("这篇笔记已被锁定，无法编辑。");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  /** 工具栏：在光标处包裹/插入 Markdown 标记 */
  function surround(before: string, after = before, placeholder = "文本") {
    const el = areaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const next = content.slice(0, start) + before + selected + after + content.slice(end);
    setContent(next);
    setDirty(true);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }

  /** 行首插入（标题、列表、引用） */
  function prefixLine(marker: string) {
    const el = areaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const lineStart = content.lastIndexOf("\n", start - 1) + 1;
    const next = content.slice(0, lineStart) + marker + content.slice(lineStart);
    setContent(next);
    setDirty(true);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + marker.length;
      el.setSelectionRange(pos, pos);
    });
  }

  if (error && !note) {
    return (
      <>
        <TopBar title="编辑" showBack />
        <div className="app-content">
          <div className="notice">{error}</div>
        </div>
      </>
    );
  }

  if (!note) {
    return (
      <>
        <TopBar title="编辑" showBack />
        <div className="app-content">
          <div className="loading">加载中…</div>
        </div>
      </>
    );
  }

  if (!editable) {
    return (
      <>
        <TopBar title={note.title || title || "笔记"} showBack />
        <div className="app-content app-content--padded">
          <div className="notice notice-info" style={{ margin: "12px 0" }}>
            这篇是<b>富文本（tiptap-json）</b>格式，Lite 暂不支持编辑。
            <br />
            服务端没有格式转换接口，手机端也不适合做富文本所见即所得。
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="editor-shell">
      <TopBar
        title={note.title || title || "编辑"}
        showBack
        onBack={() => {
          if (dirty) setLeaveAsk(true);
          else window.location.hash = noteHref(noteId, note.title || "无标题");
        }}
        right={
          <>
            {isMarkdown ? (
              <button
                className="topbar-btn"
                style={{ fontSize: 15 }}
                onClick={() => setMode((m) => (m === "edit" ? "preview" : "edit"))}
                aria-label={mode === "edit" ? "预览" : "继续编辑"}
              >
                {mode === "edit" ? "预览" : "编辑"}
              </button>
            ) : null}
            <button
              className="topbar-btn"
              style={{
                fontSize: 15,
                fontWeight: 650,
                color: dirty && !saving ? "var(--accent)" : "var(--text-3)",
              }}
              disabled={!dirty || saving}
              onClick={() => void submit(version)}
              aria-label="保存"
            >
              {saving ? "保存中" : "保存"}
            </button>
          </>
        }
      />

      <div className="editor-bar">
        <span className="chip">{FORMAT_LABEL[note.contentFormat] ?? note.contentFormat}</span>
        {dirty ? (
          <span className="chip chip-medium">
            {draftSavedAt ? "草稿已存" : "未保存"}
          </span>
        ) : null}
        {version !== note.version ? (
          <span className="chip chip-done">v{version}</span>
        ) : null}
      </div>

      {error ? <div className="notice">{error}</div> : null}

      <input
        className="editor-title"
        value={draftTitle}
        placeholder="标题"
        onChange={(e) => {
          setDraftTitle(e.target.value);
          setDirty(true);
        }}
      />

      {isMarkdown && mode === "edit" ? (
        <div className="editor-toolbar">
          {[
            { label: "H2", run: () => prefixLine("## ") },
            { label: "B", run: () => surround("**") },
            { label: "I", run: () => surround("*") },
            { label: "•", run: () => prefixLine("- ") },
            { label: "❝", run: () => prefixLine("> ") },
            { label: "`", run: () => surround("`", "`", "code") },
            { label: "🔗", run: () => surround("[", "](https://)", "链接文字") },
          ].map((b) => (
            <button key={b.label} type="button" className="tool-btn" onClick={b.run}>
              {b.label}
            </button>
          ))}
        </div>
      ) : null}

      {isMarkdown && mode === "preview" ? (
        <div className="editor-preview">
          <NoteBody format="markdown" content={content} attachmentUrls={attachmentUrls} />
        </div>
      ) : (
        <textarea
          ref={areaRef}
          className="editor-area"
          value={content}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={
            note.contentFormat === "markdown" ? "开始写…（Markdown）" : "开始写…（HTML 源码）"
          }
          onChange={(e) => {
            setContent(e.target.value);
            setDirty(true);
          }}
        />
      )}

      {note.contentFormat === "html" ? (
        <div className="editor-hint">
          这是 HTML 源码编辑。改错了不要紧：服务端保留了历史版本（note_versions）。
        </div>
      ) : null}

      {/* ---- 版本冲突 ---- */}
      <Dialog
        open={conflict !== null}
        title="这篇笔记在别处被修改过"
        message={
          <>
            服务端当前版本是 <b>v{conflict?.currentVersion}</b>，你手上这份基于{" "}
            <b>v{version}</b>。
            <br />
            为避免覆盖别人的改动，请选择怎么处理。
          </>
        }
        actions={[
          {
            label: "载入最新（放弃我的修改）",
            primary: true,
            onSelect: () => {
              setConflict(null);
              if (conflictId) { resolveConflict(conflictId, "reload"); setConflictId(null); };
              void load();
            },
          },
          {
            label: "用我的版本覆盖",
            danger: true,
            onSelect: () => {
              const target = conflict?.currentVersion ?? version;
              setConflict(null);
              if (conflictId) { resolveConflict(conflictId, "reload"); setConflictId(null); };
              setVersion(target);
              void submit(target);
            },
          },
          { label: "继续编辑", onSelect: () => setConflict(null) },
        ]}
        onDismiss={() => setConflict(null)}
      />

      {/* ---- 发现本地草稿 ---- */}
      <Dialog
        open={pendingDraft !== null}
        title="发现未保存的草稿"
        message={
          <>
            这篇笔记有一份草稿（保存于 {pendingDraft ? new Date(pendingDraft.savedAt).toLocaleString() : ""}）。
            <br />
            要接着写，还是丢弃它？
          </>
        }
        actions={[
          {
            label: "恢复草稿",
            primary: true,
            onSelect: () => {
              if (pendingDraft) {
                setDraftTitle(pendingDraft.title);
                setContent(pendingDraft.content);
                setDirty(true);
              }
              setPendingDraft(null);
            },
          },
          {
            label: "丢弃草稿",
            danger: true,
            onSelect: () => {
              try {
                localStorage.removeItem(draftKey(noteId));
              } catch {
                /* ignore */
              }
              setPendingDraft(null);
            },
          },
        ]}
        onDismiss={() => setPendingDraft(null)}
      />

      {/* ---- 未保存就离开 ---- */}
      <Dialog
        open={leaveAsk}
        title="还有未保存的修改"
        message="离开会丢失这些改动。"
        actions={[
          {
            label: "继续编辑",
            primary: true,
            onSelect: () => setLeaveAsk(false),
          },
          {
            label: "放弃修改并离开",
            danger: true,
            onSelect: () => {
              try {
                localStorage.removeItem(draftKey(noteId));
              } catch {
                /* ignore */
              }
              setLeaveAsk(false);
              setDirty(false);
              window.location.hash = noteHref(noteId, note.title || "无标题");
            },
          },
        ]}
        onDismiss={() => setLeaveAsk(false)}
      />
    </div>
  );
}

/** 供 NoteViewScreen 判断是否显示「编辑」按钮 */
export function isEditableFormat(format: string): boolean {
  return format === "markdown" || format === "html";
}

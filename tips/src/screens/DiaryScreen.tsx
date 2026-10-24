/**
 * 日记说说（服务端 /api/diary）
 *
 * ⚠️ 为什么不走 SDK：`@nowen/sdk` 的 `listDiaries()` 打的是 `GET /api/diary?month=`，
 *    而服务端真实的列表端点是 `GET /api/diary/timeline` → **必 404**
 *    （SDK 的 `DiaryEntry` 类型也和真实字段对不上：它说 date/content/weather，
 *      实际是 createdAt/contentText/mood/images）。所以直接用 rest.ts 打真实端点。
 *
 * 图片：`/api/diary/attachments/<id>` **不需要 Authorization 头**
 *      （服务端注释写明：<img> 拿不到 header，鉴权模型靠「uuid 不可枚举」），
 *      所以 <img src> 直出即可，不用像笔记那样换签名 URL。
 *
 * 版式参考朋友圈：1 张大图、2/4 张两列、5~9 张三列九宫格，超过 9 张显示 +N。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dateGroupLabel,
  localDateKey as dateKey,
  timeOnly,
} from "../lib/time";
import { deleteDiaryAttachment, serverUrl, uploadDiaryAttachment } from "../api/rest";
import { retryImageViaFetch } from "../lib/imageFallback";
import { apiFetch } from "../api/rest";
import { TopBar } from "../App";
import { Fab } from "../shell/Fab";
import { Dialog } from "../shell/Dialog";
import { useI18n } from "../lib/i18n";
import { useRefreshHandler } from "../lib/refreshBus";
import { useTopRightOccupiedWhile } from "../lib/topRight";

interface DiaryMediaItem {
  id: string;
  type?: string;
}

interface DiaryItem {
  id: string;
  contentText: string;
  mood: string;
  createdAt: string;
  creatorName?: string | null;
  images?: string[];
  media?: DiaryMediaItem[];
}

/**
 * 待发布/待保存的附件。
 * 不复用 DiaryAttachment：那个类型要求 mimeType/size，
 * 而编辑时从已有说说带出来的附件并没有这两个字段（也不需要）。
 * `existing` = 它已经在服务端上，取消编辑时不能删。
 */
interface PendingAttachment {
  id: string;
  url: string;
  filename: string;
  type: "image" | "video";
  existing?: boolean;
}

interface TimelineResponse {
  items: DiaryItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

const MOODS = ["", "😀", "🙂", "😐", "😕", "😫", "🔥", "🌱"];

/** 按本地日期切块（items 已按时间倒序，顺序天然正确） */
function groupByDate(list: DiaryItem[]): { key: string; label: string; items: DiaryItem[] }[] {
  const out: { key: string; label: string; items: DiaryItem[] }[] = [];
  for (const item of list) {
    const key = dateKey(item.createdAt);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: dateGroupLabel(key), items: [item] });
  }
  return out;
}

/**
 * 取出这条说说的媒体列表（优先 media，回退 images）。
 *
 * ⚠️ 必须**按长度**回退，不能写成 `item.media ?? item.images` ——
 *    服务端在没有媒体时返回的是 `media: []`（**空数组是 truthy**），
 *    `??` 不会回退 → 展示与编辑会得到不一致的结果。
 *    实测后果：展示时图看得见，一进编辑 pending 为空，提交后**图全丢**。
 *    展示（diaryImageIds）与编辑（startEdit）必须共用这一个函数。
 */
function diaryMediaIds(item: DiaryItem): { id: string; type: string }[] {
  const fromMedia = (item.media ?? [])
    .filter((m) => !m.type || m.type === "image" || m.type === "video")
    .map((m) => ({ id: m.id, type: m.type === "video" ? "video" : "image" }));
  if (fromMedia.length > 0) return fromMedia;
  return (item.images ?? []).map((id) => ({ id, type: "image" }));
}

/** 只要图片 id（朋友圈墙用） */
function diaryImageIds(item: DiaryItem): string[] {
  return diaryMediaIds(item)
    .filter((m) => m.type === "image")
    .map((m) => m.id);
}

/**
 * 从剪贴板里挑出图片文件（Ctrl+V 粘贴用）。
 *
 * 两处都读：现代浏览器把截图放在 `items`（kind=file），
 * 但有些场景只填 `files` —— 只读一个会在部分浏览器上"粘贴没反应"。
 */
function imageFilesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (out.length === 0) {
    for (const f of Array.from(dt.files ?? [])) {
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  return out;
}

function imageUrl(id: string): string {
  // ⚠️ 必须补成绝对地址：APK 里 origin 是 https://localhost，
  //    相对路径会打到手机本机，图片全裂。
  return serverUrl(`/api/diary/attachments/${encodeURIComponent(id)}`);
}

/** 朋友圈式图片墙 */
function Moments({ ids, onOpen }: { ids: string[]; onOpen: (index: number) => void }) {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, 9);
  const extra = ids.length - shown.length;
  return (
    <div className="moments" data-count={shown.length}>
      {shown.map((id, i) => (
        <button
          key={`${id}-${i}`}
          type="button"
          className="moments-cell"
          onClick={() => onOpen(i)}
          aria-label={`查看第 ${i + 1} 张图片`}
        >
          <img
            src={imageUrl(id)}
            alt=""
            /* 去掉 loading="lazy"：WebView 里嵌套滚动容器中的懒加载经常永远不触发，
               表现就是"图片一直在那儿占位但从不请求"（服务端日志里确实一条请求都没有） */
            onError={(e) => void retryImageViaFetch(e.currentTarget)}
          />
          {extra > 0 && i === shown.length - 1 ? (
            <span className="moments-more">+{extra}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function DiaryScreen() {
  const { t } = useI18n();
  const [items, setItems] = useState<DiaryItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [mood, setMood] = useState("");
  const [composing, setComposing] = useState(false);
  const [posting, setPosting] = useState(false);

  // 全屏看图
  const [lightbox, setLightbox] = useState<{ ids: string[]; index: number } | null>(null);
  /** 已上传但还没随说说提交的附件（服务端那边是 diaryId = NULL 的「悬空」状态） */
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  /** 正在编辑哪一条（null = 新建模式） */
  const [editing, setEditing] = useState<DiaryItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DiaryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  // pickFiles 每次渲染都是新函数 → 用 ref 持有最新的，避免监听器被反复摘挂
  const pickFilesRef = useRef(pickFiles);
  pickFilesRef.current = pickFiles;

  // 说说编辑态在顶栏右侧放了「×」，会与右上角的连接状态重合 → 编辑期间让整组隐藏
  useTopRightOccupiedWhile(composing);

  /**
   * Ctrl+V 粘贴图片直接上传（对齐原版）。
   *
   * 挂在 window 而不是只看编辑区：咱们多半是刚截完图随手按 Ctrl+V，
   * 焦点不一定在输入框里；只在编辑区打开时生效。
   * 纯文本粘贴**不拦**（返回空数组就放过），否则会把文字也吃掉。
   */
  useEffect(() => {
    if (!composing) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = imageFilesFromClipboard(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void pickFilesRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [composing]);

  // 灯箱打开时支持键盘翻页 / 关闭（桌面端很自然，移动端外接键盘同样有用）
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      else if (e.key === "ArrowLeft")
        setLightbox((lb) => (lb ? { ...lb, index: (lb.index - 1 + lb.ids.length) % lb.ids.length } : lb));
      else if (e.key === "ArrowRight")
        setLightbox((lb) => (lb ? { ...lb, index: (lb.index + 1) % lb.ids.length } : lb));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  const loadFirstPage = useCallback(async () => {
    try {
      const data = await apiFetch<TimelineResponse>("/api/diary/timeline", {
        query: { limit: 20 },
      });
      setItems(data.items);
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  // 右上角刷新键：重拉时间线第一页（与提交后刷新走的是同一条路径）
  useRefreshHandler(loadFirstPage);

  async function loadMore() {
    if (!hasMore || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await apiFetch<TimelineResponse>("/api/diary/timeline", {
        query: { limit: 20, cursor },
      });
      setItems((prev) => [...(prev ?? []), ...data.items]);
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  /** 选了一批文件 → 逐个上传。串行上传，避免几十 MB 一起打满上行 */
  async function pickFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadDiaryAttachment(file);
        setPending((prev) => [...prev, uploaded]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      // 清掉 input 的值，否则同一张图连选两次不会触发 change
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /**
   * 移除一张待发布附件。
   *
   * ⚠️ 分两种情况：
   *   · 新上传的悬空附件 → 立刻删掉服务端那张，别攒垃圾；
   *   · 编辑时带出来的**已有附件** → 不能在这里删！
   *     服务端的 PUT 是按整批 media 做事务同步的（它自己会处理"去掉的那张"），
   *     我们在这儿先删，一旦用户又取消编辑，图就没了。
   */
  async function removePending(id: string) {
    const target = pending.find((a) => a.id === id);
    setPending((prev) => prev.filter((a) => a.id !== id));
    if (target?.existing) return;
    try {
      await deleteDiaryAttachment(id);
    } catch {
      // 删不掉只是留个垃圾文件，不该打断用户操作
    }
  }

  /** 放弃这次编辑：把新上传的悬空附件都清掉（**已有附件不动**） */
  async function discardDraft() {
    const dangling = pending.filter((a) => !a.existing).map((a) => a.id);
    setPending([]);
    setDraft("");
    setMood("");
    setComposing(false);
    setEditing(null);
    await Promise.all(dangling.map((id) => deleteDiaryAttachment(id).catch(() => undefined)));
  }

  /** 进入编辑：把这条说说填回编辑区 */
  function startEdit(item: DiaryItem) {
    setEditing(item);
    setDraft(item.contentText || "");
    setMood(item.mood || "");
    setPending(
      diaryMediaIds(item).map((m) => ({
        id: m.id,
        type: m.type === "video" ? "video" : "image",
        filename: "",
        url: imageUrl(m.id),
        existing: true,
      })),
    );
    setComposing(true);
    setError(null);
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** 删除一条说说（服务端会连它的附件一起删） */
  async function doDelete(item: DiaryItem) {
    setDeleting(true);
    setError(null);
    try {
      await apiFetch(`/api/diary/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setItems((prev) => (prev ? prev.filter((x) => x.id !== item.id) : prev));
      setConfirmDelete(null);
      // 正在编辑的正好是被删的那条 → 收掉编辑区
      if (editing?.id === item.id) void discardDraft();
    } catch (err) {
      setError(t("diary.deleteFailed", { msg: err instanceof Error ? err.message : String(err) }));
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function submit() {
    const text = draft.trim();
    // 服务端允许「纯图片说说」：文案与媒体至少一项非空即可
    if ((!text && pending.length === 0) || posting || uploading) return;
    setPosting(true);
    try {
      const body = {
        contentText: text,
        mood,
        media: pending.map((a) => ({ id: a.id, type: a.type })),
      };
      if (editing) {
        // 编辑：PUT /api/diary/:id（服务端事务化处理 media 的增删）
        await apiFetch(`/api/diary/${encodeURIComponent(editing.id)}`, { method: "PUT", body });
      } else {
        await apiFetch("/api/diary", { method: "POST", body });
      }
      setDraft("");
      setMood("");
      setPending([]);
      setComposing(false);
      setEditing(null);
      await loadFirstPage();
      listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(
        t(editing ? "diary.editFailed" : "diary.editFailed", {
          msg: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setPosting(false);
    }
  }

  return (
    <>
      <TopBar
        title={t("diary.title")}
        right={
          composing ? (
            <button
              className="topbar-btn"
              onClick={() => void discardDraft()}
              aria-label={t("common.close")}
              data-testid="compose-close"
            >
              ×
            </button>
          ) : null
        }
      />

      <div className="app-content" ref={listRef}>
        {composing ? (
          <div className="card glass" style={{ padding: 12 }} data-mode={editing ? "edit" : "new"}>
            {editing ? (
              <div className="compose-editing" data-testid="compose-editing">
                <span className="compose-editing-dot" aria-hidden="true" />
                {t("diary.editing")}
                <span className="compose-editing-time">{timeOnly(editing.createdAt)}</span>
              </div>
            ) : null}
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("diary.placeholder")}
              rows={4}
              className="compose-area"
            />
            {/* 待发布附件：缩略图 + 单张删除 */}
            {pending.length > 0 || uploading ? (
              <div className="attach-grid" data-testid="attach-grid">
                {pending.map((a) => (
                  <div className="attach-cell" key={a.id} data-testid="attach-cell">
                    {a.type === "video" ? (
                      <span className="attach-video" aria-hidden="true">
                        🎬
                      </span>
                    ) : (
                      // 说说图片端点本就无需鉴权（服务端注释：<img> 带不了 Authorization），直出即可
                      // ⚠️ 兜底不能漏：这里原来没有 onError，直连被拦时用户只看到一张裂图，
                      //    而列表里的图有兜底 —— 同一张图"发之前裂、发之后好"，很难不让人困惑
                      <img
                        src={a.url}
                        alt={a.filename}
                        onError={(e) => void retryImageViaFetch(e.currentTarget)}
                      />
                    )}
                    <button
                      type="button"
                      className="attach-remove"
                      aria-label={t("diary.removeMedia", { name: a.filename || a.id.slice(0, 6) })}
                      onClick={() => void removePending(a.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {uploading ? (
                  <div className="attach-cell attach-loading" aria-label="上传中">
                    <span className="spinner" />
                  </div>
                ) : null}
              </div>
            ) : null}

            {/*
              底部拆两行（2026-10-14 修）：以前三组元素挤在一条 nowrap flex 里，
              420px 宽窗口下提示 span 的 flex-basis:100% 把心情按钮挤成竖列、
              把发布按钮挤成竖排文字。现在：上行选图+提示，下行心情+取消/发布。
            */}
            <div className="compose-foot">
              <div className="compose-foot-media">
                {/* 选图/选视频 */}
                <button
                  type="button"
                  className="attach-add"
                  onClick={() => fileRef.current?.click()}
                  title={t("diary.pasteHint")}
                  disabled={uploading || posting}
                  aria-label={t("diary.addMedia")}
                >
                  ＋
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  hidden
                  data-testid="attach-input"
                  onChange={(e) => void pickFiles(e.target.files)}
                />
                <span className="diary-paste-hint" data-testid="paste-hint">
                  {t("diary.pasteHint")}
                </span>
              </div>

              <div className="compose-foot-actions">
                <div className="compose-moods">
                  {MOODS.map((m) => (
                    <button
                      key={m || "none"}
                      type="button"
                      className="mood-btn"
                      data-active={mood === m}
                      onClick={() => setMood(m)}
                      aria-label={m ? t("diary.moodLabel", { m }) : t("diary.moodNoneLabel")}
                    >
                      {m || "无"}
                    </button>
                  ))}
                </div>
                {editing ? (
                  <button
                    className="btn btn-secondary compose-cancel"
                    type="button"
                    onClick={() => void discardDraft()}
                    disabled={posting}
                  >
                    {t("diary.cancelEdit")}
                  </button>
                ) : null}
                <button
                  className="btn compose-submit"
                  onClick={() => void submit()}
                  disabled={posting || uploading || (!draft.trim() && pending.length === 0)}
                  data-testid="diary-submit"
                >
                  {posting
                    ? t(editing ? "diary.saving" : "diary.publishing")
                    : uploading
                      ? t("diary.uploading")
                      : t(editing ? "diary.saveEdit" : "diary.publish")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {error ? <div className="notice">{error}</div> : null}
        {!items && !error ? <div className="loading">{t("common.loading")}</div> : null}
        {items && items.length === 0 ? <div className="empty">{t("diary.empty")}</div> : null}

        {items && items.length > 0
          ? groupByDate(items).map((group) => (
              /* 一天一块：每块自带日期标题，块之间留白，不同日期的说说不再连成一片 */
              <section className="diary-group" key={group.key} data-date={group.key}>
                <h2 className="diary-group-label">
                  <span>{group.label}</span>
                  <span className="diary-group-count">{group.items.length}</span>
                </h2>
                <div className="card glass">
                  <ul className="list">
                    {group.items.map((item) => {
                      const ids = diaryImageIds(item);
                      return (
                        <li key={item.id}>
                          <div className="list-item diary-item">
                            <div className="diary-head">
                              {item.mood ? <span className="diary-mood">{item.mood}</span> : null}
                              <span className="li-sub diary-date">
                                {timeOnly(item.createdAt)}
                              </span>
                            </div>
                            {item.contentText ? (
                              <div className="diary-text">{item.contentText}</div>
                            ) : null}
                            <Moments
                              ids={ids}
                              onOpen={(index) => setLightbox({ ids, index })}
                            />
                            <div className="diary-actions">
                              <button
                                type="button"
                                className="diary-action"
                                data-testid="diary-edit"
                                onClick={() => startEdit(item)}
                              >
                                {t("diary.edit")}
                              </button>
                              <button
                                type="button"
                                className="diary-action diary-action--danger"
                                data-testid="diary-delete"
                                onClick={() => setConfirmDelete(item)}
                              >
                                {t("diary.delete")}
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            ))
          : null}

        {hasMore ? (
          <div style={{ textAlign: "center", padding: "4px 0 16px" }}>
            <button className="btn btn-secondary" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? t("common.loading") : t("diary.loadMore")}
            </button>
          </div>
        ) : null}
      </div>

      {!composing ? (
        <Fab label={t("diary.compose")} icon="✏️" onClick={() => setComposing(true)} />
      ) : null}

      <Dialog
        open={confirmDelete !== null}
        title={t("diary.deleteTitle")}
        message={
          <>
            {confirmDelete?.contentText
              ? confirmDelete.contentText.slice(0, 60)
              : t("diary.pureMedia")}
            <br />
            {t("diary.deleteMessage")}
          </>
        }
        actions={[
          { label: t("common.cancel"), onSelect: () => setConfirmDelete(null) },
          {
            label: deleting ? t("diary.deleting") : t("diary.deleteConfirm"),
            danger: true,
            onSelect: () => {
              if (confirmDelete && !deleting) void doDelete(confirmDelete);
            },
          },
        ]}
        onDismiss={() => setConfirmDelete(null)}
      />

      {lightbox ? (
        <div
          className="lightbox"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label={t("diary.viewImage", { n: lightbox.index + 1 })}
        >
          <button
            className="lightbox-close"
            aria-label={t("common.close")}
            data-testid="lightbox-close"
            /* 显式绑定 + 阻止冒泡：原来只靠"点到按钮冒泡到父层"才关得掉，
               一旦有人在这里加 stopPropagation 就会静默失效 */
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
          >
            ×
          </button>

          {/* 翻页：原来只能看打开的那一张，多图说说根本没法浏览 */}
          {lightbox.ids.length > 1 ? (
            <>
              <button
                type="button"
                className="lightbox-nav lightbox-prev"
                aria-label={t("diary.prevImage")}
                data-testid="lightbox-prev"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((lb) =>
                    lb ? { ...lb, index: (lb.index - 1 + lb.ids.length) % lb.ids.length } : lb,
                  );
                }}
              >
                ‹
              </button>
              <button
                type="button"
                className="lightbox-nav lightbox-next"
                aria-label={t("diary.nextImage")}
                data-testid="lightbox-next"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox((lb) => (lb ? { ...lb, index: (lb.index + 1) % lb.ids.length } : lb));
                }}
              >
                ›
              </button>
              <span className="lightbox-counter" data-testid="lightbox-counter">
                {lightbox.index + 1} / {lightbox.ids.length}
              </span>
            </>
          ) : null}

          <img
            /* key 让换图时重新挂载，避免上一张的尺寸/加载态串到下一张 */
            key={lightbox.ids[lightbox.index]}
            src={imageUrl(lightbox.ids[lightbox.index])}
            alt=""
            onError={(e) => void retryImageViaFetch(e.currentTarget)}
          />
        </div>
      ) : null}
    </>
  );
}

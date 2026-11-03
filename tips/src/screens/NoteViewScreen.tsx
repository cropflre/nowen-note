/**
 * 笔记阅读（P1）
 *
 * 流程：取笔记 → 取附件签名 URL → 把正文里的 /api/attachments/<id> 换成签名 URL → 渲染。
 *
 * ⚠️ 为什么必须显式换签名 URL：
 *    <img> 发请求带不了 Authorization 头，直接用相对路径会 401 → 图片全裂。
 *    主项目也是同一套做法（noteAttachmentAccessPriming.ts）。
 */
import { useEffect, useState } from "react";
import { cacheNote, getCachedNote, isPreloadEnabled } from "../lib/preloadCache";
import { fetchAttachmentAccessUrls, getClient } from "../api/client";
import { NoteBody } from "../lib/noteBody";
import { isEditableFormat } from "./NoteEditScreen";
import { noteEditHref } from "../lib/router";
import { TopBar } from "../App";
import type { Note } from "../../sdk/types";

export function NoteViewScreen({ noteId, title }: { noteId: string; title: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setError(null);
    setAttachmentUrls({});

    /**
     * 预加载：先把缓存正文渲染出来，网络回来再覆盖。
     *
     * ⚠️ **只对不含附件的笔记这么做。**
     *    笔记里的图片走签名 URL（/api/attachments/... 需要鉴权），
     *    而签名 URL **没有也不该**缓存（会过期）。只拿正文先渲染的话，
     *    <img> 会拿未签名地址发请求 → 401 + 图片闪裂 ——
     *    这正是之前修过的 bug（见下面那段并行取 URL 的注释），
     *    不能为了加速又把它放回来。
     */
    if (isPreloadEnabled()) {
      void getCachedNote<Note>(noteId).then((cached) => {
        if (cancelled || !cached) return;
        const hasAttachment = /\/api\/attachments\//.test(String(cached.content ?? ""));
        if (!hasAttachment) setNote((prev) => prev ?? cached);
      });
    }

    void (async () => {
      try {
        // ⚠️ 必须【并行】取笔记与签名 URL，然后才渲染。
        //    如果先渲染正文、后补签名 URL，第一帧就会用未签名的
        //    /api/attachments/<id> 发一次请求（<img> 带不了 Authorization）→ 401 + 图片闪裂。
        const [loaded, urls] = await Promise.all([
          getClient().getNote(noteId) as Promise<Note>,
          fetchAttachmentAccessUrls(noteId),
        ]);
        if (cancelled) return;
        setNote(loaded);
        void cacheNote(loaded as unknown as { id: string } & Record<string, unknown>);
        setAttachmentUrls(urls);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [noteId]);

  return (
    <>
      <TopBar
        title={note?.title || title || "笔记"}
        showBack
        right={
          note && isEditableFormat(note.contentFormat) ? (
            <a
              className="topbar-btn"
              style={{ fontSize: 15, fontWeight: 650, textDecoration: "none" }}
              href={noteEditHref(note.id, note.title || "无标题")}
              aria-label="编辑"
            >
              编辑
            </a>
          ) : null
        }
      />
      <div className="app-content">
        {error ? <div className="notice" style={{ margin: 12 }}>{error}</div> : null}
        {!note && !error ? <div className="loading">加载中…</div> : null}
        {note ? (
          <NoteBody
            format={note.contentFormat}
            content={note.content || ""}
            attachmentUrls={attachmentUrls}
          />
        ) : null}
      </div>
    </>
  );
}

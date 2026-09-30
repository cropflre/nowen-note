import { api, getCurrentWorkspace, getServerUrl, setCurrentWorkspace } from "./api";
import { getAccessToken } from "./authSession";
import { pushNoteAppPath } from "./noteDeepLink";
import { openInlineCommentPanel } from "./inlineCommentEvents";
import type { Note } from "@/types";

export const OPEN_COMMENT_CENTER_EVENT = "nowen:open-comment-center";
export const COMMENTS_CHANGED_EVENT = "nowen:comments-changed";

export function openCommentCenter(): void {
  window.dispatchEvent(new Event(OPEN_COMMENT_CENTER_EVENT));
}

export async function openNoteComment(noteId: string, commentId: string, onOpenNote: (note: Note) => void): Promise<void> {
  const token = getAccessToken();
  const server = getServerUrl();
  // 使用当前权限重新读取原件，不能直接相信历史通知携带的工作区与标题。
  const note = await api.getNote(noteId);
  if (token !== getAccessToken() || server !== getServerUrl()) throw new Error("账号或服务器已切换，请重新打开评论");
  if (note.isTrashed) throw new Error("笔记已进入回收站");
  const workspaceId = note.workspaceId || null;
  if ((getCurrentWorkspace() || null) !== workspaceId) {
    setCurrentWorkspace(workspaceId || "");
    window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId } }));
  }
  onOpenNote(note);
  pushNoteAppPath(note.id);
  openInlineCommentPanel({ noteId: note.id, noteTitle: note.title, commentId });
}

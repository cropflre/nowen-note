import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Globe, Lock, AlertCircle, Loader2, FileText, MessageCircle, Send, RefreshCw, Edit3, Check, UserCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { ShareInfo, SharedNoteContent, ShareComment, Note } from "@/types";
import { cn } from "@/lib/utils";
import { common, createLowlight } from "lowlight";
import TiptapEditor from "@/components/TiptapEditor";

// 分享页独立的 lowlight 实例（与编辑器保持一致的 common 语法集合）
const sharedLowlight = createLowlight(common);

/** 访客昵称本地存储 key，用户在同一浏览器上只需要填写一次 */
const GUEST_NAME_KEY = "nowen-guest-name";

interface SharedNoteViewProps {
  shareToken: string;
}

export default function SharedNoteView({ shareToken }: SharedNoteViewProps) {
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [content, setContent] = useState<SharedNoteContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // Phase 4: 同步轮询
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Phase 3: 评论
  const [comments, setComments] = useState<ShareComment[]>([]);
  const [showComments, setShowComments] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);

  // ===== 访客编辑相关状态 =====
  /** 访客昵称（从 localStorage 恢复），作为编辑身份标记 */
  const [guestName, setGuestName] = useState<string>(() => {
    try { return localStorage.getItem(GUEST_NAME_KEY) || ""; } catch { return ""; }
  });
  /** 是否已进入编辑模式（仅 permission='edit' 时可用） */
  const [isEditing, setIsEditing] = useState(false);
  /** 是否显示昵称输入弹窗 */
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  /** 昵称输入框临时值 */
  const [nicknameDraft, setNicknameDraft] = useState("");
  /** 昵称输入校验错误 */
  const [nicknameError, setNicknameError] = useState("");
  /** 保存状态：idle/saving/saved/error */
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string>("");
  /** 用最新的 version / accessToken / guestName / content 供 debounce 回调使用 */
  const latestVersionRef = useRef<number | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const guestNameRef = useRef<string>(guestName);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const savedIdleTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => { guestNameRef.current = guestName; }, [guestName]);
  useEffect(() => { accessTokenRef.current = accessToken; }, [accessToken]);
  useEffect(() => { latestVersionRef.current = currentVersion; }, [currentVersion]);

  // 修复分享页面滚动问题：覆盖 #root 和 html/body 的 overflow:hidden
  useEffect(() => {
    const root = document.getElementById("root");
    const html = document.documentElement;
    const body = document.body;

    // 保存原始样式
    const originalRootOverflow = root?.style.overflow || "";
    const originalRootHeight = root?.style.height || "";
    const originalHtmlOverflow = html.style.overflow;
    const originalBodyOverflow = body.style.overflow;

    // 分享页面需要允许滚动
    if (root) {
      root.style.overflow = "auto";
      root.style.height = "auto";
      root.style.minHeight = "100vh";
    }
    html.style.overflow = "auto";
    body.style.overflow = "auto";

    return () => {
      // 卸载时恢复原始样式
      if (root) {
        root.style.overflow = originalRootOverflow;
        root.style.height = originalRootHeight;
        root.style.minHeight = "";
      }
      html.style.overflow = originalHtmlOverflow;
      body.style.overflow = originalBodyOverflow;
    };
  }, []);

  // 加载分享信息
  useEffect(() => {
    const load = async () => {
      try {
        const info = await api.getShareInfo(shareToken);
        setShareInfo(info);
        if (info.needPassword) {
          setNeedPassword(true);
          setLoading(false);
        } else {
          // 无密码保护，直接加载内容
          const data = await api.getSharedContent(shareToken);
          setContent(data);
          setCurrentVersion(data.version || null);
          setLoading(false);
          // 加载评论
          if (info.permission !== "view") {
            const cmts = await api.getSharedComments(shareToken);
            setComments(cmts);
          }
        }
      } catch (e: any) {
        setError(e.message || "加载失败");
        setLoading(false);
      }
    };
    load();
  }, [shareToken]);

  // 密码验证
  const handleVerify = async () => {
    if (!password.trim() || verifying) return;
    setVerifying(true);
    setPasswordError("");
    try {
      const result = await api.verifySharePassword(shareToken, password.trim());
      setAccessToken(result.accessToken);
      setNeedPassword(false);

      // 加载内容
      const data = await api.getSharedContent(shareToken, result.accessToken);
      setContent(data);
      setCurrentVersion(data.version || null);
      // 加载评论
      if (shareInfo?.permission !== "view") {
        const cmts = await api.getSharedComments(shareToken, result.accessToken);
        setComments(cmts);
      }
    } catch (e: any) {
      setPasswordError(e.message || "验证失败");
    } finally {
      setVerifying(false);
    }
  };

  // 处理回车提交
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleVerify();
  };

  // Phase 4: 同步轮询（每 5 秒检测一次更新）
  useEffect(() => {
    if (!content || loading || needPassword) return;

    const poll = async () => {
      try {
        const data = await api.pollSharedNote(shareToken, accessToken || undefined);
        if (currentVersion !== null && data.version > currentVersion) {
          setHasUpdate(true);
        }
      } catch {
        // 轮询失败不处理（可能过期等）
      }
    };

    pollIntervalRef.current = setInterval(poll, 5000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [shareToken, accessToken, content, loading, needPassword, currentVersion]);

  // 手动刷新内容
  const handleRefresh = async () => {
    try {
      const data = await api.getSharedContent(shareToken, accessToken || undefined);
      setContent(data);
      setCurrentVersion(data.version || null);
      setHasUpdate(false);
    } catch (e: any) {
      console.error("刷新内容失败:", e);
    }
  };

  // 提交评论
  const handleSubmitComment = async () => {
    if (!newComment.trim() || submittingComment) return;
    setSubmittingComment(true);
    try {
      // 评论也带上访客昵称（如果有），让所有者看到是哪个访客
      const comment = await api.addSharedComment(
        shareToken,
        { content: newComment.trim(), guestName: guestNameRef.current || undefined },
        accessToken || undefined,
      );
      setComments((prev) => [...prev, comment]);
      setNewComment("");
    } catch (e: any) {
      console.error("提交评论失败:", e);
    } finally {
      setSubmittingComment(false);
    }
  };

  // ===== 访客编辑相关 handler =====

  /**
   * 点击"开始编辑"按钮：
   * - 如果没有昵称，弹昵称输入框；提交后才真正进入编辑模式
   * - 如果已有昵称，直接进入编辑模式
   */
  const handleStartEditing = useCallback(() => {
    if (!content || content.permission !== "edit") return;
    if (content.isLocked) {
      setSaveError("笔记已被所有者锁定，暂不可编辑");
      setSaveStatus("error");
      return;
    }
    if (!guestNameRef.current.trim()) {
      setNicknameDraft("");
      setNicknameError("");
      setShowNicknameModal(true);
      return;
    }
    setIsEditing(true);
  }, [content]);

  /**
   * 昵称弹窗提交：
   * - 校验非空、长度 ≤ 32
   * - 写入 localStorage，供下次自动回填
   * - 关闭弹窗并进入编辑模式
   */
  const handleConfirmNickname = useCallback(() => {
    const name = nicknameDraft.trim();
    if (!name) {
      setNicknameError("请输入昵称");
      return;
    }
    if (name.length > 32) {
      setNicknameError("昵称过长，最多 32 个字符");
      return;
    }
    try { localStorage.setItem(GUEST_NAME_KEY, name); } catch { /* 忽略存储失败 */ }
    setGuestName(name);
    setShowNicknameModal(false);
    setIsEditing(true);
  }, [nicknameDraft]);

  /**
   * 访客端 onUpdate 回调：
   * - TiptapEditor 内部已做 500ms debounce，这里直接调 API
   * - 发生 409 版本冲突时，自动拉取最新内容刷新（注意：这会丢弃本地未保存改动，所以先提示）
   */
  const handleGuestSave = useCallback(async (data: { content: string; contentText: string; title: string }) => {
    if (!content) return;
    if (!guestNameRef.current.trim()) {
      // 正常流程里不会走到这，但防御一下
      setShowNicknameModal(true);
      return;
    }
    setSaveStatus("saving");
    setSaveError("");
    try {
      const result = await api.updateSharedContent(
        shareToken,
        {
          title: data.title,
          content: data.content,
          contentText: data.contentText,
          version: latestVersionRef.current ?? undefined,
          guestName: guestNameRef.current.trim(),
        },
        accessTokenRef.current || undefined,
      );
      latestVersionRef.current = result.version;
      setCurrentVersion(result.version);
      // 仅更新内容对象中的元数据字段，避免把刚刚输入的 content/contentText 回塞到 state
      // 否则会触发 TiptapEditor 的 note.content 变化 → 可能引起光标抖动（与先前修复思路一致）
      setContent((prev) => prev ? { ...prev, version: result.version, updatedAt: result.updatedAt } : prev);
      setHasUpdate(false); // 自己刚保存过，清掉"有新版本"提示
      setSaveStatus("saved");
      if (savedIdleTimerRef.current) clearTimeout(savedIdleTimerRef.current);
      savedIdleTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (e: any) {
      console.error("访客保存失败:", e);
      setSaveStatus("error");
      if (e?.code === "VERSION_CONFLICT") {
        setSaveError("内容已被其他人更新，请点击顶部『刷新』后再编辑");
      } else if (e?.code === "NOTE_LOCKED") {
        setSaveError("笔记已被所有者锁定，无法继续编辑");
        setIsEditing(false);
      } else if (e?.code === "GUEST_NAME_REQUIRED") {
        setSaveError("请先填写访客昵称");
        setShowNicknameModal(true);
      } else {
        setSaveError(e?.message || "保存失败");
      }
    }
  }, [content, shareToken]);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedIdleTimerRef.current) clearTimeout(savedIdleTimerRef.current);
    };
  }, []);

  // 构造一个供 TiptapEditor 使用的"伪 Note"。TiptapEditor 只用到
  // note.id（用作 effect key）、note.title、note.content、note.contentText、note.isLocked 等字段，
  // 其他字段给予合理默认值即可。
  // 注意：id 用 noteId ?? shareToken，保证在分享会话内稳定、不会每次 re-render 变化（否则编辑器会 re-init）。
  const fakeNoteForEditing = useMemo<Note | null>(() => {
    if (!content) return null;
    return {
      id: content.noteId || shareToken,
      userId: "",
      notebookId: "",
      title: content.title || "",
      content: content.content || "{}",
      contentText: content.contentText || "",
      isPinned: 0,
      isFavorite: 0,
      isLocked: content.isLocked ? 1 : 0,
      isArchived: 0,
      isTrashed: 0,
      trashedAt: null,
      sortOrder: 0,
      version: content.version || 0,
      createdAt: content.updatedAt,
      updatedAt: content.updatedAt,
      tags: [],
    } as Note;
    // 仅当 noteId/permission 变化时重建；content 的 title/正文 在编辑态下由编辑器自己管理，
    // 避免把 debounce 保存回塞的数据再次喂给编辑器导致光标抖动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content?.noteId, shareToken, content?.permission, content?.isLocked]);


  // 分享页内的复制代码按钮事件委托
  const handleSharedContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const btn = target.closest("[data-copy-code]") as HTMLElement | null;
    if (!btn) return;
    e.preventDefault();
    const wrapper = btn.closest(".shared-code-block") as HTMLElement | null;
    const codeEl = wrapper?.querySelector("code");
    const text = codeEl?.textContent ?? "";
    const done = () => {
      btn.setAttribute("data-copied", "1");
      setTimeout(() => btn.removeAttribute("data-copied"), 1500);
    };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done).catch(() => {});
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } finally { document.body.removeChild(ta); }
      }
    } catch (err) {
      console.error("复制代码失败:", err);
    }
  }, []);

  // 加载中
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={24} className="animate-spin text-indigo-500" />
          <p className="text-sm text-zinc-400">加载分享内容...</p>
        </div>
      </div>
    );
  }

  // 错误
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4 max-w-sm mx-auto text-center px-4">
          <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
            <AlertCircle size={28} className="text-red-500" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-200 mb-1">无法访问</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{error}</p>
          </div>
          <a
            href="/"
            className="text-sm text-indigo-500 hover:text-indigo-600 transition-colors"
          >
            返回首页
          </a>
        </div>
      </div>
    );
  }

  // 密码验证页
  if (needPassword) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="w-full max-w-sm mx-auto px-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 p-6">
            <div className="flex flex-col items-center mb-6">
              <div className="w-14 h-14 rounded-2xl bg-amber-500/10 flex items-center justify-center mb-3">
                <Lock size={28} className="text-amber-500" />
              </div>
              <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-200">需要密码访问</h2>
              {shareInfo && (
                <p className="text-xs text-zinc-500 mt-1">
                  <span className="font-medium">{shareInfo.ownerName}</span> 分享的笔记
                </p>
              )}
              {shareInfo?.noteTitle && (
                <p className="text-xs text-zinc-400 mt-0.5 truncate max-w-[240px]">「{shareInfo.noteTitle}」</p>
              )}
            </div>

            <div className="space-y-3">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入访问密码"
                autoFocus
                className="w-full h-10 px-4 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
              />
              {passwordError && (
                <p className="text-xs text-red-500 text-center">{passwordError}</p>
              )}
              <Button
                onClick={handleVerify}
                disabled={!password.trim() || verifying}
                className="w-full h-10 bg-indigo-500 hover:bg-indigo-600 text-white font-medium rounded-xl"
              >
                {verifying ? <Loader2 size={16} className="animate-spin mr-1.5" /> : null}
                {verifying ? "验证中..." : "确认访问"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 显示分享内容
  if (!content) return null;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 overflow-y-auto" style={{ height: '100vh' }}>
      {/* 顶部信息栏 */}
      <header className="sticky top-0 z-10 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0">
              <FileText size={16} className="text-indigo-500" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                {content.title || "无标题笔记"}
              </h1>
              {shareInfo && (
                <p className="text-[11px] text-zinc-400">
                  由 <span className="text-zinc-500 dark:text-zinc-400">{shareInfo.ownerName}</span> 分享
                  {content.updatedAt && (
                    <> · 更新于 {new Date(content.updatedAt).toLocaleDateString("zh-CN")}</>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* 更新提示 */}
            {hasUpdate && (
              <button
                onClick={handleRefresh}
                className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] rounded-full bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors font-medium"
              >
                <RefreshCw size={11} />
                有新版本，点击刷新
              </button>
            )}
            {/* 评论按钮 */}
            {shareInfo && shareInfo.permission !== "view" && (
              <button
                onClick={() => setShowComments(!showComments)}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-[10px] rounded-md transition-colors",
                  showComments ? "bg-blue-500/10 text-blue-500" : "text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                )}
              >
                <MessageCircle size={12} />
                {comments.length > 0 && <span>{comments.length}</span>}
              </button>
            )}

            {/* 访客编辑：入口按钮 / 昵称徽章 / 保存状态（仅当 permission === 'edit' 且笔记未锁定） */}
            {content.permission === "edit" && !content.isLocked && (
              <>
                {isEditing ? (
                  <>
                    {/* 当前昵称小标签 */}
                    {guestName && (
                      <span className="hidden sm:flex items-center gap-1 px-2 py-1 text-[10px] rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500" title="点击可修改昵称">
                        <UserCircle2 size={11} />
                        <button
                          onClick={() => { setNicknameDraft(guestName); setNicknameError(""); setShowNicknameModal(true); }}
                          className="hover:text-zinc-700 dark:hover:text-zinc-300"
                        >
                          {guestName}
                        </button>
                      </span>
                    )}
                    {/* 保存状态 */}
                    <span className={cn(
                      "flex items-center gap-1 px-2 py-1 text-[10px] rounded-md font-medium",
                      saveStatus === "saving" && "bg-amber-500/10 text-amber-500",
                      saveStatus === "saved" && "bg-green-500/10 text-green-500",
                      saveStatus === "error" && "bg-red-500/10 text-red-500",
                      saveStatus === "idle" && "bg-zinc-100 dark:bg-zinc-800 text-zinc-400",
                    )}>
                      {saveStatus === "saving" && <><Loader2 size={11} className="animate-spin" />保存中</>}
                      {saveStatus === "saved" && <><Check size={11} />已保存</>}
                      {saveStatus === "error" && <><AlertCircle size={11} />保存失败</>}
                      {saveStatus === "idle" && <>已就绪</>}
                    </span>
                  </>
                ) : (
                  <button
                    onClick={handleStartEditing}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] rounded-md bg-indigo-500 hover:bg-indigo-600 text-white font-medium transition-colors"
                  >
                    <Edit3 size={11} />
                    开始编辑
                  </button>
                )}
              </>
            )}

            <span className="px-2 py-1 text-[10px] rounded-md bg-indigo-500/10 text-indigo-500 font-medium">
              {content.permission === "view" ? "仅查看" : content.permission === "edit" ? "可编辑" : "可评论"}
            </span>
          </div>
        </div>
        {/* 保存失败时的错误提示条 */}
        {saveStatus === "error" && saveError && (
          <div className="max-w-4xl mx-auto px-4 pb-2 -mt-1">
            <p className="text-[11px] text-red-500 flex items-center gap-1">
              <AlertCircle size={11} />
              {saveError}
            </p>
          </div>
        )}
      </header>

      {/* 笔记内容：edit + isEditing 时走 TiptapEditor；否则继续走只读 HTML 渲染 */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        {isEditing && content.permission === "edit" && fakeNoteForEditing ? (
          <div className="shared-note-editor">
            <TiptapEditor
              note={fakeNoteForEditing}
              onUpdate={handleGuestSave}
              editable={!content.isLocked}
              isGuest
            />
          </div>
        ) : (
          <div
            className="shared-note-content prose prose-sm dark:prose-invert max-w-none
              prose-headings:text-zinc-800 dark:prose-headings:text-zinc-200
              prose-p:text-zinc-600 dark:prose-p:text-zinc-300
              prose-a:text-indigo-500
              prose-code:text-indigo-600 dark:prose-code:text-indigo-400
              prose-blockquote:border-indigo-300 dark:prose-blockquote:border-indigo-700"
            onClick={handleSharedContentClick}
            dangerouslySetInnerHTML={{ __html: renderContent(content.content) }}
          />
        )}
      </main>

      {/* 评论区域 */}
      {showComments && (
        <div className="max-w-4xl mx-auto px-4 pb-8">
          <div className="border-t border-zinc-200 dark:border-zinc-800 pt-6">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4 flex items-center gap-2">
              <MessageCircle size={16} className="text-blue-500" />
              评论 ({comments.length})
            </h3>

            {/* 评论列表 */}
            {comments.length === 0 ? (
              <p className="text-xs text-zinc-400 mb-4">暂无评论，来说点什么吧</p>
            ) : (
              <div className="space-y-3 mb-4">
                {comments.map((comment) => (
                  <div key={comment.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-900">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center text-[10px] font-medium text-indigo-500">
                        {(comment.username || "?")[0]?.toUpperCase()}
                      </div>
                      <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{comment.username || "匿名"}</span>
                      <span className="text-[10px] text-zinc-400">
                        {new Date(comment.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">{comment.content}</p>
                  </div>
                ))}
              </div>
            )}

            {/* 评论输入 */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmitComment(); } }}
                placeholder="输入评论..."
                className="flex-1 h-9 px-3 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
              />
              <Button
                onClick={handleSubmitComment}
                disabled={!newComment.trim() || submittingComment}
                size="icon"
                className="h-9 w-9 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg shrink-0"
              >
                {submittingComment ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 底部 */}
      <footer className="border-t border-zinc-200 dark:border-zinc-800 py-6 text-center">
        <p className="text-xs text-zinc-400">
          <Globe size={12} className="inline mr-1" />
          通过 Nowen Note 分享
        </p>
      </footer>

      {/* 访客昵称输入弹窗：首次点击"开始编辑"或服务端要求昵称时出现 */}
      {showNicknameModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowNicknameModal(false); }}
        >
          <div className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 p-6">
            <div className="flex flex-col items-center mb-5">
              <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-3">
                <UserCircle2 size={24} className="text-indigo-500" />
              </div>
              <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-200">请填写昵称</h2>
              <p className="text-xs text-zinc-500 mt-1 text-center">
                在开始编辑之前，请留下一个昵称方便笔记作者知道是谁做的改动。
              </p>
            </div>
            <div className="space-y-3">
              <input
                type="text"
                value={nicknameDraft}
                onChange={(e) => { setNicknameDraft(e.target.value); if (nicknameError) setNicknameError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleConfirmNickname(); } }}
                placeholder="例如：张三"
                maxLength={32}
                autoFocus
                className="w-full h-10 px-4 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500"
              />
              {nicknameError && (
                <p className="text-xs text-red-500">{nicknameError}</p>
              )}
              <div className="flex gap-2">
                <Button
                  onClick={() => setShowNicknameModal(false)}
                  variant="ghost"
                  className="flex-1 h-10 text-sm"
                >
                  取消
                </Button>
                <Button
                  onClick={handleConfirmNickname}
                  disabled={!nicknameDraft.trim()}
                  className="flex-1 h-10 bg-indigo-500 hover:bg-indigo-600 text-white font-medium rounded-xl"
                >
                  开始编辑
                </Button>
              </div>
              <p className="text-[10px] text-zinc-400 text-center">
                昵称会保存在本机浏览器中，下次访问自动填入。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 将编辑器的 JSON content 渲染为 HTML
 * 如果 content 是 JSON 格式（Tiptap），尝试简单渲染
 * 如果是纯 HTML 字符串，直接返回
 */
function renderContent(content: string): string {
  if (!content) return "";

  // 尝试解析 JSON (Tiptap editor JSON format)
  try {
    const json = JSON.parse(content);
    if (json.type === "doc" && json.content) {
      return renderTiptapJSON(json);
    }
  } catch {
    // 不是 JSON，当作 HTML 处理
  }

  return content;
}

/** 简单的 Tiptap JSON → HTML 渲染器 */
function renderTiptapJSON(doc: any): string {
  if (!doc.content) return "";
  // 顶层：把紧邻的 codeBlock 节点合并为一个，兼容历史笔记里被粘贴 bug 拆散的数据
  const merged: any[] = [];
  for (const node of doc.content) {
    const last = merged[merged.length - 1];
    if (
      node?.type === "codeBlock" &&
      last?.type === "codeBlock" &&
      (last.attrs?.language || null) === (node.attrs?.language || null)
    ) {
      const lastText = (last.content || []).map((c: any) => c.text || "").join("");
      const curText = (node.content || []).map((c: any) => c.text || "").join("");
      const mergedText = lastText + "\n" + curText;
      last.content = mergedText ? [{ type: "text", text: mergedText }] : [];
      continue;
    }
    merged.push(node);
  }
  return merged.map((node: any) => renderNode(node)).join("");
}

function renderNode(node: any): string {
  if (!node) return "";

  switch (node.type) {
    case "paragraph": {
      const inner = renderChildren(node);
      // Tiptap 空段落渲染为空 <p>，保留段落间距
      return `<p>${inner || "<br/>"}</p>`;
    }
    case "heading": {
      const level = node.attrs?.level || 1;
      return `<h${level}>${renderChildren(node)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${renderChildren(node)}</ul>`;
    case "orderedList":
      return `<ol>${renderChildren(node)}</ol>`;
    case "listItem":
      return `<li>${renderChildren(node)}</li>`;
    case "taskList":
      return `<ul class="task-list">${renderChildren(node)}</ul>`;
    case "taskItem": {
      const checked = node.attrs?.checked ? "checked" : "";
      return `<li class="task-item"><input type="checkbox" ${checked} disabled />${renderChildren(node)}</li>`;
    }
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
      return `<blockquote>${renderChildren(node)}</blockquote>`;
    case "horizontalRule":
      return "<hr />";
    case "image": {
      const src = node.attrs?.src || "";
      const alt = node.attrs?.alt || "";
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
    }
    case "table":
      return `<table>${renderChildren(node)}</table>`;
    case "tableRow":
      return `<tr>${renderChildren(node)}</tr>`;
    case "tableHeader":
      return `<th>${renderChildren(node)}</th>`;
    case "tableCell":
      return `<td>${renderChildren(node)}</td>`;
    case "text": {
      let text = escapeHtml(node.text || "");
      if (node.marks) {
        for (const mark of node.marks) {
          switch (mark.type) {
            case "bold":
              text = `<strong>${text}</strong>`;
              break;
            case "italic":
              text = `<em>${text}</em>`;
              break;
            case "strike":
              text = `<del>${text}</del>`;
              break;
            case "code":
              text = `<code>${text}</code>`;
              break;
            case "link":
              text = `<a href="${escapeHtml(mark.attrs?.href || "")}" target="_blank" rel="noopener">${text}</a>`;
              break;
            case "highlight":
              text = `<mark>${text}</mark>`;
              break;
          }
        }
      }
      return text;
    }
    case "hardBreak":
      return "<br />";
    default:
      return renderChildren(node);
  }
}

function renderChildren(node: any): string {
  if (!node.content) return node.text || "";
  return node.content.map((child: any) => renderNode(child)).join("");
}

/**
 * 渲染代码块，视觉与编辑器内的 CodeBlockView 一致：
 *   - mac 风格三色小圆点 + 语言徽章
 *   - 右上角复制按钮（由 onClick 事件委托处理）
 *   - 暗色代码区 + 等宽字体
 */
function renderCodeBlock(node: any): string {
  const rawLang = node.attrs?.language;
  const langLabel = !rawLang || rawLang === "auto" ? "auto" : String(rawLang).toLowerCase();
  const codeText = (node.content || []).map((c: any) => c.text || "").join("");
  const languageClass = langLabel && langLabel !== "auto" ? ` language-${escapeHtml(langLabel)}` : "";

  // 用 lowlight 生成带 hljs token 的 hast，再序列化为 HTML 注入 <code>
  const highlighted = highlightCode(codeText, langLabel);

  return `
<div class="shared-code-block">
  <div class="shared-code-toolbar">
    <div class="shared-code-toolbar-left">
      <span class="shared-code-dots">
        <span class="shared-code-dot" style="background:#ff5f57"></span>
        <span class="shared-code-dot" style="background:#febc2e"></span>
        <span class="shared-code-dot" style="background:#28c840"></span>
      </span>
      <span class="shared-code-lang">${escapeHtml(langLabel)}</span>
    </div>
    <button type="button" class="shared-code-copy" data-copy-code aria-label="复制代码">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      <span class="shared-code-copy-label">复制</span>
    </button>
  </div>
  <pre class="shared-code-pre"><code class="shared-code-content hljs${languageClass}">${highlighted}</code></pre>
</div>
`.trim();
}

/**
 * 使用 lowlight 对代码做语法高亮，返回可直接插入 <code> 的 HTML 字符串
 * - 已知语言：highlight(lang, code)
 * - auto 或未注册语言：highlightAuto(code)
 * - 失败时回退为转义后的纯文本
 */
function highlightCode(code: string, lang: string): string {
  if (!code) return "";
  try {
    let tree: any;
    if (lang && lang !== "auto" && sharedLowlight.registered(lang)) {
      tree = sharedLowlight.highlight(lang, code);
    } else {
      tree = sharedLowlight.highlightAuto(code);
    }
    return hastToHtml(tree);
  } catch {
    return escapeHtml(code);
  }
}

/**
 * 极简 hast → HTML 序列化器，只处理 lowlight 会产出的三种节点：
 *   - root：仅渲染 children
 *   - element：标签名 + className + children（lowlight 不产出其他属性）
 *   - text：转义后输出
 */
function hastToHtml(node: any): string {
  if (!node) return "";
  if (node.type === "root") {
    return (node.children || []).map(hastToHtml).join("");
  }
  if (node.type === "text") {
    return escapeHtml(node.value || "");
  }
  if (node.type === "element") {
    const tag = String(node.tagName || "span");
    const classList = node.properties && Array.isArray(node.properties.className)
      ? node.properties.className.join(" ")
      : "";
    const classAttr = classList ? ` class="${escapeHtml(classList)}"` : "";
    const inner = (node.children || []).map(hastToHtml).join("");
    return `<${tag}${classAttr}>${inner}</${tag}>`;
  }
  return "";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

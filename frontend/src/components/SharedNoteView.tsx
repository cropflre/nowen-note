import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Globe, Lock, AlertCircle, Loader2, FileText, MessageCircle, Send, RefreshCw, Edit3, Check, UserCircle2, ListTree, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { ShareInfo, SharedNoteContent, ShareComment, Note } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { common, createLowlight } from "lowlight";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import TiptapEditor from "@/components/TiptapEditor";
import type { NoteEditorUpdatePayload } from "@/components/editors/types";
import { detectFormat } from "@/lib/contentFormat";
import MermaidView from "@/components/MermaidView";
import { isMermaidLang, renderMermaid } from "@/lib/mermaidRenderer";
import { renderKatex } from "@/lib/katexRenderer";

// 分享页独立的 lowlight 实例（与编辑器保持一致的 common 语法集合）
const sharedLowlight = createLowlight(common);

/** 访客昵称本地存储 key，用户在同一浏览器上只需要填写一次 */
const GUEST_NAME_KEY = "nowen-guest-name";
const SHARE_HEADER_OFFSET_PX = 72;

interface SharedOutlineHeading {
  id: string;
  level: number;
  text: string;
}

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
  // PM HTML 渲染容器 ref：用于在内容注入后扫描 .shared-mermaid-block 占位，
  // 异步把每个占位替换为 mermaid 渲染出的 SVG（避开 dangerouslySetInnerHTML
  // 无法挂载 React 子树的限制）
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const pmRenderRef = useRef<HTMLDivElement | null>(null);
  const desktopOutlineScrollRef = useRef<HTMLDivElement | null>(null);
  const mobileOutlineScrollRef = useRef<HTMLDivElement | null>(null);
  const desktopOutlineItemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const mobileOutlineItemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [outlineHeadings, setOutlineHeadings] = useState<SharedOutlineHeading[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState<string>("");
  const [isDesktopOutlineOpen, setIsDesktopOutlineOpen] = useState(true);
  const [isMobileOutlineOpen, setIsMobileOutlineOpen] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt?: string } | null>(null);

  // Lightbox Esc 关闭 + 滚动锁
  useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightboxImage(null); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [lightboxImage]);

  // DOM 后处理：统一给分享页正文图片补 width style，覆盖所有渲染路径
  // （ReactMarkdown / dangerouslySetInnerHTML / 原始 HTML 透传）
  useEffect(() => {
    const root = pmRenderRef.current;
    if (!root) return;
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
    for (const img of imgs) {
      // 已处理过则跳过
      if (img.dataset.wNorm) continue;
      const raw =
        img.style.width ||
        img.getAttribute("width") ||
        img.getAttribute("data-width") ||
        img.getAttribute("data-image-width") ||
        "";
      const num = typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? parseFloat(raw.replace(/px$/i, ""))
          : NaN;
      const w = Number.isFinite(num) && num > 0 ? Math.round(num) : null;
      img.style.maxWidth = "100%";
      img.style.height = "auto";
      img.style.cursor = "zoom-in";
      if (w) {
        img.style.width = `${w}px`;
        img.setAttribute("width", String(w));
      }
      img.dataset.wNorm = "1";
    }
  });

  useEffect(() => { guestNameRef.current = guestName; }, [guestName]);
  useEffect(() => { accessTokenRef.current = accessToken; }, [accessToken]);
  useEffect(() => { latestVersionRef.current = currentVersion; }, [currentVersion]);

  /**
   * 当前登录用户 id（仅当浏览器有 nowen-token 时尝试获取）。
   *
   * 用途：判断访问者是否就是这条笔记的作者本人。如果是，则：
   *   - 跳过"请填写访客昵称"弹窗
   *   - 自动用作者的 displayName/username 作为 guestName 提交
   *
   * 实现要点：
   *   - 只在 mount 时调一次 /api/me；未登录(没 token)直接 null，不发请求
   *   - 失败（token 过期等）静默忽略，按访客流程处理
   *   - 不依赖 AppContext（分享页是独立路由，外面没有 AppProvider）
   */
  const [viewerUserId, setViewerUserId] = useState<string | null>(null);
  const [viewerDisplayName, setViewerDisplayName] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    let hasToken = false;
    try { hasToken = !!localStorage.getItem("nowen-token"); } catch { /* ignore */ }
    if (!hasToken) return;
    api.getMe()
      .then((u) => {
        if (cancelled || !u) return;
        setViewerUserId(u.id);
        // 作者身份提交时优先用 displayName，否则 username
        setViewerDisplayName((u as any).displayName || u.username || "");
      })
      .catch(() => { /* 未登录 / token 失效都按游客处理 */ });
    return () => { cancelled = true; };
  }, []);

  /** 当前访问者是否是这条笔记的作者本人 */
  const isOwnerViewing = !!(viewerUserId && content?.ownerId && viewerUserId === content.ownerId);

  /**
   * 分享页 PM 路径下 mermaid 块的异步渲染。
   *
   * 流程：
   *   1. `renderCodeBlock` 把 mermaid 代码块输出为带 `data-mermaid-source`
   *      的占位 div，源码 base64 编码塞在 attr 里。
   *   2. 内容 mount 后，这个 effect 扫描容器内所有占位，逐个解码源码、调
   *      `renderMermaid` 拿 SVG，再注入 innerHTML。
   *   3. 已渲染过的占位会被打上 `data-rendered`，避免重复工作。
   *
   * 失败处理：单个块出错只显示该块的错误条，不影响其它内容。
   */
  useEffect(() => {
    const host = pmRenderRef.current;
    if (!host || !content?.content) return;
    // detectFormat 是 md 或编辑模式时，这个容器不存在/不会渲染 mermaid 占位
    const blocks = host.querySelectorAll<HTMLDivElement>(".shared-mermaid-block:not([data-rendered])");
    if (blocks.length === 0) return;

    let cancelled = false;
    blocks.forEach((block) => {
      const encoded = block.getAttribute("data-mermaid-source") || "";
      let source = "";
      try {
        source = decodeURIComponent(escape(atob(encoded)));
      } catch {
        source = "";
      }
      block.setAttribute("data-rendered", "1");
      renderMermaid(source).then((res) => {
        if (cancelled) return;
        if (res.error) {
          block.innerHTML = `
            <div class="shared-mermaid-error">
              <div class="shared-mermaid-error-title">Mermaid 语法错误</div>
              <div class="shared-mermaid-error-msg">${escapeHtml(res.error)}</div>
            </div>
          `;
        } else {
          block.innerHTML = res.svg;
        }
      });
    });

    return () => {
      cancelled = true;
    };
    // content?.content 变化时重新扫描；isEditing 切换时容器会被卸载，自然清空
  }, [content?.content, isEditing]);

  /**
   * 分享页 LaTeX 公式的异步渲染（PM 路径 + MD 路径共用）。
   *
   * 两条路径都把 math 输出为占位元素：
   *   - PM 路径：`.shared-math-block / .shared-math-inline` + `data-math-source`
   *     （base64 编码的 LaTeX 源码） + `data-math-display`
   *   - MD 路径：同样类名，但属性名 `data-math-source-md`（防止冲突 / 区分来源）
   *
   * 这里统一扫描，调 renderKatex 拿 HTML 注入。已渲染过的打 `data-rendered`。
   *
   * 失败处理：单个公式出错只显示该处的错误条，不影响其它内容。
   */
  useEffect(() => {
    const host = pmRenderRef.current;
    if (!host || !content?.content) return;
    const blocks = host.querySelectorAll<HTMLElement>(
      ".shared-math-block:not([data-rendered]), .shared-math-inline:not([data-rendered])"
    );
    if (blocks.length === 0) return;

    let cancelled = false;
    blocks.forEach((block) => {
      const encoded =
        block.getAttribute("data-math-source") ||
        block.getAttribute("data-math-source-md") ||
        "";
      const display = block.getAttribute("data-math-display") === "1";
      let source = "";
      try {
        source = decodeURIComponent(escape(atob(encoded)));
      } catch {
        source = "";
      }
      block.setAttribute("data-rendered", "1");
      renderKatex(source, { displayMode: display }).then((res) => {
        if (cancelled) return;
        if (res.error) {
          // 错误展示：行内/块级共用同一类名，由 CSS 控制差异
          block.innerHTML = `
            <span class="shared-math-error">
              <span class="shared-math-error-title">LaTeX 错误</span>
              <code class="shared-math-error-src">${escapeHtml(source)}</code>
              <span class="shared-math-error-msg">${escapeHtml(res.error)}</span>
            </span>
          `;
        } else {
          block.innerHTML = res.html;
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [content?.content, isEditing]);





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
   * - 如果当前访问者就是笔记作者本人，**跳过昵称弹窗**直接进入编辑模式，
   *   保存时会自动以作者的 displayName/username 作为 guestName 提交。
   * - 否则：没有昵称弹昵称输入框；提交后才真正进入编辑模式
   * - 已有昵称：直接进入编辑模式
   */
  const handleStartEditing = useCallback(() => {
    if (!content) return;
    // 支持 edit / edit_auth 两档；其他权限拒绝
    const isEditable = content.permission === "edit" || content.permission === "edit_auth";
    if (!isEditable) return;
    if (content.isLocked) {
      setSaveError("笔记已被所有者锁定，暂不可编辑");
      setSaveStatus("error");
      return;
    }
    // edit_auth 前置门禁：检查浏览器是否已有 nowen-token；没有就直接跳登录页，
    // 不要让用户输完昵称再被服务端 401 弹回——体验会很差。
    // 真正的合法性校验在后端 PUT /shared/:token/content 里二次确认（防绕过）。
    if (content.permission === "edit_auth") {
      let hasToken = false;
      try { hasToken = !!localStorage.getItem("nowen-token"); } catch { /* ignore */ }
      if (!hasToken) {
        const redirect = encodeURIComponent(`/share/${shareToken}`);
        window.location.assign(`/login?redirect=${redirect}`);
        return;
      }
    }
    // 作者本人访问自己的分享链接：免填昵称
    if (isOwnerViewing) {
      // 给 guestName 兜底一个值（用于审计 changeSummary）：
      // 优先 displayName/username，否则给个固定 "作者" 字样，避免后端 GUEST_NAME_REQUIRED
      const ownerLabel = viewerDisplayName.trim() || "作者";
      if (!guestNameRef.current.trim()) {
        // 注意：这里**不**写入 localStorage，避免污染同浏览器的访客昵称缓存
        setGuestName(ownerLabel);
        guestNameRef.current = ownerLabel;
      }
      setIsEditing(true);
      return;
    }
    if (!guestNameRef.current.trim()) {
      setNicknameDraft("");
      setNicknameError("");
      setShowNicknameModal(true);
      return;
    }
    setIsEditing(true);
  }, [content, isOwnerViewing, viewerDisplayName, shareToken]);

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
  const handleGuestSave = useCallback(async (data: NoteEditorUpdatePayload) => {
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
          // NoteEditorUpdatePayload.content / contentText 在 CRDT 模式下可能缺省；
          // updateSharedContent 目前签名要求 string，这里兜底为 ""（相当于无变更提交）。
          content: data.content ?? "",
          contentText: data.contentText ?? "",
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
      } else if (e?.code === "LOGIN_REQUIRED") {
        // edit_auth 权限：未登录用户的写入会被后端拒绝。
        // 引导用户跳到登录页，附带 redirect 参数让登录成功后自动回到本分享页。
        // 用 window.location.assign 而非 history.pushState：因为登录页是
        // AuthGate 接管的整页路由，需要硬切才能正确触发；返回时也借浏览器
        // 后退或登录成功后的 redirect 跳转回来。
        setSaveError("此分享需登录后才能编辑，正在跳转登录页…");
        setIsEditing(false);
        const redirect = encodeURIComponent(`/share/${shareToken}`);
        // 给用户一点时间看到提示再跳
        setTimeout(() => {
          window.location.assign(`/login?redirect=${redirect}`);
        }, 800);
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
      workspaceId: null,
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

  const isReadOnlyContent = !(isEditing && (content?.permission === "edit" || content?.permission === "edit_auth"));

  useEffect(() => {
    if (!isReadOnlyContent) {
      setOutlineHeadings([]);
      setActiveOutlineId("");
      desktopOutlineItemRefs.current.clear();
      mobileOutlineItemRefs.current.clear();
      return;
    }

    const host = pmRenderRef.current;
    if (!host || !content?.content) {
      setOutlineHeadings([]);
      setActiveOutlineId("");
      return;
    }

    const usedIds = new Set<string>();
    const headings = Array.from(host.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6"))
      .map((heading, index) => {
        const level = Number(heading.tagName.slice(1)) || 1;
        const currentId = heading.id.trim();
        let id = currentId || `shared-heading-${index}`;
        let fallbackIndex = index;
        while (usedIds.has(id)) {
          id = `shared-heading-${fallbackIndex++}`;
        }
        usedIds.add(id);
        if (heading.id !== id) heading.id = id;
        return {
          id,
          level,
          text: heading.textContent?.trim() || `H${level}`,
        };
      });

    setOutlineHeadings((prev) => {
      const unchanged =
        prev.length === headings.length &&
        prev.every((item, index) => {
          const next = headings[index];
          return item.id === next.id && item.level === next.level && item.text === next.text;
        });
      return unchanged ? prev : headings;
    });
    setActiveOutlineId((prev) => headings.some((heading) => heading.id === prev) ? prev : headings[0]?.id || "");
  }, [content?.content, isReadOnlyContent]);

  useEffect(() => {
    const root = pageScrollRef.current;
    if (!root || outlineHeadings.length === 0 || !isReadOnlyContent) return;

    let rafId = 0;
    const updateActiveHeading = () => {
      rafId = 0;
      const rootTop = root.getBoundingClientRect().top;
      const activationLine = rootTop + SHARE_HEADER_OFFSET_PX + 24;
      let nextActive = outlineHeadings[0]?.id || "";

      for (const heading of outlineHeadings) {
        const el = document.getElementById(heading.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= activationLine) {
          nextActive = heading.id;
        } else {
          break;
        }
      }

      setActiveOutlineId((prev) => (prev === nextActive ? prev : nextActive));
    };
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(updateActiveHeading);
    };

    scheduleUpdate();
    root.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      root.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [outlineHeadings, isReadOnlyContent]);

  useEffect(() => {
    if (!activeOutlineId) return;
    const keepVisible = (
      container: HTMLDivElement | null,
      item: HTMLButtonElement | undefined
    ) => {
      if (!container || !item) return;
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      if (itemRect.top < containerRect.top) {
        container.scrollTop -= containerRect.top - itemRect.top;
      } else if (itemRect.bottom > containerRect.bottom) {
        container.scrollTop += itemRect.bottom - containerRect.bottom;
      }
    };

    keepVisible(desktopOutlineScrollRef.current, desktopOutlineItemRefs.current.get(activeOutlineId));
    keepVisible(mobileOutlineScrollRef.current, mobileOutlineItemRefs.current.get(activeOutlineId));
  }, [activeOutlineId]);

  useEffect(() => {
    if (isReadOnlyContent && outlineHeadings.length > 0) return;
    setIsMobileOutlineOpen(false);
  }, [isReadOnlyContent, outlineHeadings.length]);

  useEffect(() => {
    if (!isMobileOutlineOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMobileOutlineOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobileOutlineOpen]);

  const handleOutlineSelect = useCallback((headingId: string, closeMobile = false) => {
    const target = document.getElementById(headingId);
    if (!target) return;
    setActiveOutlineId(headingId);
    if (closeMobile) setIsMobileOutlineOpen(false);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);


  // 分享页内的复制代码按钮事件委托，以及 mailto/tel 链接拦截、图片预览
  const handleSharedContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // ---- 0. 点击图片时打开 lightbox 预览 ----
    const img = target.closest("img") as HTMLImageElement | null;
    if (img && img.closest(".shared-note-content")) {
      e.preventDefault();
      setLightboxImage({ src: img.currentSrc || img.src, alt: img.alt || "" });
      return;
    }

    // ---- 1. 拦截 mailto: / tel: / sms: 等会唤起系统客户端的链接 ----
    // 笔记里常会出现邮箱地址（作者信息、联系方式等），autolink 后变成
    // <a href="mailto:xxx">；用户在阅读时若误点，会直接唤起邮件客户端，
    // 非常打断体验。改为阻止默认行为，把地址写入剪贴板并 toast 提示。
    const anchor = target.closest("a") as HTMLAnchorElement | null;
    if (anchor) {
      const href = anchor.getAttribute("href") || "";
      const lower = href.toLowerCase();
      // ---- 1a. 脚注跳转：`<a href="#fn-id" data-footnote-jump>` 或
      //          `<a href="#fnref-id" data-footnote-back>` ----
      // 阻止默认的 hash 跳转（会刷新 URL 且无平滑动画），改为手动滚动 + 高亮
      const fnJump = anchor.getAttribute("data-footnote-jump");
      const fnBack = anchor.getAttribute("data-footnote-back");
      if (fnJump || fnBack) {
        e.preventDefault();
        const id = fnJump || fnBack || "";
        const targetId = fnJump ? `fn-${id}` : `fnref-${id}`;
        // 使用 getElementById 比 querySelector + CSS.escape 更稳，identifier
        // 在生成 HTML 时已经过 escapeHtml 但作为 id 选择器仍可能不合法
        const dest = document.getElementById(targetId);
        if (dest) {
          dest.scrollIntoView({ behavior: "smooth", block: "center" });
          dest.classList.add("shared-footnote-flash");
          window.setTimeout(
            () => dest.classList.remove("shared-footnote-flash"),
            1200
          );
        }
        return;
      }
      if (lower.startsWith("mailto:") || lower.startsWith("tel:") || lower.startsWith("sms:")) {
        e.preventDefault();
        // 去掉协议头展示更友好的明文
        const plain = href.replace(/^(mailto:|tel:|sms:)/i, "").split("?")[0];
        const label = lower.startsWith("mailto:") ? "邮箱" : lower.startsWith("tel:") ? "电话" : "号码";
        try {
          if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(plain).then(
              () => toast.success(`已复制${label}：${plain}`),
              () => toast.info(`${label}：${plain}`),
            );
          } else {
            toast.info(`${label}：${plain}`);
          }
        } catch {
          toast.info(`${label}：${plain}`);
        }
        return;
      }
    }

    // ---- 2. 代码块复制按钮 ----
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

  const showOutline = isReadOnlyContent && outlineHeadings.length > 0;
  const showDesktopOutline = showOutline && isDesktopOutlineOpen;
  const renderOutlineItems = (
    itemRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>,
    closeMobileOnSelect = false
  ) => outlineHeadings.map((heading) => {
    const active = heading.id === activeOutlineId;
    return (
      <button
        key={heading.id}
        ref={(node) => {
          if (node) itemRefs.current.set(heading.id, node);
          else itemRefs.current.delete(heading.id);
        }}
        type="button"
        aria-current={active ? "true" : undefined}
        title={heading.text}
        onClick={() => handleOutlineSelect(heading.id, closeMobileOnSelect)}
        className={cn(
          "shared-note-outline-item",
          active && "shared-note-outline-item-active",
          heading.level === 1 && "font-semibold text-zinc-800 dark:text-zinc-100",
          heading.level > 1 && "text-zinc-500 dark:text-zinc-400"
        )}
        style={{ paddingLeft: `${(heading.level - 1) * 12 + 12}px` }}
      >
        <span className="shared-note-outline-dot" />
        <span className="truncate">{heading.text}</span>
      </button>
    );
  });

  return (
    <div
      ref={pageScrollRef}
      className="min-h-screen bg-zinc-50 dark:bg-zinc-950 overflow-y-auto"
      style={{ height: "100vh", "--share-header-offset": `${SHARE_HEADER_OFFSET_PX}px` } as React.CSSProperties}
    >
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
            {showOutline && (
              <button
                type="button"
                onClick={() => setIsMobileOutlineOpen(true)}
                className="lg:hidden flex items-center gap-1.5 px-2 py-1 text-[10px] rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                aria-haspopup="dialog"
                aria-expanded={isMobileOutlineOpen}
              >
                <ListTree size={12} />
                大纲
              </button>
            )}
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

            {/* 访客编辑：入口按钮 / 昵称徽章 / 保存状态
                permission === 'edit'      ：访客填昵称即可编辑
                permission === 'edit_auth' ：必须登录；点击编辑后若未登录会被后端 401，
                                              前端在 handleGuestSave 里捕获 LOGIN_REQUIRED 跳登录页 */}
            {(content.permission === "edit" || content.permission === "edit_auth") && !content.isLocked && (
              <>
                {isEditing ? (
                  <>
                    {/* 当前昵称小标签：
                        - 作者本人：显示"作者"徽章，不可改（点也没意义）
                        - 访客：可点击修改 */}
                    {isOwnerViewing ? (
                      <span className="hidden sm:flex items-center gap-1 px-2 py-1 text-[10px] rounded-md bg-indigo-500/10 text-indigo-500" title="你是这条笔记的作者">
                        <UserCircle2 size={11} />
                        <span>{viewerDisplayName || "作者"}（作者）</span>
                      </span>
                    ) : (
                      guestName && (
                        <span className="hidden sm:flex items-center gap-1 px-2 py-1 text-[10px] rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500" title="点击可修改昵称">
                          <UserCircle2 size={11} />
                          <button
                            onClick={() => { setNicknameDraft(guestName); setNicknameError(""); setShowNicknameModal(true); }}
                            className="hover:text-zinc-700 dark:hover:text-zinc-300"
                          >
                            {guestName}
                          </button>
                        </span>
                      )
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
              {content.permission === "view"
                ? "仅查看"
                : content.permission === "edit"
                ? "可编辑"
                : content.permission === "edit_auth"
                ? "可编辑（需登录）"
                : "可评论"}
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

      {/* 笔记内容：edit / edit_auth + isEditing 时走 TiptapEditor；否则继续走只读 HTML 渲染 */}
      <main
        className={cn(
          "mx-auto px-4 py-8",
          showDesktopOutline
            ? "max-w-6xl lg:grid lg:grid-cols-[minmax(0,56rem)_16rem] lg:gap-8 lg:items-start"
            : "max-w-4xl"
        )}
      >
        <section className="min-w-0">
          {isEditing && (content.permission === "edit" || content.permission === "edit_auth") && fakeNoteForEditing ? (
            <div className="shared-note-editor">
              <TiptapEditor
                note={fakeNoteForEditing}
                onUpdate={handleGuestSave}
                editable={!content.isLocked}
                isGuest
              />
            </div>
          ) : detectFormat(content.content) === "md" ? (
            // 新编辑器保存的 Markdown：用 react-markdown 渲染
            <div
              ref={pmRenderRef}
              className="shared-note-content prose prose-sm dark:prose-invert max-w-none
                prose-headings:text-zinc-800 dark:prose-headings:text-zinc-200
                prose-p:text-zinc-600 dark:prose-p:text-zinc-300
                prose-a:text-indigo-500
                prose-code:text-indigo-600 dark:prose-code:text-indigo-400
                prose-blockquote:border-indigo-300 dark:prose-blockquote:border-indigo-700
                prose-pre:bg-zinc-900 prose-pre:text-zinc-100
                prose-img:rounded-lg prose-img:border prose-img:border-zinc-200 dark:prose-img:border-zinc-800"
              onClick={handleSharedContentClick}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                // rehype-raw 让 raw HTML（math 占位）能透传过 mdast→hast 阶段，
                // 否则 ReactMarkdown 默认会丢弃 raw HTML 节点。
                rehypePlugins={[rehypeRaw]}
                components={{
                  // 拦截 mermaid 围栏代码块：react-markdown 把 ```mermaid 渲染成
                  // <pre><code class="language-mermaid">...</code></pre>。我们识别
                  // 出 language-mermaid 后用 MermaidView 直接出 SVG，其它语言保持
                  // 默认行为（依赖 prose 样式）。
                  code({ inline, className, children, ...props }: any) {
                    const langMatch = /language-([\w-]+)/.exec(className || "");
                    const lang = langMatch?.[1] || "";
                    if (!inline && isMermaidLang(lang)) {
                      return <MermaidView source={String(children).replace(/\n$/, "")} debounceMs={0} />;
                    }
                    return (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  },
                  // 图片：有 width 时输出 inline style 控制缩放宽度
                  img({ src, alt, ...imgProps }: any) {
                    const resolvedSrc = resolveAttachmentUrl(String(src || ""));
                    const rawW = imgProps?.width || imgProps?.["data-width"];
                    const w = typeof rawW === "number" && rawW > 0
                      ? Math.round(rawW)
                      : typeof rawW === "string" && /^\d+(?:\.\d+)?$/.test(rawW.trim())
                        ? Math.round(Number(rawW))
                        : null;
                    return (
                      <img
                        {...imgProps}
                        src={resolvedSrc}
                        alt={String(alt || "")}
                        width={w || undefined}
                        style={{
                          width: w ? `${w}px` : undefined,
                          maxWidth: "100%",
                          height: "auto",
                          cursor: "zoom-in",
                        }}
                      />
                    );
                  },
                }}
              >
                {preprocessMarkdownMath(
                  preprocessMarkdownFootnotes(
                    content.content,
                    computeFootnoteOrderFromMarkdown(content.content)
                  )
                )}
              </ReactMarkdown>
            </div>
          ) : (
            <div
              ref={pmRenderRef}
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
        </section>

        {showDesktopOutline && (
          <aside className="shared-note-outline hidden lg:block">
            <div className="shared-note-outline-header">
              <div className="flex items-center gap-2 min-w-0">
                <ListTree size={14} className="text-indigo-500" />
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">大纲</span>
              </div>
              <button
                type="button"
                onClick={() => setIsDesktopOutlineOpen(false)}
                className="shared-note-outline-collapse"
                aria-label="收起大纲"
              >
                收起
              </button>
            </div>
            <div ref={desktopOutlineScrollRef} className="shared-note-outline-scroll py-2">
              {renderOutlineItems(desktopOutlineItemRefs)}
            </div>
          </aside>
        )}
      </main>

      {showOutline && !isDesktopOutlineOpen && (
        <button
          type="button"
          onClick={() => setIsDesktopOutlineOpen(true)}
          className="shared-note-outline-floating hidden lg:flex"
          aria-label="展开大纲"
        >
          <ListTree size={14} />
          大纲
        </button>
      )}

      {showOutline && isMobileOutlineOpen && (
        <div
          className="shared-note-outline-mobile lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="大纲"
          onClick={() => setIsMobileOutlineOpen(false)}
        >
          <div className="shared-note-outline-mobile-panel" onClick={(event) => event.stopPropagation()}>
            <div className="shared-note-outline-header">
              <div className="flex items-center gap-2 min-w-0">
                <ListTree size={15} className="text-indigo-500" />
                <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">大纲</span>
              </div>
              <button
                type="button"
                onClick={() => setIsMobileOutlineOpen(false)}
                className="shared-note-outline-close"
                aria-label="关闭大纲"
              >
                <X size={15} />
              </button>
            </div>
            <div ref={mobileOutlineScrollRef} className="shared-note-outline-scroll shared-note-outline-mobile-scroll py-2">
              {renderOutlineItems(mobileOutlineItemRefs, true)}
            </div>
          </div>
        </div>
      )}

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

      {/* 图片预览 Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[150] bg-black/80 flex items-center justify-center"
          onClick={() => setLightboxImage(null)}
        >
          <button
            onClick={() => setLightboxImage(null)}
            className="absolute top-3 right-3 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
            aria-label="关闭预览"
          >
            <X size={18} />
          </button>
          <img
            src={lightboxImage.src}
            alt={lightboxImage.alt || ""}
            className="max-w-[92vw] max-h-[88vh] object-contain select-none"
            onClick={(e) => e.stopPropagation()}
            draggable={false}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 将编辑器的 JSON content 渲染为 HTML
 * 如果 content 是 JSON 格式（Tiptap），尝试简单渲染
 * 如果是纯 HTML 字符串，直接返回
 *
 * 注意：此函数会被 dangerouslySetInnerHTML 消费，任何抛出都会让分享页白屏。
 * 因此无论 JSON 解析还是 Tiptap 节点遍历失败，都要兜底返回可显示的文本。
 */
function renderContent(content: string): string {
  if (!content) return "";

  const trimmed = content.trim();

  // 尝试解析 JSON (Tiptap editor JSON format)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed);
      if (json && typeof json === "object" && json.type === "doc" && json.content) {
        try {
          return renderTiptapJSON(json);
        } catch (err) {
          console.error("[SharedNoteView] renderTiptapJSON failed, fallback to escaped text:", err);
          return `<p>${escapeHtml(content)}</p>`;
        }
      }
    } catch {
      // 不是合法 JSON，继续当作 HTML / 纯文本处理
    }
  }

  // 如果明显是 HTML（<tag> 开头），直接透传；否则做转义后包一层 <p>
  if (trimmed.startsWith("<") && /<\w+[\s>]/.test(trimmed)) {
    return content;
  }
  return `<p>${escapeHtml(content)}</p>`;
}

/** 简单的 Tiptap JSON → HTML 渲染器 */
function renderTiptapJSON(doc: any): string {
  if (!doc.content) return "";
  // 预扫文档：建立 footnote identifier → 显示序号映射，供 renderNode 同步读取
  _footnoteOrderMap = computeFootnoteOrderFromTiptap(doc);
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

/**
 * 分享页 MD 路径专用：把 Markdown 文本里的 `$...$` / `$$...$$` 数学公式
 * 在交给 ReactMarkdown 之前替换成 raw HTML 占位（`<span data-math-source-md=...>`
 * / `<div data-math-source-md=...>`）。配合 rehype-raw 让 ReactMarkdown 透传
 * 这些 HTML 元素，最后由统一的 useEffect 扫描并异步注入 KaTeX。
 *
 * 与 contentFormat.ts 里的 `extractMathPlaceholders` 思路一致，但这里直接
 * 输出 raw HTML（而不是 NUL 占位），因为 ReactMarkdown 不接受非标准占位符。
 *
 * 启发式与编辑器侧一致：
 *   - 先抽块级 `$$...$$`（允许跨行）
 *   - 再抽行内 `$...$`（不允许换行，且前一字符非 `\`，避免 `\$` 转义）
 *   - 在围栏代码块（```...```）内部不处理，避免代码示例里的 `$ ` 被误识别
 */
function preprocessMarkdownMath(md: string): string {
  if (!md) return md;
  // 把 fenced code 段抠出来用占位先保存，处理完 math 再还原。
  // 这一步必须，否则代码示例（如 shell 提示符 `$ ls`）会被吞。
  const codeStash: string[] = [];
  let text = md.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => {
    const idx = codeStash.push(m) - 1;
    return `\u0000CODE${idx}\u0000`;
  });

  // 块级公式
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, body) => {
    let encoded = "";
    try {
      encoded = window.btoa(unescape(encodeURIComponent(String(body).trim())));
    } catch {
      encoded = "";
    }
    // 注意：data-math-source-md 与 PM 路径的 data-math-source 区分，避免 useEffect
    // 同时扫到两套占位（PM 路径生成的占位用 data-math-source）。
    // 用 `<div>` 块级 + 前后空行确保被 markdown 当独立块级 HTML。
    return `\n\n<div class="shared-math-block" data-math-source-md="${encoded}" data-math-display="1"></div>\n\n`;
  });

  // 行内公式
  text = text.replace(
    /(^|[^\\$\w])\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$(?=$|[^\w$])/g,
    (_m, pre, body) => {
      let encoded = "";
      try {
        encoded = window.btoa(unescape(encodeURIComponent(String(body))));
      } catch {
        encoded = "";
      }
      return `${pre}<span class="shared-math-inline" data-math-source-md="${encoded}" data-math-display="0"></span>`;
    }
  );

  // 还原代码段
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeStash[Number(idx)] || "");
  return text;
}

/**
 * 分享页 MD 路径专用：把 Markdown 文本里的脚注引用 `[^id]` 与定义 `[^id]: ...`
 * 替换成 raw HTML 占位（`<sup data-footnote-ref>` / `<div data-footnote-def>`），
 * 配合 rehype-raw 让 ReactMarkdown 透传。renderContent 时还要先扫一遍 markdown
 * 决定 identifier → 显示序号映射（按引用出现顺序），随后的 useEffect 再做点击
 * 跳转交互。
 *
 * 与编辑器侧的 `extractFootnotePlaceholders` 思路一致，但这里直接输出 raw HTML
 * （ReactMarkdown 不接受非标准占位符）。
 *
 * 调用方需要先调用 `computeFootnoteOrderFromMarkdown` 拿到序号 map，然后传进来。
 */
function preprocessMarkdownFootnotes(
  md: string,
  orderMap: Record<string, number>
): string {
  if (!md) return md;
  // 保护围栏代码块
  const codeStash: string[] = [];
  let text = md.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => {
    const idx = codeStash.push(m) - 1;
    return `\u0000FNMDCODE${idx}\u0000`;
  });

  // 抽脚注定义（行首），按行扫
  const lines = text.split("\n");
  const outLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\[\^([A-Za-z0-9_-]+)\]:\s?(.*)$/);
    if (m) {
      const id = m[1];
      const parts: string[] = [m[2] || ""];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (/^(\s{4}|\t)/.test(nxt)) {
          parts.push(nxt.replace(/^(\s{4}|\t)/, ""));
          j++;
        } else if (nxt.trim() === "") {
          if (j + 1 < lines.length && /^(\s{4}|\t)/.test(lines[j + 1])) {
            parts.push("");
            j++;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      const content = parts.join("\n").trim();
      const order = orderMap[id] || 0;
      const encId = String(id).replace(/"/g, "&quot;");
      const encContent = escapeHtml(content);
      // 用 raw HTML 块表示一个脚注定义。前后空行确保 ReactMarkdown 当独立块。
      outLines.push(
        `\n<div class="shared-footnote-def" data-footnote-def="${encId}" data-footnote-order="${order}"><span class="shared-footnote-def-marker"><a href="#fnref-${encId}" class="shared-footnote-back" data-footnote-back="${encId}" title="跳回">↩</a><span class="shared-footnote-def-index">${order || "?"}.</span></span><span class="shared-footnote-def-content">${encContent}</span></div>\n`
      );
      i = j - 1;
    } else {
      outLines.push(line);
    }
  }
  text = outLines.join("\n");

  // 抽脚注引用 `[^id]`（保护行内代码）
  const inlineCodeStash: string[] = [];
  text = text.replace(/`[^`\n]+`/g, (m) => {
    const idx = inlineCodeStash.push(m) - 1;
    return `\u0000FNMDICODE${idx}\u0000`;
  });
  text = text.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (_m, id) => {
    const order = orderMap[id] || 0;
    const encId = String(id).replace(/"/g, "&quot;");
    return `<sup class="shared-footnote-ref" id="fnref-${encId}" data-footnote-ref="${encId}" data-footnote-order="${order}"><a href="#fn-${encId}" data-footnote-jump="${encId}">[${order || "?"}]</a></sup>`;
  });
  text = text.replace(/\u0000FNMDICODE(\d+)\u0000/g, (_m, idx) => inlineCodeStash[Number(idx)] || "");
  text = text.replace(/\u0000FNMDCODE(\d+)\u0000/g, (_m, idx) => codeStash[Number(idx)] || "");

  return text;
}

/**
 * 扫描 markdown 文本，按 `[^id]` 引用首次出现顺序生成 identifier → 序号 map。
 * 同步扫描定义里被引用但未在正文显示的脚注（仍然按其在 markdown 中第一次
 * 见到的顺序编号，与 Pandoc 保持一致）。
 */
function computeFootnoteOrderFromMarkdown(md: string): Record<string, number> {
  if (!md) return {};
  // 移除围栏代码块再扫
  const stripped = md.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const order: string[] = [];
  // 先扫引用
  const refRe = /\[\^([A-Za-z0-9_-]+)\](?!:)/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(stripped)) !== null) {
    if (!order.includes(m[1])) order.push(m[1]);
  }
  // 再扫定义（兜底：只有定义无引用的也给序号）
  const defRe = /^\[\^([A-Za-z0-9_-]+)\]:/gm;
  while ((m = defRe.exec(stripped)) !== null) {
    if (!order.includes(m[1])) order.push(m[1]);
  }
  const out: Record<string, number> = {};
  order.forEach((id, idx) => (out[id] = idx + 1));
  return out;
}

/**
 * 扫描 Tiptap PM 文档，按 footnoteReference 出现顺序生成序号 map。
 * 用于 PM 路径 renderNode 时统一编号。
 */
function computeFootnoteOrderFromTiptap(doc: any): Record<string, number> {
  const order: string[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === "footnoteReference") {
      const id = node.attrs?.identifier || "";
      if (id && !order.includes(id)) order.push(id);
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  // 兜底：扫一遍 def，让无引用的 def 也有序号
  const walkDefs = (node: any) => {
    if (!node) return;
    if (node.type === "footnoteDefinition") {
      const id = node.attrs?.identifier || "";
      if (id && !order.includes(id)) order.push(id);
    }
    if (Array.isArray(node.content)) node.content.forEach(walkDefs);
  };
  walkDefs(doc);
  const out: Record<string, number> = {};
  order.forEach((id, idx) => (out[id] = idx + 1));
  return out;
}

// 模块级：renderTiptapJSON 入口时填好的序号 map，供 renderNode 同步读取
let _footnoteOrderMap: Record<string, number> = {};

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
    case "mathInline":
    case "mathBlock": {
      // 数学公式：与 mermaid 同套路——renderNode 是同步 string 输出，没法在这
      // 里直接 await katex 渲染，所以先吐占位 + base64 编码的源码，外面的
      // useEffect 扫描后异步注入 KaTeX HTML。
      const latex = node.attrs?.latex || "";
      const display = node.type === "mathBlock";
      let encoded = "";
      try {
        encoded =
          typeof window !== "undefined"
            ? window.btoa(unescape(encodeURIComponent(latex)))
            : Buffer.from(latex, "utf-8").toString("base64");
      } catch {
        encoded = "";
      }
      const tag = display ? "div" : "span";
      const cls = display ? "shared-math-block" : "shared-math-inline";
      return `<${tag} class="${cls}" data-math-source="${encoded}" data-math-display="${display ? "1" : "0"}"><${tag} class="shared-math-loading">$${display ? "$" : ""}${escapeHtml(latex)}$${display ? "$" : ""}</${tag}></${tag}>`;
    }
    case "footnoteReference": {
      const id = node.attrs?.identifier || "";
      const order = _footnoteOrderMap[id] || 0;
      const encId = escapeHtml(id);
      return `<sup class="shared-footnote-ref" id="fnref-${encId}" data-footnote-ref="${encId}" data-footnote-order="${order}"><a href="#fn-${encId}" data-footnote-jump="${encId}">[${order || "?"}]</a></sup>`;
    }
    case "footnoteDefinition": {
      const id = node.attrs?.identifier || "";
      const content = node.attrs?.content || "";
      const order = _footnoteOrderMap[id] || 0;
      const encId = escapeHtml(id);
      return `<div class="shared-footnote-def" id="fn-${encId}" data-footnote-def="${encId}" data-footnote-order="${order}"><span class="shared-footnote-def-marker"><a href="#fnref-${encId}" class="shared-footnote-back" data-footnote-back="${encId}" title="跳回">↩</a><span class="shared-footnote-def-index">${order || "?"}.</span></span><span class="shared-footnote-def-content">${escapeHtml(content)}</span></div>`;
    }
    case "blockquote":
      return `<blockquote>${renderChildren(node)}</blockquote>`;
    case "horizontalRule":
      return "<hr />";
    case "image": {
      const src = resolveAttachmentUrl(node.attrs?.src || "");
      const alt = node.attrs?.alt || "";
      const raw = node.attrs?.width;
      const w = typeof raw === "number" && Number.isFinite(raw) && raw > 0
        ? Math.round(raw)
        : typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim())
          ? Math.round(Number(raw))
          : null;
      const wAttr = w ? ` width="${w}"` : "";
      const style = w
        ? ` style="width:${w}px;max-width:100%;height:auto"`
        : ` style="max-width:100%;height:auto"`;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${wAttr}${style} />`;
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
            case "textStyle": {
              // 字号 / 前景色：渲染为 <span style="font-size:..;color:..">
              // 与编辑器侧 FontSizeExtension 的 renderHTML 输出保持一致
              const styles: string[] = [];
              const fs = mark.attrs?.fontSize;
              const color = mark.attrs?.color;
              if (fs && /^[\d.]+(px|em|rem|%)$/.test(String(fs))) {
                styles.push(`font-size:${fs}`);
              }
              if (color && /^[#a-zA-Z0-9(),.\s%]+$/.test(String(color))) {
                styles.push(`color:${color}`);
              }
              if (styles.length) {
                text = `<span style="${escapeHtml(styles.join(";"))}">${text}</span>`;
              }
              break;
            }
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
 *
 * 特殊处理 mermaid：分享页 PM 路径整段是 dangerouslySetInnerHTML 输出，
 * 没法直接渲染 React 子树，所以这里只输出一个带 `data-mermaid-source`
 * 的占位 div + 原始源码（base64 编码避免 HTML 注入冲突）。
 * 真正的 SVG 由 useEffect 扫描后用 renderMermaid 注入。
 */
function renderCodeBlock(node: any): string {
  const rawLang = node.attrs?.language;
  const langLabel = !rawLang || rawLang === "auto" ? "auto" : String(rawLang).toLowerCase();
  const codeText = (node.content || []).map((c: any) => c.text || "").join("");

  // mermaid 分支：输出占位让外层异步注入 SVG
  if (isMermaidLang(langLabel)) {
    // base64 编码源码，避免双引号、& 等字符破坏属性
    let encoded = "";
    try {
      encoded =
        typeof window !== "undefined"
          ? window.btoa(unescape(encodeURIComponent(codeText)))
          : Buffer.from(codeText, "utf-8").toString("base64");
    } catch {
      encoded = "";
    }
    return `
<div class="shared-mermaid-block" data-mermaid-source="${encoded}">
  <div class="shared-mermaid-loading">渲染流程图...</div>
</div>
`.trim();
  }

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

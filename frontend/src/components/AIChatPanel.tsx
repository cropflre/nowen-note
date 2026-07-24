import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Bot, Send, Trash2, X, Loader2, FileText, Sparkles, User,
  BookOpen, Database, MessageCircleQuestion, ArrowRight,
  Upload, FileUp, Wand2, FolderUp, Check, Copy, ChevronDown, ChevronUp,
  Paperclip, Plus, MessageSquare, Menu, Pencil
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/store/AppContext";

// AI 知识库引用。v8 起区分 note / attachment：
//   - note：点击跳转到笔记（onNavigateToNote）
//   - attachment：点击下载附件（/api/attachments/:id?download=1）
interface ChatReference {
  id: string;
  title: string;
  kind?: "note" | "attachment";
  attachmentId?: string;
  attachmentFilename?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: ChatReference[];
  isStreaming?: boolean;
}

interface KnowledgeStats {
  noteCount: number;
  ftsCount: number;
  notebookCount: number;
  tagCount: number;
  recentTopics: string[];
  indexed: boolean;
}

// 对话记录持久化：改为后端持久化（见 /api/ai/chat-history），
// 优势：多端同步、不受浏览器 storage 限制、账号隔离。
// v10 起支持多会话（ai_chat_conversations）：左侧是会话列表，右侧是当前会话消息。
// 本组件职责：拉取会话列表、切换会话、增删改会话、拉/追加/清空会话消息。
const HISTORY_LIMIT = 100;

// 会话列表条目（对应 /api/ai/conversations 返回的单条 conversation）
interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string | null;
  lastRole: string | null;
}

// 根据首条消息内容生成会话标题（截断 + 去多余空白）。
// 没标题时前端展示 i18n 的"新对话"，这里是用户发出第一个问题后用问题前 20 字自动命名。
const deriveTitleFromQuestion = (q: string) => q.trim().replace(/\s+/g, " ").slice(0, 20);

export default function AIChatPanel({ onClose, onNavigateToNote }: {
  onClose: () => void;
  onNavigateToNote?: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  // 历史加载中：避免首次渲染闪一下"空状态"然后再跳到历史
  const [historyLoading, setHistoryLoading] = useState(true);

  // ===== 多会话相关 state =====
  // conversations: 会话列表；currentConvId: 当前激活的会话 id；
  // sidebarOpen: 侧栏展开（移动/窄屏默认收起，点按钮展开）；
  // renamingId / renameDraft: 行内重命名状态。
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // 知识库范围
  const { state: appState } = useApp();
  const [nbScope, setNbScope] = useState<"all" | "notebook">("all");
  const [nbScopeId, setNbScopeId] = useState<string>("");
  const [nbIncludeChildren, setNbIncludeChildren] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 加载知识库统计
  // v7：切换工作区会换一份索引 scope，必须重拉；不重拉的话 UI 还显示
  // 切换前的"个人空间笔记数 / 已索引"，给人"工作区里没东西"的错觉。
  useEffect(() => {
    const reload = () => {
      api.getKnowledgeStats().then(setStats).catch(() => {});
    };
    reload();
    window.addEventListener("nowen:workspace-changed", reload);
    return () => {
      window.removeEventListener("nowen:workspace-changed", reload);
    };
  }, []);

  // 拉会话列表。失败（未登录 / 老后端未部署）退回空列表，不阻塞聊天。
  const reloadConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    try {
      const res = await api.aiConversations.list();
      setConversations(res.conversations);
      return res.conversations;
    } catch {
      setConversations([]);
      return [];
    }
  }, []);

  // 初始化：拉会话列表 → 选最近一条 → 拉它的消息。
  // 如果用户还没有任何会话（新用户或迁移前），消息列表保持空、currentConvId 为 null；
  // 首次发送时会通过 POST /chat-history 自动创建"默认会话"（后端兜底）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await reloadConversations();
      if (cancelled) return;

      // 选择激活会话：优先 list[0]（updatedAt 最新），否则保持 null 等待首次发送
      const targetId = list.length > 0 ? list[0].id : null;
      setCurrentConvId(targetId);

      if (!targetId) {
        setHistoryLoading(false);
        return;
      }

      try {
        const res = await api.getAiChatHistory(HISTORY_LIMIT, targetId);
        if (cancelled) return;
        setMessages(res.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          references: m.references,
        })));
      } catch {
        /* ignore：首次使用或离线状态 */
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadConversations]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 切换会话：拉目标会话的消息。
  // 流式中不允许切换（会把 assistant 的增量写到错误会话）；上层按钮 disabled 阻挡。
  const handleSelectConversation = useCallback(async (convId: string) => {
    if (isLoading || convId === currentConvId) return;
    setCurrentConvId(convId);
    setMessages([]);
    setHistoryLoading(true);
    try {
      const res = await api.getAiChatHistory(HISTORY_LIMIT, convId);
      setMessages(res.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        references: m.references,
      })));
    } catch {
      /* ignore */
    } finally {
      setHistoryLoading(false);
    }
  }, [isLoading, currentConvId]);

  // 新建会话：成功后立即切到它。若创建失败，降级为"清空当前消息"的本地效果，
  // 至少不阻断使用——用户下一次发送时后端会兜底创建。
  const handleNewConversation = useCallback(async () => {
    if (isLoading) return;
    try {
      const res = await api.aiConversations.create();
      const created = res.conversation;
      setConversations(prev => [created, ...prev]);
      setCurrentConvId(created.id);
      setMessages([]);
    } catch {
      // 后端未部署 / 离线：前端先给空会话体验，后续 append 会自动建
      setCurrentConvId(null);
      setMessages([]);
    }
  }, [isLoading]);

  // 行内重命名：进入/取消/提交三个动作
  const handleStartRename = (conv: ConversationSummary) => {
    setRenamingId(conv.id);
    setRenameDraft(conv.title || "");
  };
  const handleCancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };
  const handleSubmitRename = useCallback(async () => {
    if (!renamingId) return;
    const title = renameDraft.trim().slice(0, 100);
    try {
      await api.aiConversations.update(renamingId, { title });
      setConversations(prev => prev.map(c => c.id === renamingId ? { ...c, title } : c));
    } catch {
      /* ignore；保留原名 */
    } finally {
      setRenamingId(null);
      setRenameDraft("");
    }
  }, [renamingId, renameDraft]);

  const handleDeleteConversation = useCallback(async (convId: string) => {
    if (isLoading) return;
    // 项目统一的命令式 confirm 弹窗，与设置/孤儿附件清理等模块同款；
    // danger:true → 红色确认按钮 + 默认聚焦取消按钮，避免误删
    const ok = await confirmDialog({
      title: t("common.delete"),
      description: t("aiChat.deleteConversationConfirm"),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.aiConversations.remove(convId);
    } catch {
      /* 即便后端失败也按本地成功处理，避免 UI 卡住；下次打开会自动对齐 */
    }
    // 本地移除并选下一个可用会话
    const rest = conversations.filter(c => c.id !== convId);
    setConversations(rest);
    if (convId === currentConvId) {
      if (rest.length > 0) {
        await handleSelectConversation(rest[0].id);
      } else {
        setCurrentConvId(null);
        setMessages([]);
      }
    }
  }, [conversations, currentConvId, handleSelectConversation, isLoading, t]);

  const handleSend = useCallback(async (override?: string) => {
    const question = (override ?? input).trim();
    if (!question || isLoading) return;

    // 若当前没有激活会话（新用户首发 / 之前创建失败），先显式建一条新会话。
    // 现场建会话能保证前端立刻拿到 id，并让侧栏在第一条消息发送前就出现条目。
    let convId = currentConvId;
    if (!convId) {
      try {
        const res = await api.aiConversations.create();
        convId = res.conversation.id;
        setConversations(prev => [res.conversation, ...prev]);
        setCurrentConvId(convId);
      } catch {
        // 后端暂时不可用时降级：convId 仍为 null，后端 POST /chat-history 不传
        // conversationId 会兜底落到"最近活跃会话"，功能不中断。
      }
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: question,
    };

    const assistantMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      isStreaming: true,
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput("");
    setIsLoading(true);

    // 立即把用户消息持久化到后端，避免流式中途断开时这条提问丢失
    api.appendAiChatHistory({
      id: userMsg.id,
      conversationId: convId || undefined,
      role: "user",
      content: userMsg.content,
    }).catch(() => { /* 持久化失败不影响对话 */ });

    // 若当前会话还没有标题（新建会话的占位 ""），用问题前 20 字自动命名。
    // 只在第一次发送时改；后续用户可以手动重命名覆盖。
    if (convId) {
      const conv = conversations.find(c => c.id === convId);
      if (conv && !conv.title) {
        const autoTitle = deriveTitleFromQuestion(question);
        if (autoTitle) {
          api.aiConversations.update(convId, { title: autoTitle }).catch(() => {});
          setConversations(prev => prev.map(c => c.id === convId ? { ...c, title: autoTitle } : c));
        }
      }
    }

    // Build history from previous messages
    const history = messages
      .filter(m => !m.isStreaming)
      .map(m => ({ role: m.role, content: m.content }));

    // 收集流式期间累积的最终内容和 references，结束后一次性落库
    let finalContent = "";
    let finalRefs: ChatReference[] | undefined;

    try {
      await api.aiAsk(
        question,
        history,
        (chunk) => {
          finalContent += chunk;
          setMessages(prev => prev.map(m =>
            m.id === assistantMsg.id
              ? { ...m, content: m.content + chunk }
              : m
          ));
        },
        (refs) => {
          finalRefs = refs;
          setMessages(prev => prev.map(m =>
            m.id === assistantMsg.id
              ? { ...m, references: refs }
              : m
          ));
        },
        nbScope === "notebook" ? { notebookId: nbScopeId, includeChildren: nbIncludeChildren } : undefined
      );
    } catch (err: any) {
      finalContent = err.message || t("ai.requestFailed");
      setMessages(prev => prev.map(m =>
        m.id === assistantMsg.id
          ? { ...m, content: finalContent }
          : m
      ));
    } finally {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsg.id
          ? { ...m, isStreaming: false }
          : m
      ));
      setIsLoading(false);

      // 流式结束后把完整的 assistant 消息落库（含 references）。
      // 空内容时后端会跳过入库（见 /chat-history POST 对空内容的处理）。
      if (finalContent.trim().length > 0) {
        api.appendAiChatHistory({
          id: assistantMsg.id,
          conversationId: convId || undefined,
          role: "assistant",
          content: finalContent,
          references: finalRefs,
        }).catch(() => { /* 持久化失败不影响对话 */ });
      }

      // 流式结束后刷新会话列表：更新 updatedAt / lastMessage / messageCount，
      // 失败不处理——列表里的"最近活动时间"与"预览"是次要 UX。
      reloadConversations().catch(() => {});
    }
  }, [input, isLoading, messages, t, currentConvId, conversations, reloadConversations]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const clearChat = () => {
    setMessages([]);
    // 同步清空后端持久化记录（仅清当前会话的消息；会话本身保留便于保留标题）
    if (currentConvId) {
      api.clearAiChatHistory(currentConvId).catch(() => { /* ignore */ });
      // 本地更新会话列表的 messageCount / lastMessage
      setConversations(prev => prev.map(c =>
        c.id === currentConvId ? { ...c, messageCount: 0, lastMessage: null, lastRole: null } : c
      ));
    } else {
      // 兜底：没有 convId 时老后端会清"最近活跃会话"，等效于本地清空
      api.clearAiChatHistory().catch(() => { /* ignore */ });
    }
  };

  // ===== ③ 文档解析状态 =====
  const [docParsing, setDocParsing] = useState(false);
  const [docResult, setDocResult] = useState<string | null>(null);
  const [docFileName, setDocFileName] = useState("");
  const docInputRef = useRef<HTMLInputElement>(null);

  // 真正的"处理一个文件"逻辑。抽出来是为了让 <input type=file> change
  // 和拖拽 drop 两条入口走同一段代码——避免逻辑分叉。
  const doParseDocument = useCallback(async (file: File) => {
    setDocParsing(true);
    setDocFileName(file.name);
    setDocResult(null);
    try {
      const result = await api.parseDocument(file, { formatMode: "note" });
      setDocResult(result.markdown);
    } catch (err: any) {
      setDocResult(`❌ ${err.message}`);
    } finally {
      setDocParsing(false);
      if (docInputRef.current) docInputRef.current.value = "";
    }
  }, []);

  const handleDocUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void doParseDocument(file);
  }, [doParseDocument]);

  const handleCopyMarkdown = useCallback(() => {
    if (docResult) {
      navigator.clipboard.writeText(docResult);
    }
  }, [docResult]);

  // ===== ⑥ 知识库导入状态 =====
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 同样抽出"接收一组 File"的核心逻辑，让点击和拖拽复用
  const doKnowledgeImport = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setImportLoading(true);
    setImportResult(null);
    try {
      const result = await api.importToKnowledge(files);
      setImportResult(t("aiChat.importSuccess", { success: result.success, failed: result.failed }));
      // 刷新统计
      api.getKnowledgeStats().then(setStats).catch(() => {});
    } catch (err: any) {
      setImportResult(`❌ ${err.message}`);
    } finally {
      setImportLoading(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [t]);

  const handleKnowledgeImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    void doKnowledgeImport(Array.from(files));
  }, [doKnowledgeImport]);

  // ===== 拖拽上传支持 =====
  // 把两个上传卡片本身做成 dropzone：拖文件进去时高亮边框，松手即触发
  // 与点击按钮完全一致的处理流程（共用 doParseDocument / doKnowledgeImport）。
  // 用 counter 记 enter/leave 是因为子节点会冒泡 dragleave，单纯靠 boolean
  // 会在子元素切换时闪烁；累计计数能正确处理嵌套。
  const [docDragOver, setDocDragOver] = useState(false);
  const docDragCounter = useRef(0);
  const [importDragOver, setImportDragOver] = useState(false);
  const importDragCounter = useRef(0);

  // 按后缀名过滤拖入的文件。dragover 阶段拿不到文件名（仅有 dataTransfer.items
  // 的 kind/type），所以高亮总是显示——真正过滤放在 drop 阶段。
  const filterByExt = useCallback((files: File[], accept: string): File[] => {
    const exts = accept.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (exts.length === 0) return files;
    return files.filter(f => {
      const name = f.name.toLowerCase();
      return exts.some(ext => name.endsWith(ext));
    });
  }, []);

  const makeDropHandlers = useCallback(
    (
      setOver: (v: boolean) => void,
      counterRef: React.MutableRefObject<number>,
      onFiles: (files: File[]) => void,
      accept: string,
    ) => ({
      onDragEnter: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        counterRef.current++;
        setOver(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      },
      onDragLeave: () => {
        counterRef.current--;
        if (counterRef.current <= 0) {
          counterRef.current = 0;
          setOver(false);
        }
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        counterRef.current = 0;
        setOver(false);
        const files = filterByExt(Array.from(e.dataTransfer.files || []), accept);
        if (files.length > 0) onFiles(files);
      },
    }),
    [filterByExt],
  );

  const docDropHandlers = makeDropHandlers(
    setDocDragOver,
    docDragCounter,
    files => { if (files[0]) void doParseDocument(files[0]); },
    ".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm",
  );
  const importDropHandlers = makeDropHandlers(
    setImportDragOver,
    importDragCounter,
    files => void doKnowledgeImport(files),
    ".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm,.json",
  );

  // ===== ⑤ 批量格式化状态 =====
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);

  const handleBatchFormat = useCallback(async () => {
    setBatchLoading(true);
    setBatchResult(null);
    try {
      // 获取所有未锁定的笔记ID
      const notes = await api.getNotes();
      const validIds = notes.filter(n => !n.isLocked && !n.isTrashed).map(n => n.id).slice(0, 20);
      if (validIds.length === 0) {
        setBatchResult("没有可格式化的笔记");
        setBatchLoading(false);
        return;
      }
      const result = await api.batchFormatNotes(validIds);
      setBatchResult(t("aiChat.formatSuccess", { success: result.success, failed: result.failed }));
    } catch (err: any) {
      setBatchResult(`❌ ${err.message}`);
    } finally {
      setBatchLoading(false);
    }
  }, [t]);

  // 快捷提问
  const suggestedQuestions = [
    t("aiChat.suggestRecent"),
    t("aiChat.suggestSummary"),
    t("aiChat.suggestTodo"),
  ];

  const handleSuggestedQuestion = (q: string) => {
    // 直接把问题发送出去（原实现仅 setInput，用户还需手动回车，
    // 经常被误以为"AI 问答没反应"）。
    if (isLoading) return;
    setInput("");
    handleSend(q);
  };

  return (
    <div className="flex h-full bg-app-bg">
      {/* ===== 左侧：会话列表 ===== */}
      {/* 收起时宽度为 0；展开时占 208px。用 overflow-hidden 让内容动画收纳。 */}
      <aside
        className={cn(
          "flex flex-col border-r border-app-border bg-app-surface/30 transition-[width] duration-150 overflow-hidden shrink-0",
          sidebarOpen ? "w-52" : "w-0"
        )}
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-app-border">
          <span className="text-xs font-semibold text-tx-secondary">{t("aiChat.conversations")}</span>
          <button
            onClick={handleNewConversation}
            disabled={isLoading}
            title={t("aiChat.newConversation")}
            className="p-1 rounded-md text-tx-tertiary hover:text-accent-primary hover:bg-app-hover transition-colors disabled:opacity-50"
          >
            <Plus size={14} />
          </button>
        </div>
        <ScrollArea className="flex-1 min-w-0">
          <div className="w-full min-w-0 px-2 py-2 space-y-0.5">
            {conversations.length === 0 && (
              <div className="text-[11px] text-tx-tertiary px-2 py-4 text-center">
                {t("aiChat.noConversations")}
              </div>
            )}
            {conversations.map((c) => {
              const active = c.id === currentConvId;
              const displayTitle = c.title || t("aiChat.untitledConversation");
              const isRenaming = renamingId === c.id;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "group flex w-full min-w-0 items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer text-xs transition-colors",
                    active
                      ? "bg-accent-primary/10 text-accent-primary"
                      : "text-tx-secondary hover:bg-app-hover"
                  )}
                  onClick={() => !isRenaming && handleSelectConversation(c.id)}
                >
                  <MessageSquare size={12} className="shrink-0" />
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={handleSubmitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); handleSubmitRename(); }
                        else if (e.key === "Escape") { e.preventDefault(); handleCancelRename(); }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 px-1 py-0.5 bg-app-bg border border-accent-primary/40 rounded text-xs text-tx-primary outline-none"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 truncate" title={displayTitle}>
                      {displayTitle}
                    </span>
                  )}
                  {!isRenaming && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStartRename(c); }}
                        title={t("aiChat.renameConversation")}
                        className="p-0.5 rounded text-tx-tertiary hover:text-tx-primary hover:bg-app-hover"
                      >
                        <Pencil size={10} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDeleteConversation(c.id); }}
                        title={t("aiChat.deleteConversation")}
                        className="p-0.5 rounded text-tx-tertiary hover:text-red-500 hover:bg-app-hover"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      {/* ===== 右侧：消息主区 ===== */}
      <div className="flex flex-col flex-1 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface/50">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen(v => !v)}
            title={sidebarOpen ? t("aiChat.collapseSidebar") : t("aiChat.expandSidebar")}
            className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors"
          >
            <Menu size={14} />
          </button>
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center">
            <Bot size={14} className="text-white" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-tx-primary">{t("aiChat.title")}</span>
            {stats && (
              <span className="text-[10px] text-tx-tertiary bg-app-hover px-1.5 py-0.5 rounded-full">
                {t("aiChat.statsNotes", { count: stats.noteCount })}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleNewConversation}
            disabled={isLoading}
            title={t("aiChat.newConversation")}
            className="p-1.5 rounded-md text-tx-tertiary hover:text-accent-primary hover:bg-app-hover transition-colors disabled:opacity-50"
          >
            <Plus size={14} />
          </button>
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="p-1.5 rounded-md text-tx-tertiary hover:text-red-500 hover:bg-app-hover transition-colors"
              title={t("aiChat.clearChat")}
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-4 space-y-4">
          {historyLoading && messages.length === 0 && (
            <div className="flex items-center justify-center py-8 text-tx-tertiary">
              <Loader2 size={16} className="animate-spin" />
            </div>
          )}
          {!historyLoading && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/10 to-indigo-500/10 flex items-center justify-center mb-4">
                <Sparkles size={28} className="text-violet-500/60" />
              </div>
              <p className="text-sm text-tx-secondary mb-1">{t("aiChat.empty")}</p>
              <p className="text-xs text-tx-tertiary max-w-[240px] mb-5">{t("aiChat.emptyHint")}</p>

              {/* 知识库统计卡片 */}
              {stats && stats.noteCount > 0 && (
                <div className="w-full max-w-sm mb-5">
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="flex flex-col items-center py-2.5 px-2 rounded-xl bg-app-surface border border-app-border">
                      <BookOpen size={16} className="text-indigo-500/70 mb-1" />
                      <span className="text-base font-bold text-tx-primary">{stats.noteCount}</span>
                      <span className="text-[10px] text-tx-tertiary">{t("aiChat.statNotes")}</span>
                    </div>
                    <div className="flex flex-col items-center py-2.5 px-2 rounded-xl bg-app-surface border border-app-border">
                      <Database size={16} className="text-emerald-500/70 mb-1" />
                      <span className="text-base font-bold text-tx-primary">{stats.ftsCount}</span>
                      <span className="text-[10px] text-tx-tertiary">{t("aiChat.statIndexed")}</span>
                    </div>
                    <div className="flex flex-col items-center py-2.5 px-2 rounded-xl bg-app-surface border border-app-border">
                      <FileText size={16} className="text-amber-500/70 mb-1" />
                      <span className="text-base font-bold text-tx-primary">{stats.notebookCount}</span>
                      <span className="text-[10px] text-tx-tertiary">{t("aiChat.statNotebooks")}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* AI 工具区 */}
              <div className="w-full max-w-sm mb-5">
                <button
                  onClick={() => setShowTools(!showTools)}
                  className="flex items-center justify-center gap-1.5 w-full py-1.5 text-[10px] text-tx-tertiary hover:text-accent-primary transition-colors"
                >
                  <Wand2 size={10} />
                  {t("aiChat.toolsSection")}
                  {showTools ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                </button>
                {showTools && (
                  <div className="space-y-2 mt-2">
                    {/* ③ 文档解析 */}
                    <div
                      {...docDropHandlers}
                      className={cn(
                        "rounded-xl bg-app-surface border p-3 transition-colors",
                        docDragOver
                          ? "border-blue-500 bg-blue-500/5 ring-2 ring-blue-500/30"
                          : "border-app-border",
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <FileUp size={14} className="text-blue-500" />
                        <span className="text-xs font-medium text-tx-primary">{t("aiChat.docParse")}</span>
                      </div>
                      <p className="text-[10px] text-tx-tertiary mb-2">{t("aiChat.docParseDesc")}</p>
                      <input
                        ref={docInputRef}
                        type="file"
                        accept=".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm"
                        onChange={handleDocUpload}
                        className="hidden"
                      />
                      <button
                        onClick={() => docInputRef.current?.click()}
                        disabled={docParsing}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50 w-full justify-center"
                      >
                        {docParsing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                        {docParsing ? t("aiChat.parsing") : t("aiChat.uploadDoc")}
                      </button>
                      <p className="text-[9px] text-tx-tertiary mt-1 text-center">{t("aiChat.uploadDocHint")}</p>
                      {/* 解析结果预览 */}
                      {docResult && (
                        <div className="mt-2 rounded-lg bg-app-bg border border-app-border">
                          <div className="flex items-center justify-between px-2 py-1 border-b border-app-border">
                            <span className="text-[10px] text-tx-secondary truncate">{docFileName}</span>
                            <div className="flex gap-1">
                              <button onClick={handleCopyMarkdown} className="p-0.5 rounded hover:bg-app-hover text-tx-tertiary" title={t("aiChat.copyMarkdown")}>
                                <Copy size={10} />
                              </button>
                              <button onClick={() => setDocResult(null)} className="p-0.5 rounded hover:bg-app-hover text-tx-tertiary" title={t("aiChat.closePreview")}>
                                <X size={10} />
                              </button>
                            </div>
                          </div>
                          <div className="p-2 max-h-40 overflow-auto text-[10px] text-tx-secondary whitespace-pre-wrap">
                            {docResult.slice(0, 1000)}{docResult.length > 1000 && "..."}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* ⑥ 知识库导入 */}
                    <div
                      {...importDropHandlers}
                      className={cn(
                        "rounded-xl bg-app-surface border p-3 transition-colors",
                        importDragOver
                          ? "border-emerald-500 bg-emerald-500/5 ring-2 ring-emerald-500/30"
                          : "border-app-border",
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <FolderUp size={14} className="text-emerald-500" />
                        <span className="text-xs font-medium text-tx-primary">{t("aiChat.importKnowledge")}</span>
                      </div>
                      <p className="text-[10px] text-tx-tertiary mb-2">{t("aiChat.importKnowledgeDesc")}</p>
                      <input
                        ref={importInputRef}
                        type="file"
                        accept=".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm,.json"
                        multiple
                        onChange={handleKnowledgeImport}
                        className="hidden"
                      />
                      <button
                        onClick={() => importInputRef.current?.click()}
                        disabled={importLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50 w-full justify-center"
                      >
                        {importLoading ? <Loader2 size={12} className="animate-spin" /> : <FolderUp size={12} />}
                        {importLoading ? t("aiChat.importing") : t("aiChat.importFiles")}
                      </button>
                      <p className="text-[9px] text-tx-tertiary mt-1 text-center">{t("aiChat.importFilesHint")}</p>
                      {importResult && (
                        <div className="mt-2 flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px]">
                          <Check size={10} />
                          {importResult}
                        </div>
                      )}
                    </div>

                    {/* ⑤ 批量格式化 */}
                    <div className="rounded-xl bg-app-surface border border-app-border p-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <Wand2 size={14} className="text-amber-500" />
                        <span className="text-xs font-medium text-tx-primary">{t("aiChat.batchFormat")}</span>
                      </div>
                      <p className="text-[10px] text-tx-tertiary mb-2">{t("aiChat.batchFormatDesc")}</p>
                      <button
                        onClick={handleBatchFormat}
                        disabled={batchLoading}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50 w-full justify-center"
                      >
                        {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                        {batchLoading ? t("aiChat.formatting") : t("aiChat.batchFormat")}
                      </button>
                      <p className="text-[9px] text-tx-tertiary mt-1 text-center">{t("aiChat.selectNotesHint")}</p>
                      {batchResult && (
                        <div className="mt-2 flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px]">
                          <Check size={10} />
                          {batchResult}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 快捷问题建议 */}
              <div className="w-full max-w-sm space-y-1.5">
                <p className="text-[10px] text-tx-tertiary uppercase tracking-wider mb-2 flex items-center gap-1 justify-center">
                  <MessageCircleQuestion size={10} />
                  {t("aiChat.trySuggestions")}
                </p>
                {suggestedQuestions.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => handleSuggestedQuestion(q)}
                    className="flex items-center justify-between w-full px-3 py-2 rounded-lg text-xs text-tx-secondary bg-app-surface border border-app-border hover:border-accent-primary/30 hover:bg-accent-primary/5 hover:text-accent-primary transition-all group text-left"
                  >
                    <span>{q}</span>
                    <ArrowRight size={12} className="text-tx-tertiary group-hover:text-accent-primary transition-colors shrink-0 ml-2" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className={cn("flex gap-2.5", msg.role === "user" ? "flex-row-reverse" : "")}>
              {/* Avatar */}
              <div className={cn(
                "w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
                msg.role === "user"
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "bg-gradient-to-br from-violet-500 to-indigo-500 text-white"
              )}>
                {msg.role === "user" ? <User size={13} /> : <Bot size={13} />}
              </div>

              {/* Content */}
              <div className={cn(
                "flex-1 min-w-0",
                msg.role === "user" ? "text-right" : ""
              )}>
                <div className={cn(
                  "inline-block text-sm leading-relaxed rounded-xl px-3.5 py-2.5 max-w-[85%] text-left",
                  msg.role === "user"
                    ? "bg-accent-primary text-white rounded-tr-md"
                    : "bg-app-surface border border-app-border text-tx-primary rounded-tl-md"
                )}>
                  {msg.role === "user" ? (
                    <div className="whitespace-pre-wrap break-words">
                      {msg.content}
                    </div>
                  ) : (
                    <div className="markdown-body break-words prose prose-sm dark:prose-invert max-w-none
                      prose-p:my-1.5 prose-p:leading-relaxed
                      prose-headings:my-2 prose-headings:font-semibold
                      prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                      prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                      prose-code:text-xs prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-md prose-code:bg-black/5 dark:prose-code:bg-white/10 prose-code:before:content-none prose-code:after:content-none
                      prose-pre:my-2 prose-pre:rounded-lg prose-pre:bg-black/5 dark:prose-pre:bg-white/5 prose-pre:p-3
                      prose-blockquote:my-2 prose-blockquote:border-violet-400 prose-blockquote:text-tx-secondary
                      prose-hr:my-3
                      prose-a:text-accent-primary prose-a:no-underline hover:prose-a:underline
                      prose-strong:text-tx-primary
                      prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1
                    ">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                      {msg.isStreaming && msg.content.length === 0 && (
                        // 首个 chunk 到达前气泡是空的，显示"思考中"避免看起来卡死
                        <div className="flex items-center gap-2 text-tx-tertiary text-xs py-0.5">
                          <span className="flex gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-accent-primary/60 animate-bounce [animation-delay:-0.3s]" />
                            <span className="w-1.5 h-1.5 rounded-full bg-accent-primary/60 animate-bounce [animation-delay:-0.15s]" />
                            <span className="w-1.5 h-1.5 rounded-full bg-accent-primary/60 animate-bounce" />
                          </span>
                          <span>{t("aiChat.thinking")}</span>
                        </div>
                      )}
                      {msg.isStreaming && msg.content.length > 0 && (
                        <span className="inline-block w-1.5 h-4 bg-accent-primary/60 animate-pulse ml-0.5 align-middle rounded-sm" />
                      )}
                    </div>
                  )}
                </div>

                {/* References */}
                {msg.references && msg.references.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-[10px] text-tx-tertiary flex items-center gap-1">
                      <FileText size={10} />
                      {t("aiChat.references")}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {msg.references.map((ref) => {
                        const isAtt = ref.kind === "attachment" && ref.attachmentId;
                        const clickable = isAtt || !!onNavigateToNote;
                        // 附件点击：新 tab 下载；笔记点击：跳转到笔记
                        const handleClick = () => {
                          if (isAtt && ref.attachmentId) {
                            window.open(
                              `/api/attachments/${ref.attachmentId}?download=1`,
                              "_blank",
                            );
                          } else if (onNavigateToNote) {
                            onNavigateToNote(ref.id);
                          }
                        };
                        return (
                          <button
                            key={`${ref.kind || "note"}-${ref.attachmentId || ref.id}`}
                            onClick={handleClick}
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] transition-colors",
                              isAtt
                                ? clickable
                                  ? "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20 cursor-pointer"
                                  : "bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                : clickable
                                  ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-500/20 cursor-pointer"
                                  : "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                            )}
                            title={
                              isAtt
                                ? (ref.attachmentFilename || ref.title)
                                : (onNavigateToNote ? t("aiChat.openNote") : undefined)
                            }
                          >
                            {isAtt ? <Paperclip size={9} /> : <FileText size={9} />}
                            {ref.title}
                            {clickable && <ArrowRight size={8} className="ml-0.5" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>


      {/* 知识库范围选择器 */}
      <div className="px-4 pt-2 pb-0 flex items-center gap-2 text-xs">
        <span className="text-tx-tertiary shrink-0">{t("aiChat.knowledgeScope") || "知识库范围"}：</span>
        <select
          value={nbScope === "all" ? "all" : nbScopeId}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "all") { setNbScope("all"); setNbScopeId(""); }
            else { setNbScope("notebook"); setNbScopeId(v); }
          }}
          className="flex-1 min-w-0 px-2 py-1 bg-app-bg border border-app-border rounded-lg text-tx-primary focus:ring-1 focus:ring-accent-primary/40 outline-none"
        >
          <option value="all">{t("aiChat.scopeAll") || "当前空间"}</option>
          {appState.notebooks.map(nb => (
            <option key={nb.id} value={nb.id}>{nb.name}</option>
          ))}
        </select>
        {nbScope === "notebook" && (
          <label className="flex items-center gap-1 shrink-0 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={nbIncludeChildren}
              onChange={(e) => setNbIncludeChildren(e.target.checked)}
              className="rounded accent-accent-primary"
            />
            <span className="text-tx-tertiary">{t("aiChat.includeChildren") || "含子笔记本"}</span>
          </label>
        )}
      </div>
      {/* Input */}
      <div className="px-4 py-3 border-t border-app-border bg-app-surface/30">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("aiChat.placeholder")}
            rows={1}
            className="flex-1 resize-none px-3 py-2 bg-app-bg border border-app-border rounded-xl text-sm text-tx-primary placeholder:text-tx-tertiary focus:ring-2 focus:ring-accent-primary/40 focus:border-accent-primary outline-none transition-all max-h-24"
            style={{ minHeight: "38px" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = Math.min(target.scrollHeight, 96) + "px";
            }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isLoading}
            className={cn(
              "shrink-0 w-9 h-9 rounded-xl flex items-center justify-center transition-all",
              input.trim() && !isLoading
                ? "bg-accent-primary hover:bg-accent-primary/90 text-white"
                : "bg-app-hover text-tx-tertiary"
            )}
          >
            {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}

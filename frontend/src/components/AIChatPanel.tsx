import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Bot, Send, Trash2, X, Loader2, FileText, Sparkles, User,
  BookOpen, Database, MessageCircleQuestion, ArrowRight,
  Upload, FileUp, Wand2, FolderUp, Check, Copy, ChevronDown, ChevronUp
} from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: { id: string; title: string }[];
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
// 本组件仅负责拉取、追加、清空三个动作。
const HISTORY_LIMIT = 100;

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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 加载知识库统计
  useEffect(() => {
    api.getKnowledgeStats().then(setStats).catch(() => {});
  }, []);

  // 打开面板时从后端拉取上次的聊天记录。
  // 失败时（未登录 / 网络问题）退回空列表，不影响正常聊天。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getAiChatHistory(HISTORY_LIMIT);
        if (cancelled) return;
        setMessages(res.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          references: m.references,
        })));
      } catch {
        /* ignore: 首次使用或离线状态 */
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = useCallback(async (override?: string) => {
    const question = (override ?? input).trim();
    if (!question || isLoading) return;

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
      role: "user",
      content: userMsg.content,
    }).catch(() => { /* 持久化失败不影响对话 */ });

    // Build history from previous messages
    const history = messages
      .filter(m => !m.isStreaming)
      .map(m => ({ role: m.role, content: m.content }));

    // 收集流式期间累积的最终内容和 references，结束后一次性落库
    let finalContent = "";
    let finalRefs: { id: string; title: string }[] | undefined;

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
        }
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
          role: "assistant",
          content: finalContent,
          references: finalRefs,
        }).catch(() => { /* 持久化失败不影响对话 */ });
      }
    }
  }, [input, isLoading, messages, t]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const clearChat = () => {
    setMessages([]);
    // 同步清空后端持久化记录，否则下次打开又会把历史恢复回来
    api.clearAiChatHistory().catch(() => { /* ignore */ });
  };

  // ===== ③ 文档解析状态 =====
  const [docParsing, setDocParsing] = useState(false);
  const [docResult, setDocResult] = useState<string | null>(null);
  const [docFileName, setDocFileName] = useState("");
  const docInputRef = useRef<HTMLInputElement>(null);

  const handleDocUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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

  const handleCopyMarkdown = useCallback(() => {
    if (docResult) {
      navigator.clipboard.writeText(docResult);
    }
  }, [docResult]);

  // ===== ⑥ 知识库导入状态 =====
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleKnowledgeImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImportLoading(true);
    setImportResult(null);
    try {
      const result = await api.importToKnowledge(Array.from(files));
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
    <div className="flex flex-col h-full bg-app-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface/50">
        <div className="flex items-center gap-2">
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
                    <div className="rounded-xl bg-app-surface border border-app-border p-3">
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
                    <div className="rounded-xl bg-app-surface border border-app-border p-3">
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
                      {msg.references.map((ref) => (
                        <button
                          key={ref.id}
                          onClick={() => onNavigateToNote?.(ref.id)}
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] transition-colors",
                            onNavigateToNote
                              ? "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-500/20 cursor-pointer"
                              : "bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400"
                          )}
                          title={onNavigateToNote ? t("aiChat.openNote") : undefined}
                        >
                          <FileText size={9} />
                          {ref.title}
                          {onNavigateToNote && <ArrowRight size={8} className="ml-0.5" />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

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
  );
}

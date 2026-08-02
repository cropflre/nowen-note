import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  FileText,
  FileUp,
  FolderUp,
  Loader2,
  Menu,
  MessageCircleQuestion,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  Upload,
  User,
  Wand2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api";
import { withAbortableAiFetch } from "@/lib/abortableAiAsk";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/store/AppContext";

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
  stopped?: boolean;
  createdAt?: string;
}

interface KnowledgeStats {
  noteCount: number;
  ftsCount: number;
  notebookCount: number;
  tagCount: number;
  recentTopics: string[];
  indexed: boolean;
}

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

const HISTORY_LIMIT = 100;
const deriveTitleFromQuestion = (question: string) => question.trim().replace(/\s+/g, " ").slice(0, 20);

function formatMessageTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mapHistoryMessage(message: {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: ChatReference[];
  createdAt: string;
}): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    references: message.references,
    createdAt: message.createdAt,
  };
}

export default function AIChatPanel({ onClose, onNavigateToNote }: {
  onClose: () => void;
  onNavigateToNote?: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  const { state: appState } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [nbScope, setNbScope] = useState<"all" | "notebook">("all");
  const [nbScopeId, setNbScopeId] = useState("");
  const [nbIncludeChildren, setNbIncludeChildren] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  useEffect(() => {
    const reload = () => api.getKnowledgeStats().then(setStats).catch(() => {});
    reload();
    window.addEventListener("nowen:workspace-changed", reload);
    return () => window.removeEventListener("nowen:workspace-changed", reload);
  }, []);

  const reloadConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    try {
      const result = await api.aiConversations.list();
      setConversations(result.conversations);
      return result.conversations;
    } catch {
      setConversations([]);
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await reloadConversations();
      if (cancelled) return;
      const targetId = list[0]?.id || null;
      setCurrentConvId(targetId);
      if (!targetId) {
        setHistoryLoading(false);
        return;
      }
      try {
        const result = await api.getAiChatHistory(HISTORY_LIMIT, targetId);
        if (!cancelled) setMessages(result.messages.map(mapHistoryMessage));
      } catch {
        // Opening chat must still work when history is temporarily unavailable.
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadConversations]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => scrollToBottom(), [messages, scrollToBottom]);

  const handleSelectConversation = useCallback(async (conversationId: string) => {
    if (isLoading || conversationId === currentConvId) return;
    setCurrentConvId(conversationId);
    setMessages([]);
    setHistoryLoading(true);
    try {
      const result = await api.getAiChatHistory(HISTORY_LIMIT, conversationId);
      setMessages(result.messages.map(mapHistoryMessage));
    } catch {
      // Keep the selected conversation open and allow a retry by switching back.
    } finally {
      setHistoryLoading(false);
    }
  }, [currentConvId, isLoading]);

  const handleNewConversation = useCallback(async () => {
    if (isLoading) return;
    try {
      const result = await api.aiConversations.create();
      setConversations((previous) => [result.conversation, ...previous]);
      setCurrentConvId(result.conversation.id);
      setMessages([]);
    } catch {
      setCurrentConvId(null);
      setMessages([]);
    }
  }, [isLoading]);

  const handleStartRename = (conversation: ConversationSummary) => {
    setRenamingId(conversation.id);
    setRenameDraft(conversation.title || "");
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
      setConversations((previous) => previous.map((item) => item.id === renamingId ? { ...item, title } : item));
    } catch {
      // Preserve the old title when the server rejects the rename.
    } finally {
      handleCancelRename();
    }
  }, [renameDraft, renamingId]);

  const handleDeleteConversation = useCallback(async (conversationId: string) => {
    if (isLoading) return;
    const confirmed = await confirmDialog({
      title: t("common.delete"),
      description: t("aiChat.deleteConversationConfirm"),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.aiConversations.remove(conversationId);
    } catch {
      // The next list refresh will reconcile a failed optimistic removal.
    }
    const remaining = conversations.filter((item) => item.id !== conversationId);
    setConversations(remaining);
    if (conversationId !== currentConvId) return;
    if (remaining[0]) await handleSelectConversation(remaining[0].id);
    else {
      setCurrentConvId(null);
      setMessages([]);
    }
  }, [conversations, currentConvId, handleSelectConversation, isLoading, t]);

  const persistConversationSnapshot = useCallback(async (nextMessages: ChatMessage[]) => {
    if (!currentConvId) return;
    try {
      await api.clearAiChatHistory(currentConvId);
      for (const message of nextMessages) {
        if (message.isStreaming || !message.content.trim()) continue;
        await api.appendAiChatHistory({
          id: message.id,
          conversationId: currentConvId,
          role: message.role,
          content: message.content,
          references: message.references,
        });
      }
      await reloadConversations();
    } catch {
      // Local editing remains usable offline; reopening the conversation will reconcile it.
    }
  }, [currentConvId, reloadConversations]);

  const handleStopGeneration = useCallback(() => {
    if (!isLoading) return;
    stopRequestedRef.current = true;
    abortControllerRef.current?.abort();
  }, [isLoading]);

  const streamAssistantReply = useCallback(async (args: {
    question: string;
    history: { role: string; content: string }[];
    assistantMessage: ChatMessage;
    conversationId: string | null;
    baseMessages: ChatMessage[];
    replaceHistory?: boolean;
  }) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    stopRequestedRef.current = false;
    let finalContent = "";
    let finalReferences: ChatReference[] | undefined;
    let stopped = false;

    try {
      await withAbortableAiFetch(controller, () => api.aiAsk(
        args.question,
        args.history,
        (chunk) => {
          finalContent += chunk;
          setMessages((previous) => previous.map((message) =>
            message.id === args.assistantMessage.id
              ? { ...message, content: message.content + chunk }
              : message
          ));
        },
        (references) => {
          finalReferences = references;
          setMessages((previous) => previous.map((message) =>
            message.id === args.assistantMessage.id
              ? { ...message, references }
              : message
          ));
        },
        nbScope === "notebook" ? {
          notebookId: nbScopeId,
          includeChildren: nbIncludeChildren,
        } : undefined,
      ));
    } catch (error: any) {
      stopped = stopRequestedRef.current || controller.signal.aborted || error?.name === "AbortError";
      if (!stopped) {
        finalContent = error?.message || t("ai.requestFailed");
        setMessages((previous) => previous.map((message) =>
          message.id === args.assistantMessage.id
            ? { ...message, content: finalContent }
            : message
        ));
      }
    } finally {
      const completed: ChatMessage = {
        ...args.assistantMessage,
        content: finalContent,
        references: finalReferences,
        isStreaming: false,
        stopped,
      };
      setMessages((previous) => previous.map((message) =>
        message.id === args.assistantMessage.id ? completed : message
      ));
      setIsLoading(false);
      stopRequestedRef.current = false;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;

      if (args.replaceHistory) {
        const snapshot = args.baseMessages.map((message) =>
          message.id === completed.id ? completed : message
        );
        await persistConversationSnapshot(snapshot);
      } else if (finalContent.trim()) {
        api.appendAiChatHistory({
          id: completed.id,
          conversationId: args.conversationId || undefined,
          role: "assistant",
          content: finalContent,
          references: finalReferences,
        }).catch(() => {});
      }
      reloadConversations().catch(() => {});
    }
  }, [nbIncludeChildren, nbScope, nbScopeId, persistConversationSnapshot, reloadConversations, t]);

  const handleSend = useCallback(async (override?: string) => {
    const question = (override ?? input).trim();
    if (!question || isLoading) return;

    let conversationId = currentConvId;
    if (!conversationId) {
      try {
        const result = await api.aiConversations.create();
        conversationId = result.conversation.id;
        setConversations((previous) => [result.conversation, ...previous]);
        setCurrentConvId(conversationId);
      } catch {
        // Old backends create a default conversation when history is appended.
      }
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: question,
      createdAt: now,
    };
    const assistantMessage: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      isStreaming: true,
      createdAt: now,
    };
    const baseMessages = [...messages, userMessage, assistantMessage];
    const history = messages
      .filter((message) => !message.isStreaming)
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages(baseMessages);
    setInput("");
    setIsLoading(true);

    api.appendAiChatHistory({
      id: userMessage.id,
      conversationId: conversationId || undefined,
      role: "user",
      content: question,
    }).catch(() => {});

    if (conversationId) {
      const conversation = conversations.find((item) => item.id === conversationId);
      if (conversation && !conversation.title) {
        const title = deriveTitleFromQuestion(question);
        if (title) {
          api.aiConversations.update(conversationId, { title }).catch(() => {});
          setConversations((previous) => previous.map((item) =>
            item.id === conversationId ? { ...item, title } : item
          ));
        }
      }
    }

    await streamAssistantReply({
      question,
      history,
      assistantMessage,
      conversationId,
      baseMessages,
    });
  }, [conversations, currentConvId, input, isLoading, messages, streamAssistantReply]);

  const handleRegenerate = useCallback(async (assistantId: string) => {
    if (isLoading) return;
    const assistantIndex = messages.findIndex((message) => message.id === assistantId && message.role === "assistant");
    if (assistantIndex < 0) return;
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex -= 1;
    if (userIndex < 0) return;

    const question = messages[userIndex].content;
    const assistantMessage: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      isStreaming: true,
      createdAt: new Date().toISOString(),
    };
    const baseMessages = [...messages.slice(0, assistantIndex), assistantMessage];
    const history = messages
      .slice(0, userIndex)
      .filter((message) => !message.isStreaming)
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages(baseMessages);
    setIsLoading(true);
    await streamAssistantReply({
      question,
      history,
      assistantMessage,
      conversationId: currentConvId,
      baseMessages,
      replaceHistory: true,
    });
  }, [currentConvId, isLoading, messages, streamAssistantReply]);

  const handleCopyMessage = useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1500);
    } catch {
      // Clipboard permission may be denied in an embedded WebView.
    }
  }, []);

  const handleStartEditMessage = (message: ChatMessage) => {
    setEditingMessageId(message.id);
    setEditDraft(message.content);
  };

  const handleSaveMessageEdit = useCallback(async (messageId: string) => {
    const content = editDraft.trim();
    if (!content) return;
    const nextMessages = messages.map((message) =>
      message.id === messageId ? { ...message, content } : message
    );
    setMessages(nextMessages);
    setEditingMessageId(null);
    setEditDraft("");
    await persistConversationSnapshot(nextMessages);
  }, [editDraft, messages, persistConversationSnapshot]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (isLoading) return;
    const nextMessages = messages.filter((message) => message.id !== messageId);
    setMessages(nextMessages);
    if (editingMessageId === messageId) {
      setEditingMessageId(null);
      setEditDraft("");
    }
    await persistConversationSnapshot(nextMessages);
  }, [editingMessageId, isLoading, messages, persistConversationSnapshot]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const clearChat = () => {
    setMessages([]);
    if (currentConvId) {
      api.clearAiChatHistory(currentConvId).catch(() => {});
      setConversations((previous) => previous.map((conversation) =>
        conversation.id === currentConvId
          ? { ...conversation, messageCount: 0, lastMessage: null, lastRole: null }
          : conversation
      ));
    } else {
      api.clearAiChatHistory().catch(() => {});
    }
  };

  const [docParsing, setDocParsing] = useState(false);
  const [docResult, setDocResult] = useState<string | null>(null);
  const [docFileName, setDocFileName] = useState("");
  const docInputRef = useRef<HTMLInputElement>(null);

  const doParseDocument = useCallback(async (file: File) => {
    setDocParsing(true);
    setDocFileName(file.name);
    setDocResult(null);
    try {
      const result = await api.parseDocument(file, { formatMode: "note" });
      setDocResult(result.markdown);
    } catch (error: any) {
      setDocResult(`❌ ${error.message}`);
    } finally {
      setDocParsing(false);
      if (docInputRef.current) docInputRef.current.value = "";
    }
  }, []);

  const handleDocUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void doParseDocument(file);
  }, [doParseDocument]);

  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const doKnowledgeImport = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setImportLoading(true);
    setImportResult(null);
    try {
      const result = await api.importToKnowledge(files);
      setImportResult(t("aiChat.importSuccess", { success: result.success, failed: result.failed }));
      api.getKnowledgeStats().then(setStats).catch(() => {});
    } catch (error: any) {
      setImportResult(`❌ ${error.message}`);
    } finally {
      setImportLoading(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [t]);

  const handleKnowledgeImport = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files?.length) void doKnowledgeImport(Array.from(files));
  }, [doKnowledgeImport]);

  const [docDragOver, setDocDragOver] = useState(false);
  const docDragCounter = useRef(0);
  const [importDragOver, setImportDragOver] = useState(false);
  const importDragCounter = useRef(0);

  const filterByExt = useCallback((files: File[], accept: string): File[] => {
    const extensions = accept.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    return files.filter((file) => extensions.some((extension) => file.name.toLowerCase().endsWith(extension)));
  }, []);

  const makeDropHandlers = useCallback((
    setOver: (value: boolean) => void,
    counterRef: React.MutableRefObject<number>,
    onFiles: (files: File[]) => void,
    accept: string,
  ) => ({
    onDragEnter: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      counterRef.current += 1;
      setOver(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      counterRef.current -= 1;
      if (counterRef.current <= 0) {
        counterRef.current = 0;
        setOver(false);
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      counterRef.current = 0;
      setOver(false);
      const files = filterByExt(Array.from(event.dataTransfer.files || []), accept);
      if (files.length) onFiles(files);
    },
  }), [filterByExt]);

  const docDropHandlers = makeDropHandlers(
    setDocDragOver,
    docDragCounter,
    (files) => { if (files[0]) void doParseDocument(files[0]); },
    ".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm",
  );
  const importDropHandlers = makeDropHandlers(
    setImportDragOver,
    importDragCounter,
    (files) => void doKnowledgeImport(files),
    ".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm,.json",
  );

  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);

  const handleBatchFormat = useCallback(async () => {
    setBatchLoading(true);
    setBatchResult(null);
    try {
      const notes = await api.getNotes();
      const validIds = notes.filter((note) => !note.isLocked && !note.isTrashed).map((note) => note.id).slice(0, 20);
      if (!validIds.length) {
        setBatchResult("没有可格式化的笔记");
        return;
      }
      const result = await api.batchFormatNotes(validIds);
      setBatchResult(t("aiChat.formatSuccess", { success: result.success, failed: result.failed }));
    } catch (error: any) {
      setBatchResult(`❌ ${error.message}`);
    } finally {
      setBatchLoading(false);
    }
  }, [t]);

  const suggestedQuestions = [
    t("aiChat.suggestRecent"),
    t("aiChat.suggestSummary"),
    t("aiChat.suggestTodo"),
  ];

  const handleReferenceClick = (reference: ChatReference) => {
    const isAttachment = reference.kind === "attachment" && reference.attachmentId;
    if (isAttachment && reference.attachmentId) {
      window.open(`/api/attachments/${reference.attachmentId}?download=1`, "_blank");
    } else if (onNavigateToNote) {
      onNavigateToNote(reference.id);
    }
  };

  return (
    <div className="flex h-full bg-app-bg">
      <aside className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r border-app-border bg-app-surface/30 transition-[width] duration-150",
        sidebarOpen ? "w-52" : "w-0",
      )}>
        <div className="flex items-center justify-between border-b border-app-border px-3 py-2.5">
          <span className="text-xs font-semibold text-tx-secondary">{t("aiChat.conversations")}</span>
          <button
            type="button"
            onClick={() => void handleNewConversation()}
            disabled={isLoading}
            title={t("aiChat.newConversation")}
            className="rounded-md p-1 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-accent-primary disabled:opacity-50"
          >
            <Plus size={14} />
          </button>
        </div>
        <ScrollArea className="min-w-0 flex-1">
          <div className="w-full min-w-0 space-y-0.5 px-2 py-2">
            {!conversations.length && (
              <div className="px-2 py-4 text-center text-[11px] text-tx-tertiary">{t("aiChat.noConversations")}</div>
            )}
            {conversations.map((conversation) => {
              const active = conversation.id === currentConvId;
              const displayTitle = conversation.title || t("aiChat.untitledConversation");
              const isRenaming = renamingId === conversation.id;
              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-xs transition-colors",
                    active ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover",
                  )}
                  onClick={() => !isRenaming && void handleSelectConversation(conversation.id)}
                >
                  <MessageSquare size={12} className="shrink-0" />
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => void handleSubmitRename()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSubmitRename();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          handleCancelRename();
                        }
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="min-w-0 flex-1 rounded border border-accent-primary/40 bg-app-bg px-1 py-0.5 text-xs text-tx-primary outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate" title={displayTitle}>{displayTitle}</span>
                  )}
                  {!isRenaming && (
                    <div className={cn(
                      "flex shrink-0 items-center gap-0.5 transition-opacity",
                      active
                        ? "opacity-100"
                        : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
                    )}>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); handleStartRename(conversation); }}
                        title={t("aiChat.renameConversation")}
                        className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                      >
                        <Pencil size={10} />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); void handleDeleteConversation(conversation.id); }}
                        title={t("aiChat.deleteConversation")}
                        className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-red-500"
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

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen((value) => !value)}
              title={sidebarOpen ? t("aiChat.collapseSidebar") : t("aiChat.expandSidebar")}
              className="rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary"
            >
              <Menu size={14} />
            </button>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500">
              <Bot size={14} className="text-white" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-tx-primary">{t("aiChat.title")}</span>
              {stats && (
                <span className="rounded-full bg-app-hover px-1.5 py-0.5 text-[10px] text-tx-tertiary">
                  {t("aiChat.statsNotes", { count: stats.noteCount })}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              disabled={isLoading}
              title={t("aiChat.newConversation")}
              className="rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-accent-primary disabled:opacity-50"
            >
              <Plus size={14} />
            </button>
            {!!messages.length && (
              <button
                type="button"
                onClick={clearChat}
                title={t("aiChat.clearChat")}
                className="rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-red-500"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <ScrollArea
          className="min-h-0 flex-1"
          scrollbarClassName="w-3 bg-app-surface/70"
          thumbClassName="bg-tx-tertiary/50 hover:bg-tx-secondary/70"
        >
          <div className="space-y-4 px-4 py-4">
            {historyLoading && !messages.length && (
              <div className="flex items-center justify-center py-8 text-tx-tertiary">
                <Loader2 size={16} className="animate-spin" />
              </div>
            )}

            {!historyLoading && !messages.length && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/10 to-indigo-500/10">
                  <Sparkles size={28} className="text-violet-500/60" />
                </div>
                <p className="mb-1 text-sm text-tx-secondary">{t("aiChat.empty")}</p>
                <p className="mb-5 max-w-[240px] text-xs text-tx-tertiary">{t("aiChat.emptyHint")}</p>

                {stats && stats.noteCount > 0 && (
                  <div className="mb-5 w-full max-w-sm">
                    <div className="mb-3 grid grid-cols-3 gap-2">
                      <div className="flex flex-col items-center rounded-xl border border-app-border bg-app-surface px-2 py-2.5">
                        <BookOpen size={16} className="mb-1 text-indigo-500/70" />
                        <span className="text-base font-bold text-tx-primary">{stats.noteCount}</span>
                        <span className="text-[10px] text-tx-tertiary">{t("aiChat.statNotes")}</span>
                      </div>
                      <div className="flex flex-col items-center rounded-xl border border-app-border bg-app-surface px-2 py-2.5">
                        <Database size={16} className="mb-1 text-emerald-500/70" />
                        <span className="text-base font-bold text-tx-primary">{stats.ftsCount}</span>
                        <span className="text-[10px] text-tx-tertiary">{t("aiChat.statIndexed")}</span>
                      </div>
                      <div className="flex flex-col items-center rounded-xl border border-app-border bg-app-surface px-2 py-2.5">
                        <FileText size={16} className="mb-1 text-amber-500/70" />
                        <span className="text-base font-bold text-tx-primary">{stats.notebookCount}</span>
                        <span className="text-[10px] text-tx-tertiary">{t("aiChat.statNotebooks")}</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mb-5 w-full max-w-sm">
                  <button
                    type="button"
                    onClick={() => setShowTools((value) => !value)}
                    className="flex w-full items-center justify-center gap-1.5 py-1.5 text-[10px] text-tx-tertiary transition-colors hover:text-accent-primary"
                  >
                    <Wand2 size={10} />
                    {t("aiChat.toolsSection")}
                    {showTools ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  </button>

                  {showTools && (
                    <div className="mt-2 space-y-2">
                      <div
                        {...docDropHandlers}
                        className={cn(
                          "rounded-xl border bg-app-surface p-3 transition-colors",
                          docDragOver
                            ? "border-blue-500 bg-blue-500/5 ring-2 ring-blue-500/30"
                            : "border-app-border",
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-2">
                          <FileUp size={14} className="text-blue-500" />
                          <span className="text-xs font-medium text-tx-primary">{t("aiChat.docParse")}</span>
                        </div>
                        <p className="mb-2 text-[10px] text-tx-tertiary">{t("aiChat.docParseDesc")}</p>
                        <input
                          ref={docInputRef}
                          type="file"
                          accept=".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm"
                          onChange={handleDocUpload}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => docInputRef.current?.click()}
                          disabled={docParsing}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-500/10 px-3 py-1.5 text-xs text-blue-600 transition-colors hover:bg-blue-500/20 disabled:opacity-50 dark:text-blue-400"
                        >
                          {docParsing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                          {docParsing ? t("aiChat.parsing") : t("aiChat.uploadDoc")}
                        </button>
                        <p className="mt-1 text-center text-[9px] text-tx-tertiary">{t("aiChat.uploadDocHint")}</p>
                        {docResult && (
                          <div className="mt-2 rounded-lg border border-app-border bg-app-bg">
                            <div className="flex items-center justify-between border-b border-app-border px-2 py-1">
                              <span className="truncate text-[10px] text-tx-secondary">{docFileName}</span>
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => navigator.clipboard.writeText(docResult).catch(() => {})}
                                  className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover"
                                  title={t("aiChat.copyMarkdown")}
                                >
                                  <Copy size={10} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDocResult(null)}
                                  className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover"
                                  title={t("aiChat.closePreview")}
                                >
                                  <X size={10} />
                                </button>
                              </div>
                            </div>
                            <div className="max-h-40 overflow-auto whitespace-pre-wrap p-2 text-[10px] text-tx-secondary">
                              {docResult.slice(0, 1000)}{docResult.length > 1000 && "..."}
                            </div>
                          </div>
                        )}
                      </div>

                      <div
                        {...importDropHandlers}
                        className={cn(
                          "rounded-xl border bg-app-surface p-3 transition-colors",
                          importDragOver
                            ? "border-emerald-500 bg-emerald-500/5 ring-2 ring-emerald-500/30"
                            : "border-app-border",
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-2">
                          <FolderUp size={14} className="text-emerald-500" />
                          <span className="text-xs font-medium text-tx-primary">{t("aiChat.importKnowledge")}</span>
                        </div>
                        <p className="mb-2 text-[10px] text-tx-tertiary">{t("aiChat.importKnowledgeDesc")}</p>
                        <input
                          ref={importInputRef}
                          type="file"
                          accept=".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm,.json"
                          multiple
                          onChange={handleKnowledgeImport}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => importInputRef.current?.click()}
                          disabled={importLoading}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-600 transition-colors hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-400"
                        >
                          {importLoading ? <Loader2 size={12} className="animate-spin" /> : <FolderUp size={12} />}
                          {importLoading ? t("aiChat.importing") : t("aiChat.importFiles")}
                        </button>
                        <p className="mt-1 text-center text-[9px] text-tx-tertiary">{t("aiChat.importFilesHint")}</p>
                        {importResult && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2 py-1.5 text-[10px] text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                            <Check size={10} />
                            {importResult}
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-app-border bg-app-surface p-3">
                        <div className="mb-1.5 flex items-center gap-2">
                          <Wand2 size={14} className="text-amber-500" />
                          <span className="text-xs font-medium text-tx-primary">{t("aiChat.batchFormat")}</span>
                        </div>
                        <p className="mb-2 text-[10px] text-tx-tertiary">{t("aiChat.batchFormatDesc")}</p>
                        <button
                          type="button"
                          onClick={() => void handleBatchFormat()}
                          disabled={batchLoading}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
                        >
                          {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                          {batchLoading ? t("aiChat.formatting") : t("aiChat.batchFormat")}
                        </button>
                        <p className="mt-1 text-center text-[9px] text-tx-tertiary">{t("aiChat.selectNotesHint")}</p>
                        {batchResult && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-[10px] text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
                            <Check size={10} />
                            {batchResult}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="w-full max-w-sm space-y-1.5">
                  <p className="mb-2 flex items-center justify-center gap-1 text-[10px] uppercase tracking-wider text-tx-tertiary">
                    <MessageCircleQuestion size={10} />
                    {t("aiChat.trySuggestions")}
                  </p>
                  {suggestedQuestions.map((question) => (
                    <button
                      key={question}
                      type="button"
                      onClick={() => { if (!isLoading) void handleSend(question); }}
                      className="group flex w-full items-center justify-between rounded-lg border border-app-border bg-app-surface px-3 py-2 text-left text-xs text-tx-secondary transition-all hover:border-accent-primary/30 hover:bg-accent-primary/5 hover:text-accent-primary"
                    >
                      <span>{question}</span>
                      <ArrowRight size={12} className="ml-2 shrink-0 text-tx-tertiary transition-colors group-hover:text-accent-primary" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => {
              const isUser = message.role === "user";
              const editing = editingMessageId === message.id;
              const time = formatMessageTime(message.createdAt);
              return (
                <div
                  key={message.id}
                  className={cn("group/message flex gap-2.5", isUser && "flex-row-reverse")}
                >
                  <div className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                    isUser
                      ? "bg-accent-primary/10 text-accent-primary"
                      : "bg-gradient-to-br from-violet-500 to-indigo-500 text-white",
                  )}>
                    {isUser ? <User size={13} /> : <Bot size={13} />}
                  </div>

                  <div className={cn("min-w-0 flex-1", isUser && "text-right")}>
                    <div className={cn(
                      "inline-block max-w-[85%] rounded-xl px-3.5 py-2.5 text-left text-sm leading-relaxed",
                      isUser
                        ? "rounded-tr-md bg-accent-primary text-white selection:bg-white/35 selection:text-white"
                        : "rounded-tl-md border border-app-border bg-app-surface text-tx-primary selection:bg-accent-primary/25 selection:text-tx-primary",
                    )}>
                      {isUser ? (
                        editing ? (
                          <div className="min-w-[220px] space-y-2">
                            <textarea
                              autoFocus
                              value={editDraft}
                              onChange={(event) => setEditDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                                  event.preventDefault();
                                  void handleSaveMessageEdit(message.id);
                                } else if (event.key === "Escape") {
                                  setEditingMessageId(null);
                                  setEditDraft("");
                                }
                              }}
                              rows={3}
                              className="w-full resize-y rounded-lg border border-white/30 bg-white/10 px-2 py-1.5 text-sm text-white outline-none placeholder:text-white/60"
                            />
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => { setEditingMessageId(null); setEditDraft(""); }}
                                className="rounded-md px-2 py-1 text-[11px] text-white/80 hover:bg-white/10"
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleSaveMessageEdit(message.id)}
                                disabled={!editDraft.trim()}
                                className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-accent-primary disabled:opacity-50"
                              >
                                保存
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="whitespace-pre-wrap break-words">{message.content}</div>
                        )
                      ) : (
                        <div className="markdown-body max-w-none break-words prose prose-sm dark:prose-invert
                          prose-p:my-1.5 prose-p:leading-relaxed
                          prose-headings:my-2 prose-headings:font-semibold
                          prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                          prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                          prose-code:rounded-md prose-code:bg-black/5 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none dark:prose-code:bg-white/10
                          prose-pre:my-2 prose-pre:rounded-lg prose-pre:bg-black/5 prose-pre:p-3 dark:prose-pre:bg-white/5
                          prose-blockquote:my-2 prose-blockquote:border-violet-400 prose-blockquote:text-tx-secondary
                          prose-hr:my-3 prose-a:text-accent-primary prose-a:no-underline hover:prose-a:underline
                          prose-strong:text-tx-primary prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1"
                        >
                          {message.content && (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                          )}
                          {message.isStreaming && !message.content && (
                            <div className="flex items-center gap-2 py-0.5 text-xs text-tx-tertiary">
                              <span className="flex gap-1">
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary/60 [animation-delay:-0.3s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary/60 [animation-delay:-0.15s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary/60" />
                              </span>
                              <span>{t("aiChat.thinking")}</span>
                            </div>
                          )}
                          {message.isStreaming && !!message.content && (
                            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent-primary/60 align-middle" />
                          )}
                          {message.stopped && (
                            <div className="mt-2 text-[11px] text-tx-tertiary">已停止生成</div>
                          )}
                        </div>
                      )}
                    </div>

                    {!!message.references?.length && (
                      <div className={cn("mt-2 max-w-[85%]", isUser && "ml-auto")}>
                        <p className="mb-1 flex items-center gap-1 text-[10px] text-tx-tertiary">
                          <FileText size={10} />
                          {t("aiChat.references")}
                        </p>
                        <ol className="space-y-1">
                          {message.references.map((reference, index) => {
                            const isAttachment = reference.kind === "attachment" && reference.attachmentId;
                            const clickable = !!isAttachment || !!onNavigateToNote;
                            return (
                              <li key={`${reference.kind || "note"}-${reference.attachmentId || reference.id}-${index}`}>
                                <button
                                  type="button"
                                  disabled={!clickable}
                                  onClick={() => handleReferenceClick(reference)}
                                  title={isAttachment ? reference.attachmentFilename || reference.title : reference.title}
                                  className={cn(
                                    "flex w-full items-center gap-2 rounded-lg border border-app-border bg-app-surface px-2.5 py-1.5 text-left text-[11px] transition-colors",
                                    clickable ? "cursor-pointer hover:border-accent-primary/40 hover:bg-accent-primary/5" : "cursor-default",
                                  )}
                                >
                                  <span className="shrink-0 font-semibold text-accent-primary">[{index + 1}]</span>
                                  {isAttachment ? <Paperclip size={10} className="shrink-0 text-amber-500" /> : <FileText size={10} className="shrink-0 text-violet-500" />}
                                  <span className="min-w-0 flex-1 truncate text-tx-secondary">{reference.title}</span>
                                  {clickable && <ArrowRight size={9} className="shrink-0 text-tx-tertiary" />}
                                </button>
                              </li>
                            );
                          })}
                        </ol>
                      </div>
                    )}

                    {!editing && (
                      <div className={cn(
                        "mt-1 flex items-center gap-1 text-[10px] text-tx-tertiary",
                        isUser ? "justify-end" : "justify-start",
                      )}>
                        {time && <span className="mr-0.5 select-none">{time}</span>}
                        <button
                          type="button"
                          onClick={() => void handleCopyMessage(message)}
                          disabled={!message.content}
                          title="复制"
                          className="rounded p-1 opacity-65 transition hover:bg-app-hover hover:opacity-100 disabled:opacity-30"
                        >
                          {copiedMessageId === message.id ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                        {isUser && (
                          <button
                            type="button"
                            onClick={() => handleStartEditMessage(message)}
                            disabled={isLoading}
                            title="编辑"
                            className="rounded p-1 opacity-65 transition hover:bg-app-hover hover:opacity-100 disabled:opacity-30"
                          >
                            <Pencil size={11} />
                          </button>
                        )}
                        {!isUser && !message.isStreaming && (
                          <button
                            type="button"
                            onClick={() => void handleRegenerate(message.id)}
                            disabled={isLoading}
                            title="重新生成"
                            className="rounded p-1 opacity-65 transition hover:bg-app-hover hover:opacity-100 disabled:opacity-30"
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleDeleteMessage(message.id)}
                          disabled={isLoading || message.isStreaming}
                          title="删除"
                          className="rounded p-1 opacity-65 transition hover:bg-red-500/10 hover:text-red-500 hover:opacity-100 disabled:opacity-30"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        <div className="flex items-center gap-2 px-4 pb-0 pt-2 text-xs">
          <span className="shrink-0 text-tx-tertiary">{t("aiChat.knowledgeScope") || "知识库范围"}：</span>
          <select
            value={nbScope === "all" ? "all" : nbScopeId}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "all") {
                setNbScope("all");
                setNbScopeId("");
              } else {
                setNbScope("notebook");
                setNbScopeId(value);
              }
            }}
            className="min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg px-2 py-1 text-tx-primary outline-none focus:ring-1 focus:ring-accent-primary/40"
          >
            <option value="all">{t("aiChat.scopeAll") || "当前空间"}</option>
            {appState.notebooks.map((notebook) => (
              <option key={notebook.id} value={notebook.id}>{notebook.name}</option>
            ))}
          </select>
          {nbScope === "notebook" && (
            <label className="flex shrink-0 cursor-pointer select-none items-center gap-1">
              <input
                type="checkbox"
                checked={nbIncludeChildren}
                onChange={(event) => setNbIncludeChildren(event.target.checked)}
                className="rounded accent-accent-primary"
              />
              <span className="text-tx-tertiary">{t("aiChat.includeChildren") || "含子笔记本"}</span>
            </label>
          )}
        </div>

        <div className="border-t border-app-border bg-app-surface/30 px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("aiChat.placeholder")}
              rows={1}
              disabled={isLoading}
              className="max-h-24 flex-1 resize-none rounded-xl border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary outline-none transition-all placeholder:text-tx-tertiary focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/40 disabled:opacity-70"
              style={{ minHeight: "38px" }}
              onInput={(event) => {
                const target = event.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 96)}px`;
              }}
            />
            <button
              type="button"
              onClick={isLoading ? handleStopGeneration : () => void handleSend()}
              disabled={!isLoading && !input.trim()}
              title={isLoading ? "停止生成" : "发送"}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all",
                isLoading
                  ? "bg-red-500 text-white hover:bg-red-600"
                  : input.trim()
                    ? "bg-accent-primary text-white hover:bg-accent-primary/90"
                    : "bg-app-hover text-tx-tertiary",
              )}
            >
              {isLoading ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
            </button>
          </div>
          {isLoading && (
            <p className="mt-1.5 text-right text-[10px] text-tx-tertiary">点击红色方块即可终止本次回答</p>
          )}
        </div>
      </div>
    </div>
  );
}

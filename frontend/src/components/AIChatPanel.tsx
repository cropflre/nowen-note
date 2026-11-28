import AiGeneratedNotice from "@/components/aiCollaboration/AiGeneratedNotice";
import { aiClipboardText } from "@/lib/aiContentProvenance";
import { formatAppDate, formatAppDateTime, formatAppTime, formatDateKeyInTimeZone } from "@/lib/dateTime";
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
  Search,
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
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { withAbortableAiFetch } from "@/lib/abortableAiAsk";
import { cn } from "@/lib/utils";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/store/AppContext";
import AIKnowledgeScopePicker from "@/components/AIKnowledgeScopePicker";
import PluginPromptPicker from "@/components/PluginPromptPicker";
import { openAICollaboration } from "@/lib/aiCollaboration";
import { taskDigestApi } from "@/lib/taskDigestApi";
import { parseAiTaskIntent } from "@/lib/aiTaskIntent";

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
const DEFAULT_CONVERSATION_SIDEBAR_WIDTH = 256;
const MIN_CONVERSATION_SIDEBAR_WIDTH = 220;
const MAX_CONVERSATION_SIDEBAR_WIDTH = 480;
const CONVERSATION_SIDEBAR_WIDTH_KEY = "nowen-ai-conversation-sidebar-width";
const deriveTitleFromQuestion = (question: string) => question.trim().replace(/\s+/g, " ").slice(0, 20);

function formatMessageTime(value?: string): string {
  if (!value) return "";
  return formatAppDateTime(
    value,
    {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
    "",
    [],
  );
}

function formatConversationTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (formatDateKeyInTimeZone(date) === formatDateKeyInTimeZone(now)) {
    return formatAppTime(date, { hour: "2-digit", minute: "2-digit" }, "", []);
  }
  return formatAppDate(date, { month: "2-digit", day: "2-digit" }, "", []);
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

const aiChatMarkdownComponents: Components = {
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-lg bg-black/5 p-3 dark:bg-white/5">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="my-0 w-max min-w-full border-collapse text-xs">
        {children}
      </table>
    </div>
  ),
};

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
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  useEffect(() => registerMobileBackHandler("sheet", () => {
    if (!sidebarOpen || window.innerWidth >= 768) return false;
    setSidebarOpen(false);
    return true;
  }), [sidebarOpen]);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [conversationSidebarWidth, setConversationSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_CONVERSATION_SIDEBAR_WIDTH;
    try {
      const raw = window.localStorage.getItem(CONVERSATION_SIDEBAR_WIDTH_KEY);
      if (!raw) return DEFAULT_CONVERSATION_SIDEBAR_WIDTH;
      const stored = Number(raw);
      if (!Number.isFinite(stored)) return DEFAULT_CONVERSATION_SIDEBAR_WIDTH;
      return Math.max(MIN_CONVERSATION_SIDEBAR_WIDTH, Math.min(MAX_CONVERSATION_SIDEBAR_WIDTH, stored));
    } catch {
      return DEFAULT_CONVERSATION_SIDEBAR_WIDTH;
    }
  });
  const [conversationQuery, setConversationQuery] = useState("");
  const [expandedReferenceIds, setExpandedReferenceIds] = useState<Set<string>>(() => new Set());
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
  const panelRef = useRef<HTMLDivElement>(null);
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
    if (isLoading) return;
    if (window.innerWidth < 768) setSidebarOpen(false);
    if (conversationId === currentConvId) return;
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
      if (window.innerWidth < 768) setSidebarOpen(false);
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
      // Keep task command recognition separate from translatable UI copy.
      // Every task write still requires explicit user confirmation.
      const taskIntent = parseAiTaskIntent(args.question);
      if (taskIntent?.kind === "create" || taskIntent?.kind === "complete") {
        const creating = taskIntent.kind === "create";
        const title = creating ? taskIntent.title : taskIntent.taskId;
        const approved = await confirmDialog({
          title: t(creating ? "aiChatTask.createTitle" : "aiChatTask.completeTitle"),
          description: t(creating ? "aiChatTask.newTask" : "aiChatTask.taskId", { title }),
          confirmText: t(creating ? "aiChatTask.createConfirm" : "aiChatTask.completeConfirm"),
          cancelText: t("common.cancel"),
        });
        if (!approved) {
          finalContent = t("aiChatTask.cancelled");
        } else if (creating) {
          const task = await taskDigestApi.createPersonalTask(title);
          finalContent = t("aiChatTask.created", { title, id: task.id });
        } else {
          await taskDigestApi.completePersonalTask(title);
          finalContent = t("aiChatTask.completed", { title });
        }
        setMessages((previous) => previous.map((message) =>
          message.id === args.assistantMessage.id ? { ...message, content: finalContent } : message));
      } else if (taskIntent?.kind === "digest") {
        const digest = await taskDigestApi.preview(taskIntent.mode);
        finalContent = [`### ${digest.date} · ${t(taskIntent.mode === "morning" ? "aiChatTask.todayTasks" : "aiChatTask.todayProgress")}`,
          digest.summary,
          ...digest.tasks.map((task) => `- ${task.title}${task.dueAt ? t("aiChatTask.dueAt", { dueAt: task.dueAt }) : ""}`),
          t("aiChatTask.dataSource")].join("\n\n");
        setMessages((previous) => previous.map((message) =>
          message.id === args.assistantMessage.id ? { ...message, content: finalContent } : message));
      } else {
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
      }
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
      await navigator.clipboard.writeText(aiClipboardText(message.content, message.role === "assistant", t("ai.generatedLabel")));
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1500);
    } catch {
      // Clipboard permission may be denied in an embedded WebView.
    }
  }, [t]);

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
        setBatchResult(t("aiChatUi.noNotesToFormat"));
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

  const normalizedConversationQuery = conversationQuery.trim().toLocaleLowerCase();
  const filteredConversations = normalizedConversationQuery
    ? conversations.filter((conversation) =>
        `${conversation.title} ${conversation.lastMessage || ""}`.toLocaleLowerCase().includes(normalizedConversationQuery)
      )
    : conversations;
  const currentConversation = conversations.find((conversation) => conversation.id === currentConvId);

  const toggleReferences = (messageId: string) => {
    setExpandedReferenceIds((previous) => {
      const next = new Set(previous);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const handleReferenceClick = (reference: ChatReference) => {
    const isAttachment = reference.kind === "attachment" && reference.attachmentId;
    if (isAttachment && reference.attachmentId) {
      window.open(resolveAttachmentUrl(`/api/attachments/${reference.attachmentId}?download=1`), "_blank");
    } else if (onNavigateToNote) {
      onNavigateToNote(reference.id);
    }
  };

  const clampConversationSidebarWidth = useCallback((width: number) => {
    const panelWidth = panelRef.current?.getBoundingClientRect().width || window.innerWidth;
    const responsiveMax = Math.min(
      MAX_CONVERSATION_SIDEBAR_WIDTH,
      Math.max(MIN_CONVERSATION_SIDEBAR_WIDTH, panelWidth * 0.45),
    );
    return Math.max(MIN_CONVERSATION_SIDEBAR_WIDTH, Math.min(responsiveMax, width));
  }, []);

  const persistConversationSidebarWidth = useCallback((width: number) => {
    try {
      window.localStorage.setItem(CONVERSATION_SIDEBAR_WIDTH_KEY, String(Math.round(width)));
    } catch {
      // 隐私模式下存储可能不可用，当前会话内仍可正常调整宽度。
    }
  }, []);

  const handleConversationSidebarResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = conversationSidebarWidth;
    let latestWidth = startWidth;
    setSidebarResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (moveEvent: MouseEvent) => {
      latestWidth = clampConversationSidebarWidth(startWidth + moveEvent.clientX - startX);
      setConversationSidebarWidth(latestWidth);
    };
    const handleMouseUp = () => {
      setSidebarResizing(false);
      persistConversationSidebarWidth(latestWidth);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [clampConversationSidebarWidth, conversationSidebarWidth, persistConversationSidebarWidth]);

  const setConversationSidebarWidthAndPersist = useCallback((width: number) => {
    const nextWidth = clampConversationSidebarWidth(width);
    setConversationSidebarWidth(nextWidth);
    persistConversationSidebarWidth(nextWidth);
  }, [clampConversationSidebarWidth, persistConversationSidebarWidth]);

  useEffect(() => {
    const clampToCurrentPanel = () => {
      setConversationSidebarWidth((width) => clampConversationSidebarWidth(width));
    };
    clampToCurrentPanel();
    window.addEventListener("resize", clampToCurrentPanel);
    return () => window.removeEventListener("resize", clampToCurrentPanel);
  }, [clampConversationSidebarWidth]);

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 min-w-0 max-w-full bg-gradient-to-br from-app-bg via-app-bg to-indigo-500/[0.03] dark:to-indigo-500/[0.06]" onKeyDown={(event) => { if (event.key === "Escape" && window.innerWidth < 768) setSidebarOpen(false); }}>
      {sidebarOpen && <button aria-label={t("aiChat.collapseSidebar")} className="absolute inset-0 z-20 bg-black/35 backdrop-blur-[2px] md:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside aria-label={t("aiChat.conversations")} className={cn(
        "absolute inset-y-0 left-0 z-30 max-w-[calc(100%-2.5rem)] shrink-0 flex-col overflow-hidden border-r border-app-border/75 bg-app-surface/92 backdrop-blur-xl md:static md:max-w-none md:bg-app-surface/60",
        sidebarOpen ? "flex" : "hidden",
        !sidebarResizing && "transition-[width] duration-200",
      )} style={{ width: sidebarOpen ? conversationSidebarWidth : 0 }}>
        <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5 pt-3.5">
          <button type="button" aria-label={t("aiChat.collapseSidebar")} className="rounded-lg p-1 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary md:hidden" onClick={() => setSidebarOpen(false)}><X size={14} /></button>
          <div>
            <div className="text-xs font-bold tracking-tight text-tx-primary">{t("aiChat.conversations")}</div>
            <div className="mt-0.5 text-[10px] text-tx-tertiary">{t("aiChatUi.conversationCount", { count: conversations.length })}</div>
          </div>
          <button
            type="button"
            onClick={() => void handleNewConversation()}
            disabled={isLoading}
            title={t("aiChat.newConversation")}
            className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-sm shadow-indigo-500/25 transition-all hover:-translate-y-[1px] hover:from-indigo-500 hover:to-violet-500 hover:shadow-md active:scale-95 disabled:opacity-50"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="px-3 pb-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-app-border/75 bg-app-bg/80 px-2.5 py-1.5 text-tx-tertiary shadow-inner shadow-black/[0.02] transition-all focus-within:border-accent-primary/50 focus-within:ring-4 focus-within:ring-accent-primary/10">
            <Search size={12} className="shrink-0" />
            <input
              value={conversationQuery}
              onChange={(event) => setConversationQuery(event.target.value)}
              placeholder={t("aiChatUi.searchConversations")}
              aria-label={t("aiChatUi.searchHistory")}
              className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
            />
            {conversationQuery && (
              <button
                type="button"
                onClick={() => setConversationQuery("")}
                title={t("aiChatUi.clearSearch")}
                className="rounded-md p-0.5 hover:bg-app-hover hover:text-tx-primary"
              >
                <X size={10} />
              </button>
            )}
          </div>
        </div>
        <ScrollArea className="min-w-0 flex-1">
          <div
            className="min-w-0 space-y-1.5 overflow-hidden px-2.5 pb-3"
            style={{ width: Math.max(0, conversationSidebarWidth - 1) }}
          >
            {!conversations.length && (
              <div className="rounded-2xl border border-dashed border-app-border/70 px-3 py-6 text-center text-[11px] text-tx-tertiary">{t("aiChat.noConversations")}</div>
            )}
            {!!conversations.length && !filteredConversations.length && (
              <div className="px-2 py-6 text-center text-[11px] text-tx-tertiary">{t("aiChatUi.noMatchingConversations")}</div>
            )}
            {filteredConversations.map((conversation) => {
              const active = conversation.id === currentConvId;
              const displayTitle = conversation.title || t("aiChat.untitledConversation");
              const isRenaming = renamingId === conversation.id;
              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group relative flex w-full min-w-0 cursor-pointer gap-2.5 rounded-2xl border px-2.5 py-2.5 text-xs transition-all duration-150",
                    active
                      ? "border-accent-primary/25 bg-gradient-to-r from-indigo-500/[0.11] via-violet-500/[0.06] to-transparent text-accent-primary shadow-sm dark:border-indigo-400/25 dark:from-indigo-500/18 dark:via-violet-500/10"
                      : "border-transparent text-tx-secondary hover:border-app-border/60 hover:bg-app-hover/75",
                  )}
                  onClick={() => !isRenaming && void handleSelectConversation(conversation.id)}
                >
                  {active && <span className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-full bg-gradient-to-b from-indigo-500 to-violet-500" />}
                  <div className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:scale-105",
                    active ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-500/25" : "bg-app-hover text-tx-tertiary",
                  )}>
                    <MessageSquare size={11} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex w-full min-w-0 max-w-full items-start gap-1.5 overflow-hidden">
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
                          className="min-w-0 flex-1 rounded-lg border border-accent-primary/40 bg-app-bg px-1.5 py-0.5 text-xs text-tx-primary outline-none"
                        />
                      ) : (
                        <span className="block min-w-0 flex-1 truncate font-semibold leading-4" title={displayTitle}>{displayTitle}</span>
                      )}
                      {!isRenaming && (
                        <span className="shrink-0 pt-0.5 font-mono text-[9px] text-tx-tertiary">{formatConversationTime(conversation.updatedAt)}</span>
                      )}
                    </div>
                    {!isRenaming && (
                      <div className="mt-1 flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[10px] text-tx-tertiary">
                          {conversation.lastMessage || t("aiChatUi.noMessages")}
                        </span>
                        <span className="shrink-0 rounded-full bg-app-hover/80 px-1.5 py-0.5 font-mono text-[9px] text-tx-tertiary">{conversation.messageCount}</span>
                        <div className="ml-0.5 flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); handleStartRename(conversation); }}
                            title={t("aiChat.renameConversation")}
                            className="flex h-5 w-5 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-surface hover:text-tx-primary"
                          >
                            <Pencil size={10} />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); void handleDeleteConversation(conversation.id); }}
                            title={t("aiChat.deleteConversation")}
                            className="flex h-5 w-5 items-center justify-center rounded-md text-tx-tertiary hover:bg-rose-500/12 hover:text-rose-500"
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      {sidebarOpen && (
        <div
          role="separator"
          aria-label={t("aiChatUi.resizeHistory")}
          aria-orientation="vertical"
          aria-valuemin={MIN_CONVERSATION_SIDEBAR_WIDTH}
          aria-valuemax={MAX_CONVERSATION_SIDEBAR_WIDTH}
          aria-valuenow={Math.round(conversationSidebarWidth)}
          tabIndex={0}
          onMouseDown={handleConversationSidebarResizeStart}
          onDoubleClick={() => setConversationSidebarWidthAndPersist(DEFAULT_CONVERSATION_SIDEBAR_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setConversationSidebarWidthAndPersist(
              conversationSidebarWidth + (event.key === "ArrowRight" ? 16 : -16),
            );
          }}
          title={t("aiChatUi.resizeHistoryHint")}
          className="group relative z-10 -ml-0.5 hidden w-1.5 shrink-0 cursor-col-resize items-center justify-center outline-none transition-colors hover:bg-accent-primary/10 focus:bg-accent-primary/10 active:bg-accent-primary/15 md:flex"
        >
          <div className="h-10 w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-accent-primary/60 group-focus:bg-accent-primary/60" />
        </div>
      )}

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div data-ai-chat-header className="grid grid-cols-[minmax(0,1fr)_auto] md:flex shrink-0 min-h-12 min-w-0 items-center justify-between gap-1.5 border-b border-app-border/75 bg-app-surface/75 px-2.5 py-1.5 backdrop-blur-xl md:min-h-14 md:px-6 md:py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 md:gap-2.5">
            <button
              type="button"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-expanded={sidebarOpen}
              title={sidebarOpen ? t("aiChat.collapseSidebar") : t("aiChat.expandSidebar")}
              className="rounded-xl p-1.5 text-tx-tertiary transition-all hover:bg-app-hover hover:text-tx-primary active:scale-95"
            >
              <Menu size={14} />
            </button>
            <div className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-xl md:flex bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_4px_14px_-4px_rgba(99,102,241,0.45)]">
              <Bot size={15} className="text-white" />
            </div>
            <div className="min-w-0">
              <div className="max-w-96 truncate text-sm font-bold tracking-tight text-tx-primary">
                {currentConversation?.title || t("aiChat.title")}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] text-tx-tertiary">
                <span>{t("aiChat.title")}</span>
                {stats && <><span>·</span><span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 font-medium text-indigo-600 dark:text-indigo-300">{t("aiChat.statsNotes", { count: stats.noteCount })}</span></>}
              </div>
            </div>
          </div>
          <div className="col-start-2 row-start-1 flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={openAICollaboration} aria-label={t("aiCollaboration.entry")} title={t("aiCollaboration.entry")} className="rounded-xl border border-transparent p-1.5 text-accent-primary transition-all hover:border-accent-primary/25 hover:bg-accent-primary/10 active:scale-95"><Sparkles size={14} /></button>
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              disabled={isLoading}
              title={t("aiChat.newConversation")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface/85 px-2.5 py-1.5 text-[11px] font-semibold text-tx-secondary shadow-sm transition-all hover:-translate-y-[1px] hover:border-accent-primary/40 hover:bg-accent-primary/8 hover:text-accent-primary active:translate-y-[0.5px] disabled:opacity-50"
            >
              <Plus size={14} />
              <span className="hidden lg:inline">{t("aiChat.newConversation")}</span>
            </button>
            {!!messages.length && (
              <button
                type="button"
                onClick={clearChat}
                title={t("aiChat.clearChat")}
                className="rounded-xl p-1.5 text-tx-tertiary transition-all hover:bg-rose-500/10 hover:text-rose-500 active:scale-95"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-1.5 text-tx-tertiary transition-all hover:bg-app-hover hover:text-tx-primary active:scale-95"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <ScrollArea
          className="min-h-0 min-w-0 flex-1 bg-transparent [&>[data-radix-scroll-area-viewport]>div]:!block"
          scrollbarClassName="w-3 bg-app-surface/70"
          thumbClassName="bg-tx-tertiary/50 hover:bg-tx-secondary/70"
        >
          <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4 px-3 py-4 md:space-y-6 md:px-8 md:py-8">
            {historyLoading && !messages.length && (
              <div className="flex items-center justify-center py-10 text-tx-tertiary">
                <Loader2 size={18} className="animate-spin text-accent-primary" />
              </div>
            )}

            {!historyLoading && !messages.length && (
              <div className="relative flex flex-col items-center justify-center py-4 text-center md:py-12">
                <div className="pointer-events-none absolute top-4 h-44 w-72 rounded-full bg-gradient-to-tr from-indigo-500/12 via-violet-500/10 to-sky-400/12 blur-3xl dark:from-indigo-500/18 dark:via-violet-500/16 dark:to-cyan-400/14" aria-hidden="true" />
                <div className="relative mb-3 hidden h-12 w-12 md:mb-5 md:flex md:h-16 md:w-16 items-center justify-center rounded-[22px] bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_4px_0_rgba(79,70,229,0.28),0_16px_32px_-10px_rgba(99,102,241,0.5)] transition-transform duration-300 hover:-translate-y-1 hover:rotate-[-4deg]">
                  <Sparkles size={26} className="text-white" />
                </div>
                <p className="relative mb-1.5 text-lg font-bold tracking-tight text-tx-primary">{t("aiChat.empty")}</p>
                <p className="relative mb-4 md:mb-6 max-w-md text-xs leading-5 text-tx-secondary">{t("aiChat.emptyHint")}</p>

                {stats && stats.noteCount > 0 && (
                  <div className="relative mb-4 hidden md:block md:mb-6 w-full max-w-lg">
                    <div className="grid grid-cols-3 gap-3">
                      <div className="flex flex-col items-center rounded-2xl border border-app-border/75 bg-app-surface/85 px-3 py-3 shadow-sm backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-indigo-400/40 hover:shadow-md">
                        <span className="mb-1.5 inline-flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-500/12 text-indigo-600 ring-1 ring-inset ring-indigo-500/20 dark:text-indigo-300">
                          <BookOpen size={15} />
                        </span>
                        <span className="font-mono text-lg font-bold tabular-nums text-tx-primary">{stats.noteCount}</span>
                        <span className="text-[10px] font-medium text-tx-tertiary">{t("aiChat.statNotes")}</span>
                      </div>
                      <div className="flex flex-col items-center rounded-2xl border border-app-border/75 bg-app-surface/85 px-3 py-3 shadow-sm backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-emerald-400/40 hover:shadow-md">
                        <span className="mb-1.5 inline-flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300">
                          <Database size={15} />
                        </span>
                        <span className="font-mono text-lg font-bold tabular-nums text-tx-primary">{stats.ftsCount}</span>
                        <span className="text-[10px] font-medium text-tx-tertiary">{t("aiChat.statIndexed")}</span>
                      </div>
                      <div className="flex flex-col items-center rounded-2xl border border-app-border/75 bg-app-surface/85 px-3 py-3 shadow-sm backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-amber-400/40 hover:shadow-md">
                        <span className="mb-1.5 inline-flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 ring-1 ring-inset ring-amber-500/20 dark:text-amber-300">
                          <FileText size={15} />
                        </span>
                        <span className="font-mono text-lg font-bold tabular-nums text-tx-primary">{stats.notebookCount}</span>
                        <span className="text-[10px] font-medium text-tx-tertiary">{t("aiChat.statNotebooks")}</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="relative mb-4 md:mb-6 w-full max-w-lg">
                  <button
                    type="button"
                    onClick={() => setShowTools((value) => !value)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-full border border-app-border/75 bg-app-surface/80 px-3.5 py-1.5 text-[11px] font-medium text-tx-secondary shadow-sm backdrop-blur-sm transition-all hover:border-accent-primary/40 hover:text-accent-primary"
                  >
                    <Wand2 size={11} />
                    {t("aiChat.toolsSection")}
                    {showTools ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>

                  {showTools && (
                    <div className="mt-3 space-y-2.5 text-left">
                      <div
                        {...docDropHandlers}
                        className={cn(
                          "rounded-2xl border bg-app-surface/85 p-3.5 shadow-sm backdrop-blur-md transition-all",
                          docDragOver
                            ? "border-blue-500 bg-blue-500/5 ring-2 ring-blue-500/30"
                            : "border-app-border/75",
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-blue-500/12 text-blue-600 dark:text-blue-400"><FileUp size={13} /></span>
                          <span className="text-xs font-semibold text-tx-primary">{t("aiChat.docParse")}</span>
                        </div>
                        <p className="mb-2.5 text-[11px] text-tx-tertiary">{t("aiChat.docParseDesc")}</p>
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
                          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-500/12 px-3 py-2 text-xs font-semibold text-blue-600 ring-1 ring-inset ring-blue-500/20 transition-all hover:bg-blue-500/20 disabled:opacity-50 dark:text-blue-300"
                        >
                          {docParsing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                          {docParsing ? t("aiChat.parsing") : t("aiChat.uploadDoc")}
                        </button>
                        <p className="mt-1.5 text-center text-[9px] text-tx-tertiary">{t("aiChat.uploadDocHint")}</p>
                        {docResult && (
                          <div className="mt-2.5 rounded-xl border border-app-border/75 bg-app-bg">
                            <div className="flex items-center justify-between border-b border-app-border/70 px-2.5 py-1.5">
                              <span className="truncate text-[10px] font-medium text-tx-secondary">{docFileName}</span>
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
                            <div className="max-h-40 overflow-auto whitespace-pre-wrap p-2.5 text-[10px] text-tx-secondary">
                              {docResult.slice(0, 1000)}{docResult.length > 1000 && "..."}
                            </div>
                          </div>
                        )}
                      </div>

                      <div
                        {...importDropHandlers}
                        className={cn(
                          "rounded-2xl border bg-app-surface/85 p-3.5 shadow-sm backdrop-blur-md transition-all",
                          importDragOver
                            ? "border-emerald-500 bg-emerald-500/5 ring-2 ring-emerald-500/30"
                            : "border-app-border/75",
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"><FolderUp size={13} /></span>
                          <span className="text-xs font-semibold text-tx-primary">{t("aiChat.importKnowledge")}</span>
                        </div>
                        <p className="mb-2.5 text-[11px] text-tx-tertiary">{t("aiChat.importKnowledgeDesc")}</p>
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
                          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-500/12 px-3 py-2 text-xs font-semibold text-emerald-600 ring-1 ring-inset ring-emerald-500/20 transition-all hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-300"
                        >
                          {importLoading ? <Loader2 size={12} className="animate-spin" /> : <FolderUp size={12} />}
                          {importLoading ? t("aiChat.importing") : t("aiChat.importFiles")}
                        </button>
                        <p className="mt-1.5 text-center text-[9px] text-tx-tertiary">{t("aiChat.importFilesHint")}</p>
                        {importResult && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-xl bg-emerald-500/10 px-2.5 py-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                            <Check size={10} />
                            {importResult}
                          </div>
                        )}
                      </div>

                      <div className="rounded-2xl border border-app-border/75 bg-app-surface/85 p-3.5 shadow-sm backdrop-blur-md">
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-amber-500/12 text-amber-600 dark:text-amber-400"><Wand2 size={13} /></span>
                          <span className="text-xs font-semibold text-tx-primary">{t("aiChat.batchFormat")}</span>
                        </div>
                        <p className="mb-2.5 text-[11px] text-tx-tertiary">{t("aiChat.batchFormatDesc")}</p>
                        <button
                          type="button"
                          onClick={() => void handleBatchFormat()}
                          disabled={batchLoading}
                          className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500/12 px-3 py-2 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-500/20 transition-all hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-300"
                        >
                          {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                          {batchLoading ? t("aiChat.formatting") : t("aiChat.batchFormat")}
                        </button>
                        <p className="mt-1.5 text-center text-[9px] text-tx-tertiary">{t("aiChat.selectNotesHint")}</p>
                        {batchResult && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-xl bg-amber-500/10 px-2.5 py-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                            <Check size={10} />
                            {batchResult}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="relative w-full max-w-2xl">
                  <p className="mb-2.5 flex items-center justify-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-tx-tertiary">
                    <MessageCircleQuestion size={11} className="text-accent-primary" />
                    {t("aiChat.trySuggestions")}
                  </p>
                  <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                    {suggestedQuestions.map((question, index) => (
                      <button
                        key={question}
                        type="button"
                        onClick={() => { if (!isLoading) void handleSend(question); }}
                        className={cn("group w-full items-center justify-between gap-2 rounded-2xl border border-app-border/75 bg-app-surface/85 px-4 py-3 text-left text-xs font-medium text-tx-secondary shadow-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-primary/40 hover:bg-app-elevated hover:text-accent-primary hover:shadow-md active:translate-y-0", index > 1 ? "hidden md:flex" : "flex")}
                      >
                        <span className="leading-5">{question}</span>
                        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-app-hover/80 text-tx-tertiary transition-all group-hover:translate-x-0.5 group-hover:bg-accent-primary/12 group-hover:text-accent-primary">
                          <ArrowRight size={12} />
                        </span>
                      </button>
                    ))}
                  </div>
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
                  className={cn(
                    // 新消息上浮淡入；流式输出期间 key 不变，内容增长不会重播动画。
                    "animate-nowen-rise-in group/message flex w-full min-w-0 max-w-full gap-3",
                    isUser ? "flex-row-reverse pl-8 sm:pl-12" : "pr-2 sm:pr-4",
                  )}
                >
                  <div className={cn(
                    "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl",
                    isUser
                      ? "border border-app-border/70 bg-app-surface text-tx-secondary shadow-sm"
                      : "bg-gradient-to-br from-violet-500 via-indigo-500 to-sky-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_4px_12px_-4px_rgba(99,102,241,0.45)]",
                  )}>
                    {isUser ? <User size={13} /> : <Bot size={14} />}
                  </div>

                  <div className={cn("min-w-0", isUser ? "max-w-[82%] sm:max-w-[78%] text-right" : "flex-1")}>
                    <div className={cn(
                      "inline-block min-w-0 text-left text-sm leading-7 [overflow-wrap:anywhere]",
                      isUser
                        ? "max-w-full rounded-2xl rounded-tr-md bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-600 px-4 py-2.5 text-white shadow-[0_8px_20px_-10px_rgba(99,102,241,0.55)] selection:bg-white/35 selection:text-white"
                        : "w-full rounded-2xl rounded-tl-md border border-app-border/70 bg-app-surface/80 px-4 py-3 text-tx-primary shadow-[0_8px_24px_-18px_rgba(15,23,42,0.16)] backdrop-blur-sm selection:bg-accent-primary/25 selection:text-tx-primary dark:bg-app-surface/65",
                    )}>
                      {isUser ? (
                        editing ? (
                          <div className="min-w-0 max-w-full space-y-2">
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
                              className="w-full min-w-0 max-w-full resize-y rounded-xl border border-white/30 bg-white/10 px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-white/60"
                            />
                            <div className="flex justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => { setEditingMessageId(null); setEditDraft(""); }}
                                className="rounded-lg px-2.5 py-1 text-[11px] text-white/85 hover:bg-white/15"
                              >
                                {t("aiChatUi.cancel")}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleSaveMessageEdit(message.id)}
                                disabled={!editDraft.trim()}
                                className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-semibold text-indigo-600 shadow-sm disabled:opacity-50"
                              >
                                {t("aiChatUi.save")}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</div>
                        )
                      ) : (
                        <div className="markdown-body min-w-0 max-w-full break-words [overflow-wrap:anywhere] prose prose-sm dark:prose-invert
                          prose-p:my-1.5 prose-p:leading-relaxed
                          prose-headings:my-2 prose-headings:font-semibold
                          prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                          prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                          prose-code:break-words prose-code:rounded-md prose-code:bg-black/5 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none dark:prose-code:bg-white/10
                          prose-blockquote:my-2 prose-blockquote:border-violet-400 prose-blockquote:text-tx-secondary
                          prose-hr:my-3 prose-a:text-accent-primary prose-a:no-underline hover:prose-a:underline
                          prose-strong:text-tx-primary prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1
                          [&_a]:[overflow-wrap:anywhere] [&_code]:[overflow-wrap:anywhere]
                          [&_p]:max-w-full [&_pre]:max-w-full [&_pre_code]:whitespace-pre [&_pre_code]:break-normal [&_pre_code]:[overflow-wrap:normal]"
                        >
                          <AiGeneratedNotice />
                          {message.content && (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={aiChatMarkdownComponents}>{message.content}</ReactMarkdown>
                          )}
                          {message.isStreaming && !message.content && (
                            <div className="flex items-center gap-2 py-0.5 text-xs text-tx-tertiary">
                              <span className="flex gap-1">
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-indigo-500/70 [animation-delay:-0.3s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-500/70 [animation-delay:-0.15s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500/70" />
                              </span>
                              <span>{t("aiChat.thinking")}</span>
                            </div>
                          )}
                          {message.isStreaming && !!message.content && (
                            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent-primary/65 align-middle" />
                          )}
                          {message.stopped && (
                            <div className="mt-2 text-[11px] text-tx-tertiary">{t("aiChatUi.generationStopped")}</div>
                          )}
                        </div>
                      )}
                    </div>

                    {!!message.references?.length && (
                      <div className={cn("mt-2.5 min-w-0", isUser && "ml-auto")}>
                        <div className="overflow-hidden rounded-2xl border border-app-border/75 bg-app-surface/80 shadow-sm backdrop-blur-sm">
                          <button
                            type="button"
                            onClick={() => toggleReferences(message.id)}
                            aria-expanded={expandedReferenceIds.has(message.id)}
                            className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-[11px] text-tx-secondary transition-colors hover:bg-app-hover/70"
                          >
                            <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-indigo-500/12 text-indigo-600 ring-1 ring-inset ring-indigo-500/20 dark:text-indigo-300">
                              <FileText size={10} />
                            </span>
                            <span className="font-semibold">{t("aiChat.references")}</span>
                            <span className="rounded-full bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-indigo-600 dark:text-indigo-300">
                              {message.references.length}
                            </span>
                            <span className="ml-auto text-tx-tertiary">
                              {expandedReferenceIds.has(message.id) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </span>
                          </button>
                          {expandedReferenceIds.has(message.id) && (
                            <ol className="min-w-0 max-w-full space-y-1 border-t border-app-border/65 p-2">
                              {message.references.map((reference, index) => {
                                const isAttachment = reference.kind === "attachment" && reference.attachmentId;
                                const clickable = !!isAttachment || !!onNavigateToNote;
                                return (
                                  <li className="min-w-0 max-w-full" key={`${reference.kind || "note"}-${reference.attachmentId || reference.id}-${index}`}>
                                    <button
                                      type="button"
                                      disabled={!clickable}
                                      onClick={() => handleReferenceClick(reference)}
                                      title={isAttachment ? reference.attachmentFilename || reference.title : reference.title}
                                      className={cn(
                                        "group flex w-full min-w-0 max-w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[11px] transition-all",
                                        clickable ? "cursor-pointer hover:bg-accent-primary/8" : "cursor-default",
                                      )}
                                    >
                                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-app-hover font-mono text-[10px] font-semibold text-accent-primary">{index + 1}</span>
                                      {isAttachment ? <Paperclip size={11} className="shrink-0 text-amber-500" /> : <FileText size={11} className="shrink-0 text-violet-500" />}
                                      <span className="min-w-0 flex-1 truncate font-medium text-tx-secondary group-hover:text-tx-primary">{reference.title}</span>
                                      {clickable && <ArrowRight size={10} className="shrink-0 text-tx-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-accent-primary" />}
                                    </button>
                                  </li>
                                );
                              })}
                            </ol>
                          )}
                        </div>
                      </div>
                    )}

                    {!editing && (
                      <div className={cn(
                        "mt-1.5 flex items-center gap-1 text-[10px] text-tx-tertiary opacity-70 transition-opacity group-hover/message:opacity-100",
                        isUser ? "justify-end" : "justify-start",
                      )}>
                        {time && <span className="mr-0.5 select-none font-mono">{time}</span>}
                        <button
                          type="button"
                          onClick={() => void handleCopyMessage(message)}
                          disabled={!message.content}
                          title={t("aiChatUi.copy")}
                          className="rounded-lg p-1 opacity-70 transition hover:bg-app-hover hover:text-tx-primary hover:opacity-100 disabled:opacity-30"
                        >
                          {copiedMessageId === message.id ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                        </button>
                        {isUser && (
                          <button
                            type="button"
                            onClick={() => handleStartEditMessage(message)}
                            disabled={isLoading}
                            title={t("aiChatUi.edit")}
                            className="rounded-lg p-1 opacity-70 transition hover:bg-app-hover hover:text-tx-primary hover:opacity-100 disabled:opacity-30"
                          >
                            <Pencil size={11} />
                          </button>
                        )}
                        {!isUser && !message.isStreaming && (
                          <button
                            type="button"
                            onClick={() => void handleRegenerate(message.id)}
                            disabled={isLoading}
                            title={t("aiChatUi.regenerate")}
                            className="rounded-lg p-1 opacity-70 transition hover:bg-app-hover hover:text-tx-primary hover:opacity-100 disabled:opacity-30"
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleDeleteMessage(message.id)}
                          disabled={isLoading || message.isStreaming}
                          title={t("aiChatUi.delete")}
                          className="rounded-lg p-1 opacity-70 transition hover:bg-rose-500/12 hover:text-rose-500 hover:opacity-100 disabled:opacity-30"
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

        <div className="shrink-0 border-t border-app-border/75 bg-app-surface/75 px-2.5 py-2.5 backdrop-blur-xl md:px-6 md:py-4">
          <div className="mx-auto max-w-4xl rounded-2xl border border-app-border/80 bg-app-bg/90 shadow-[0_12px_32px_-16px_rgba(15,23,42,0.16)] backdrop-blur-md transition-all focus-within:border-accent-primary/50 focus-within:ring-4 focus-within:ring-accent-primary/12 dark:shadow-[0_16px_36px_-18px_rgba(0,0,0,0.6)]">
            <div className="flex min-h-8 flex-wrap items-center gap-2 border-b border-app-border/65 px-3.5 py-1.5 text-[10px]">
              <div className="flex min-w-0 max-w-full items-center gap-1.5 text-tx-tertiary">
                <Database size={11} className="shrink-0 text-accent-primary" />
                <span className="shrink-0 font-medium">{t("aiChat.knowledgeScope")}</span>
                <AIKnowledgeScopePicker
                  notebooks={appState.notebooks}
                  value={nbScope === "all" ? "" : nbScopeId}
                  allLabel={t("aiChat.scopeAll")}
                  onChange={(value) => {
                    if (!value) {
                      setNbScope("all");
                      setNbScopeId("");
                      return;
                    }
                    setNbScope("notebook");
                    setNbScopeId(value);
                  }}
                />
              </div>
              {nbScope === "notebook" && (
                <label className="flex shrink-0 cursor-pointer select-none items-center gap-1 text-tx-tertiary">
                  <input
                    type="checkbox"
                    checked={nbIncludeChildren}
                    onChange={(event) => setNbIncludeChildren(event.target.checked)}
                    className="rounded accent-accent-primary"
                  />
                  <span>{t("aiChat.includeChildren")}</span>
                </label>
              )}
              <PluginPromptPicker disabled={isLoading} onSelect={(value) => { setInput(value); requestAnimationFrame(() => inputRef.current?.focus()); }} />
              <span className="ml-auto hidden text-tx-tertiary lg:inline">{t("aiChatUi.keyboardHint")}</span>
            </div>
            <div className="flex items-end gap-2 p-2.5">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("aiChat.placeholder")}
                rows={1}
                disabled={isLoading}
                className="max-h-32 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 text-tx-primary outline-none placeholder:text-tx-tertiary disabled:opacity-70"
                onInput={(event) => {
                  const target = event.target as HTMLTextAreaElement;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
                }}
              />
              <button
                type="button"
                onClick={isLoading ? handleStopGeneration : () => void handleSend()}
                disabled={!isLoading && !input.trim()}
                title={isLoading ? t("aiChatUi.stopGenerating") : t("aiChatUi.send")}
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all duration-150 active:scale-95",
                  isLoading
                    ? "bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-md shadow-rose-500/25 hover:from-rose-400 hover:to-red-500"
                    : input.trim()
                      ? "bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-500/30 hover:-translate-y-[1px] hover:from-indigo-500 hover:to-violet-500"
                      : "bg-app-hover text-tx-tertiary",
                )}
              >
                {isLoading ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
              </button>
            </div>
          </div>
          {isLoading && (
            <p className="mx-auto mt-1.5 max-w-4xl text-right text-[10px] text-tx-tertiary">{t("aiChatUi.generationHint")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

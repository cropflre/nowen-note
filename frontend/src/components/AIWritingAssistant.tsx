import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, PenLine, RefreshCw, Shrink, Expand, Languages,
  FileText, HelpCircle, Wrench, Copy, Check, X, Loader2,
  ArrowRight, Replace, ChevronDown, Code2, LetterText, MessageSquarePlus, Send,
  BookmarkPlus, Trash2, Pencil
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { extractFinalAnswer } from "@/lib/aiOutput";
import { buildAiContext } from "@/lib/aiContextBuilder";

type AIAction = "continue" | "rewrite" | "polish" | "shorten" | "expand" | "translate_en" | "translate_zh" | "summarize" | "explain" | "fix_grammar" | "format_markdown" | "format_code" | "custom";

interface SavedPrompt {
  id: string;
  name: string;
  prompt: string;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AIWritingAssistantProps {
  selectedText: string;
  fullText: string;
  onInsert: (text: string) => void;
  onReplace: (text: string) => void;
  onClose: () => void;
  position?: { top: number; left: number };
}

export default function AIWritingAssistant({
  selectedText,
  fullText,
  onInsert,
  onReplace,
  onClose,
  position,
}: AIWritingAssistantProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [currentAction, setCurrentAction] = useState<AIAction | null>(null);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");
  // P2：自定义指令可持久化 ——
  //   savedPrompts     后端返回的已保存模板，按 usageCount 排序
  //   savedPromptName  保存/更新时要写入的名称（与 customPrompt 正交，专用输入框）
  //   editingId        非空时表示当前正在编辑某条已存在的模板：
  //                     - "执行"按钮调用 touch API 记一次使用
  //                     - "保存"按钮走 PUT 更新而不是新建
  //   savedLoadError   加载列表失败时静默降级；只有点击"已保存"区域时才展示错误
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [savedPromptName, setSavedPromptName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveHint, setSaveHint] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLTextAreaElement>(null);

  const actions: { id: AIAction; icon: React.ElementType; label: string; group: string }[] = [
    { id: "continue", icon: ArrowRight, label: t("ai.actionContinue"), group: "write" },
    { id: "rewrite", icon: PenLine, label: t("ai.actionRewrite"), group: "write" },
    { id: "polish", icon: Sparkles, label: t("ai.actionPolish"), group: "write" },
    { id: "shorten", icon: Shrink, label: t("ai.actionShorten"), group: "edit" },
    { id: "expand", icon: Expand, label: t("ai.actionExpand"), group: "edit" },
    { id: "fix_grammar", icon: Wrench, label: t("ai.actionFixGrammar"), group: "edit" },
    { id: "translate_zh", icon: Languages, label: t("ai.actionTranslateZh"), group: "translate" },
    { id: "translate_en", icon: Languages, label: t("ai.actionTranslateEn"), group: "translate" },
    { id: "summarize", icon: FileText, label: t("ai.actionSummarize"), group: "other" },
    { id: "explain", icon: HelpCircle, label: t("ai.actionExplain"), group: "other" },
    { id: "format_markdown", icon: LetterText, label: t("ai.actionFormatMarkdown"), group: "format" },
    { id: "format_code", icon: Code2, label: t("ai.actionFormatCode"), group: "format" },
  ];

  // 进入自定义输入面板时按需拉取列表；第一次打开时才发请求，之后复用内存中的
  // 状态，避免每次点"自定义指令"都请求一次。
  const loadSavedPrompts = useCallback(async () => {
    try {
      const res = await api.aiPrompts.list();
      setSavedPrompts(res.items);
    } catch {
      // 静默降级：只在用户尝试保存/点击时再弹错
      setSavedPrompts([]);
    }
  }, []);

  useEffect(() => {
    if (showCustomInput && savedPrompts.length === 0) {
      loadSavedPrompts();
    }
  }, [showCustomInput, savedPrompts.length, loadSavedPrompts]);

  const handleAction = useCallback(async (action: AIAction, prompt?: string) => {
    setCurrentAction(action);
    setResult("");
    setError("");
    setIsLoading(true);
    setShowCustomInput(false);

    try {
      const ctx = buildAiContext({ action, selectedText, contentText: fullText, maxInputTokens: 1800, question: action === "custom" ? prompt : undefined });
      const editActions = new Set(["polish", "rewrite", "shorten", "expand", "fix_grammar", "format_markdown", "format_code"]);
      if (!selectedText && editActions.has(action) && ctx.truncated) {
        toast.info(t("ai.noteTooLongSelectFirst") || "当前笔记较长，建议先选中一段文字处理，或使用分段处理全文。");
      } else if (ctx.notice) {
        toast.info(ctx.notice);
      }
      await api.aiChat(
        action,
        selectedText,
        ctx.promptText,
        (chunk) => {
          setResult(prev => prev + chunk);
        },
        action === "custom" ? prompt : undefined
      );
    } catch (err: any) {
      setError(err.message || t("ai.requestFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [selectedText, fullText, t]);

  const handleCustomSubmit = useCallback(() => {
    if (!customPrompt.trim()) return;
    // 若正在基于某条已保存指令执行，异步上报 usageCount（fire-and-forget）。
    // 失败不影响主流程，也不改 UI——列表刷新会在下次打开时自动带回最新次数。
    if (editingId) {
      api.aiPrompts.touch(editingId).catch(() => { /* ignore */ });
    }
    handleAction("custom", customPrompt.trim());
  }, [customPrompt, editingId, handleAction]);

  // 保存 / 更新 当前自定义指令：
  //   - editingId 为空 → 新建
  //   - editingId 非空 → PUT 更新（改名或改内容都走这里）
  // 保存完成后刷新列表并把 editingId 标为新条目，方便连续点"执行"。
  const handleSavePrompt = useCallback(async () => {
    const name = savedPromptName.trim();
    const content = customPrompt.trim();
    if (!name || !content) {
      setSaveHint({ kind: "err", msg: t("ai.customSaveFailed") });
      return;
    }
    setSaving(true);
    setSaveHint(null);
    try {
      if (editingId) {
        const updated = await api.aiPrompts.update(editingId, { name, prompt: content });
        setSavedPrompts((list) => {
          const next = list.filter((p) => p.id !== updated.id);
          next.unshift(updated);
          return next;
        });
        setSaveHint({ kind: "ok", msg: t("ai.customUpdateSuccess") });
      } else {
        const created = await api.aiPrompts.create({ name, prompt: content });
        setSavedPrompts((list) => [created, ...list]);
        setEditingId(created.id);
        setSaveHint({ kind: "ok", msg: t("ai.customSaveSuccess") });
      }
    } catch (e: any) {
      setSaveHint({ kind: "err", msg: e?.message || t("ai.customSaveFailed") });
    } finally {
      setSaving(false);
      // 2 秒后自动隐藏提示
      setTimeout(() => setSaveHint(null), 2000);
    }
  }, [savedPromptName, customPrompt, editingId, t]);

  // 点击一条已保存指令：填充到输入框、记住 editingId，不自动执行——
  // 用户可能想先改几个字再运行，立即执行反而打断节奏。
  const handlePickSavedPrompt = useCallback((p: SavedPrompt) => {
    setCustomPrompt(p.prompt);
    setSavedPromptName(p.name);
    setEditingId(p.id);
    setSaveHint(null);
    setTimeout(() => customInputRef.current?.focus(), 30);
  }, []);

  const handleDeleteSavedPrompt = useCallback(async (p: SavedPrompt, e: React.MouseEvent) => {
    e.stopPropagation();
    // 用项目统一 confirm 弹窗替代 window.confirm；danger 模式 + 默认聚焦取消，
    // 避免误删自定义指令
    const ok = await confirmDialog({
      title: t("common.delete"),
      description: t("ai.customDeleteConfirm"),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.aiPrompts.remove(p.id);
      setSavedPrompts((list) => list.filter((x) => x.id !== p.id));
      if (editingId === p.id) {
        setEditingId(null);
      }
      setSaveHint({ kind: "ok", msg: t("ai.customDeleted") });
      setTimeout(() => setSaveHint(null), 1500);
    } catch (err: any) {
      setSaveHint({ kind: "err", msg: err?.message || t("ai.customSaveFailed") });
    }
  }, [editingId, t]);

  // 自动滚动到底部
  useEffect(() => {
    if (resultRef.current) {
      resultRef.current.scrollTop = resultRef.current.scrollHeight;
    }
  }, [result]);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const handleCopy = () => {
    navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleInsert = () => {
    onInsert(result);
    onClose();
  };

  const handleReplace = () => {
    onReplace(result);
    onClose();
  };

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, y: 8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="fixed z-[60] w-[400px] max-h-[480px] flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl overflow-hidden"
      style={position ? { top: position.top, left: position.left } : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} className="text-accent-primary" />
          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t("ai.assistant")}</span>
          {currentAction && (
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
              · {actions.find(a => a.id === currentAction)?.label}
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* 选中文本预览 */}
      {selectedText && !result && !isLoading && (
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-1">{t("ai.selectedText")}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-3 leading-relaxed">{selectedText}</p>
        </div>
      )}

      {/* 动作按钮网格 */}
      {!result && !isLoading && !error && !showCustomInput && (
        <div className="p-2">
          <div className="grid grid-cols-2 gap-1">
            {actions.map(action => {
              const Icon = action.icon;
              return (
                <button
                  key={action.id}
                  onClick={() => handleAction(action.id)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 hover:text-accent-primary transition-colors text-left"
                >
                  <Icon size={13} className="shrink-0" />
                  {action.label}
                </button>
              );
            })}
          </div>
          {/* 自定义指令入口 */}
          <div className="mt-1.5 pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
            <button
              onClick={() => { setShowCustomInput(true); setTimeout(() => customInputRef.current?.focus(), 50); }}
              className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs text-zinc-500 dark:text-zinc-400 hover:bg-violet-50 dark:hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 transition-colors text-left"
            >
              <MessageSquarePlus size={13} className="shrink-0" />
              {t("ai.customAction")}
            </button>
          </div>
        </div>
      )}

      {/* 自定义指令输入框 */}
      {showCustomInput && !result && !isLoading && !error && (
        <div className="p-3 max-h-[360px] overflow-y-auto">
          {/* ── 已保存指令列表 ──
              优先级高于输入框：第一次打开就能直接点击复用。
              每行右侧露出 Pencil / Trash 两个轻按钮，不占主视觉。 */}
          {savedPrompts.length > 0 && (
            <div className="mb-3">
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-1.5 px-0.5">
                {t("ai.customSavedTitle")}
              </p>
              <div className="flex flex-col gap-0.5 max-h-[140px] overflow-y-auto">
                {savedPrompts.map((p) => {
                  const active = editingId === p.id;
                  return (
                    <div
                      key={p.id}
                      onClick={() => handlePickSavedPrompt(p)}
                      className={cn(
                        "group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer transition-colors",
                        active
                          ? "bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300"
                          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      )}
                      title={p.prompt}
                    >
                      <BookmarkPlus size={11} className="shrink-0 opacity-70" />
                      <span className="truncate flex-1">{p.name}</span>
                      {p.usageCount > 0 && (
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">
                          ×{p.usageCount}
                        </span>
                      )}
                      <button
                        onClick={(e) => handleDeleteSavedPrompt(p, e)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-500/20 text-zinc-400 hover:text-red-500 transition-all"
                        title={t("common.delete")}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-2">{t("ai.customHint")}</p>

          {/* 名称输入框：保存/更新时必填；不填则保存按钮 disabled。
              放在 prompt 上方，让"先命名再写 prompt"成为默认动线。 */}
          <input
            type="text"
            value={savedPromptName}
            onChange={(e) => setSavedPromptName(e.target.value)}
            placeholder={t("ai.customSaveNamePlaceholder")}
            maxLength={80}
            className="w-full px-3 py-1.5 mb-2 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-accent-primary/50 focus:border-accent-primary/50 placeholder:text-zinc-400"
          />

          <textarea
            ref={customInputRef}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
                // Ctrl+Enter / Cmd+Enter 才触发执行：防止用户边想边敲回车被打断
                e.preventDefault();
                handleCustomSubmit();
              }
              if (e.key === "Escape") {
                setShowCustomInput(false);
                setCustomPrompt("");
                setSavedPromptName("");
                setEditingId(null);
              }
            }}
            placeholder={t("ai.customPlaceholder")}
            className="w-full h-20 px-3 py-2 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 resize-none focus:outline-none focus:ring-1 focus:ring-accent-primary/50 focus:border-accent-primary/50 placeholder:text-zinc-400"
          />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button
              onClick={handleCustomSubmit}
              disabled={!customPrompt.trim()}
              className="flex items-center gap-1 px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/90 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-xs font-medium transition-colors"
            >
              <Send size={12} />
              {t("ai.customSend")}
            </button>
            <button
              onClick={handleSavePrompt}
              disabled={saving || !savedPromptName.trim() || !customPrompt.trim()}
              className="flex items-center gap-1 px-3 py-1.5 border border-violet-300 dark:border-violet-500/40 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-500/10 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium transition-colors"
              title={editingId ? t("ai.customUpdate") : t("ai.customSave")}
            >
              {editingId ? <Pencil size={12} /> : <BookmarkPlus size={12} />}
              {editingId ? t("ai.customUpdate") : t("ai.customSave")}
            </button>
            <button
              onClick={() => {
                setShowCustomInput(false);
                setCustomPrompt("");
                setSavedPromptName("");
                setEditingId(null);
                setSaveHint(null);
              }}
              className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              {t("common.cancel")}
            </button>
            {/* 保存提示：短时透出，避免 alert 打断操作 */}
            {saveHint && (
              <span
                className={cn(
                  "text-[11px] ml-auto transition-opacity",
                  saveHint.kind === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-500 dark:text-red-400",
                )}
              >
                {saveHint.msg}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 加载状态 / 结果展示 */}
      {(isLoading || result) && (
        <div ref={resultRef} className="flex-1 overflow-auto px-3 py-3 min-h-[100px] max-h-[280px]">
          {/* 首 chunk 返回前：展示明显的 Loader，避免用户以为卡死 */}
          {isLoading && !result && (
            <div className="flex items-center gap-2 py-4 text-xs text-zinc-500 dark:text-zinc-400">
              <Loader2 size={14} className="animate-spin text-accent-primary" />
              <span>{t("ai.generating")}</span>
            </div>
          )}
          <div className="text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed whitespace-pre-wrap">
            {/* 流式输出完成时清洗 <think>...</think> 推理内容 */}
            {isLoading ? result : extractFinalAnswer(result)}
            {isLoading && result && (
              <span className="inline-block w-1.5 h-4 bg-accent-primary/60 animate-pulse ml-0.5 align-middle rounded-sm" />
            )}
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-3">
          <div className="flex items-center gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-xs">
            <X size={13} />
            {error}
          </div>
        </div>
      )}

      {/* 底部操作栏 */}
      {(result && !isLoading) && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-t border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30">
          <button
            onClick={handleReplace}
            className="flex items-center gap-1 px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/90 text-white rounded-lg text-xs font-medium transition-colors"
          >
            <Replace size={12} />
            {t("ai.replace")}
          </button>
          <button
            onClick={handleInsert}
            className="flex items-center gap-1 px-3 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:border-accent-primary/50 hover:text-accent-primary transition-colors"
          >
            <ArrowRight size={12} />
            {t("ai.insertAfter")}
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-3 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded-lg text-xs text-zinc-600 dark:text-zinc-400 hover:border-accent-primary/50 hover:text-accent-primary transition-colors"
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            {copied ? t("ai.copied") : t("ai.copy")}
          </button>
          <div className="flex-1" />
          <button
            onClick={() => { setResult(""); setError(""); setCurrentAction(null); setShowCustomInput(false); setCustomPrompt(""); setSavedPromptName(""); setEditingId(null); setSaveHint(null); }}
            className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 transition-colors"
            title={t("ai.retry")}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

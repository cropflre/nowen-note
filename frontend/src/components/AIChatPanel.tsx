import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot, Send, Trash2, X, Loader2, FileText, Sparkles, User
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

export default function AIChatPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = useCallback(async () => {
    const question = input.trim();
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

    // Build history from previous messages
    const history = messages
      .filter(m => !m.isStreaming)
      .map(m => ({ role: m.role, content: m.content }));

    try {
      await api.aiAsk(
        question,
        history,
        (chunk) => {
          setMessages(prev => prev.map(m =>
            m.id === assistantMsg.id
              ? { ...m, content: m.content + chunk }
              : m
          ));
        },
        (refs) => {
          setMessages(prev => prev.map(m =>
            m.id === assistantMsg.id
              ? { ...m, references: refs }
              : m
          ));
        }
      );
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsg.id
          ? { ...m, content: err.message || t("ai.requestFailed") }
          : m
      ));
    } finally {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsg.id
          ? { ...m, isStreaming: false }
          : m
      ));
      setIsLoading(false);
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
  };

  return (
    <div className="flex flex-col h-full bg-app-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border bg-app-surface/50">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center">
            <Bot size={14} className="text-white" />
          </div>
          <span className="text-sm font-semibold text-tx-primary">{t("aiChat.title")}</span>
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
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/10 to-indigo-500/10 flex items-center justify-center mb-4">
                <Sparkles size={28} className="text-violet-500/60" />
              </div>
              <p className="text-sm text-tx-secondary mb-1">{t("aiChat.empty")}</p>
              <p className="text-xs text-tx-tertiary max-w-[240px]">{t("aiChat.emptyHint")}</p>
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
                      {msg.isStreaming && (
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
                        <span
                          key={ref.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-50 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[10px]"
                        >
                          <FileText size={9} />
                          {ref.title}
                        </span>
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
            onClick={handleSend}
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

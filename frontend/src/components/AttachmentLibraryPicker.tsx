import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FileArchive,
  FileAudio,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { FileItem } from "@/types";

interface AttachmentLibraryPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: FileItem) => void;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function FileIcon({ mimeType }: { mimeType: string }) {
  const mime = (mimeType || "").toLowerCase();
  const props = { size: 18, className: "text-tx-tertiary" };
  if (mime.startsWith("image/")) return <ImageIcon {...props} />;
  if (mime.startsWith("video/")) return <FileVideo {...props} />;
  if (mime.startsWith("audio/")) return <FileAudio {...props} />;
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("compressed")) {
    return <FileArchive {...props} />;
  }
  return <FileText {...props} />;
}

export default function AttachmentLibraryPicker({
  open,
  onClose,
  onSelect,
}: AttachmentLibraryPickerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const requestIdRef = useRef(0);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const requestId = ++requestIdRef.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      api.files
        .list({
          q: query.trim() || undefined,
          page: 1,
          pageSize: 50,
          sort: "created_desc",
        })
        .then((result) => {
          if (requestId !== requestIdRef.current) return;
          setItems(result.items);
          setActiveIndex(0);
        })
        .catch((loadError: any) => {
          if (requestId !== requestIdRef.current) return;
          console.error("[AttachmentLibraryPicker] load failed:", loadError);
          setItems([]);
          setError(
            loadError?.message ||
              t("tiptap.attachmentLibraryLoadFailed", { defaultValue: "附件加载失败" }),
          );
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false);
        });
    }, query ? 180 : 0);

    return () => {
      window.clearTimeout(timer);
      if (requestIdRef.current === requestId) requestIdRef.current += 1;
    };
  }, [open, query, t]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (loading || items.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % items.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + items.length) % items.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const item = items[activeIndex];
        if (item) onSelect(item);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeIndex, items, loading, onClose, onSelect, open]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const resultLabel = useMemo(
    () =>
      query.trim()
        ? t("tiptap.attachmentSearchResults", {
            defaultValue: "搜索结果 · {{count}}",
            count: items.length,
          })
        : t("tiptap.attachmentRecentFiles", { defaultValue: "最近文件" }),
    [items.length, query, t],
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-zinc-950/55 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("tiptap.attachmentLibraryTitle", { defaultValue: "从文件管理插入" })}
        className="flex max-h-[82vh] w-full flex-col overflow-hidden rounded-t-2xl border border-app-border bg-app-elevated shadow-2xl sm:max-w-xl sm:rounded-2xl"
      >
        <div className="flex items-center gap-3 border-b border-app-border px-4 py-3.5 sm:px-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
            <Paperclip size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-tx-primary">
              {t("tiptap.attachmentLibraryTitle", { defaultValue: "从文件管理插入" })}
            </h2>
            <p className="truncate text-[11px] text-tx-tertiary">
              {t("tiptap.attachmentLibrarySubtitle", {
                defaultValue: "复用已上传文件，不会重复占用存储",
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        <div className="border-b border-app-border px-4 py-3 sm:px-5">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-app-border bg-app-bg px-3 focus-within:border-accent-primary/60 focus-within:ring-2 focus-within:ring-accent-primary/10">
            <Search size={15} className="shrink-0 text-tx-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("tiptap.attachmentSearchPlaceholder", {
                defaultValue: "搜索文件名…",
              })}
              className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
            />
            {loading ? (
              <Loader2 size={14} className="shrink-0 animate-spin text-tx-tertiary" />
            ) : query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded p-0.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                aria-label={t("common.clear", { defaultValue: "清空" })}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-4 pb-1 pt-3 text-[10px] text-tx-tertiary sm:px-5">
            <span>{resultLabel}</span>
            <span>{t("tiptap.attachmentPickerHint", { defaultValue: "↑↓ 选择 · Enter 插入" })}</span>
          </div>

          <div
            role="listbox"
            aria-label={resultLabel}
            className="min-h-[260px] overflow-y-auto px-2 pb-3 sm:min-h-[320px] sm:px-3"
          >
            {error ? (
              <div className="flex min-h-[240px] items-center justify-center px-6 text-center text-xs text-red-500">
                {error}
              </div>
            ) : loading && items.length === 0 ? (
              <div className="flex min-h-[240px] items-center justify-center">
                <Loader2 size={20} className="animate-spin text-tx-tertiary" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex min-h-[240px] flex-col items-center justify-center px-6 text-center">
                <Paperclip size={28} className="mb-2 text-tx-tertiary/35" />
                <p className="text-xs text-tx-tertiary">
                  {t("tiptap.attachmentLibraryEmpty", { defaultValue: "没有找到附件" })}
                </p>
              </div>
            ) : (
              <div className="space-y-1 py-1">
                {items.map((item, index) => (
                  <button
                    key={item.id}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => onSelect(item)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                      index === activeIndex
                        ? "bg-accent-primary/10 ring-1 ring-inset ring-accent-primary/20"
                        : "hover:bg-app-hover",
                    )}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-bg">
                      <FileIcon mimeType={item.mimeType} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-tx-primary" title={item.filename}>
                        {item.filename}
                      </span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-tx-tertiary">
                        <span className="shrink-0">{formatSize(item.size)}</span>
                        {item.primaryNote?.title ? (
                          <>
                            <span className="opacity-50">·</span>
                            <span className="truncate">{item.primaryNote.title}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-md bg-app-hover px-1.5 py-0.5 text-[9px] uppercase text-tx-tertiary">
                      {item.filename.includes(".")
                        ? item.filename.split(".").pop()?.slice(0, 8)
                        : item.category}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

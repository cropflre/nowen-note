import React, { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useApp } from "@/store/AppContext";
import type { Note } from "@/types";

type TitleField = HTMLTextAreaElement | HTMLInputElement;

const PLACEHOLDER_DATA_KEY = "nowenUntitledTitlePlaceholder";
const ORIGINAL_PLACEHOLDER_DATA_KEY = "nowenUntitledOriginalPlaceholder";
const LEGACY_UNTITLED_TITLES = new Set(["无标题笔记", "Untitled Note"]);
const LEGACY_MARKDOWN_UNTITLED_TITLES = new Set(["无标题 Markdown", "Untitled Markdown"]);

export function isUntitledNoteTitle(
  title: string | null | undefined,
  localizedUntitledTitle: string,
  contentFormat?: string | null,
): boolean {
  const value = String(title || "").trim();
  if (!value) return false;
  if (value === localizedUntitledTitle.trim() || LEGACY_UNTITLED_TITLES.has(value)) return true;
  return contentFormat === "markdown" && LEGACY_MARKDOWN_UNTITLED_TITLES.has(value);
}

/**
 * 把服务端仍然保留的默认标题转换成编辑器里的真实 placeholder。
 *
 * 数据层继续保存“无标题笔记”，因此列表、同步、旧客户端都不需要迁移；这里只清空 DOM
 * 输入值并把默认标题放进 placeholder。用户开始输入后浏览器自然显示正常正文颜色。
 */
export function activateUntitledTitlePlaceholder(field: TitleField, noteTitle: string): boolean {
  if (field.dataset[PLACEHOLDER_DATA_KEY] !== "true") {
    field.dataset[ORIGINAL_PLACEHOLDER_DATA_KEY] = field.getAttribute("placeholder") || "";
  }
  field.dataset[PLACEHOLDER_DATA_KEY] = "true";
  field.placeholder = noteTitle;
  if (field.value === noteTitle) field.value = "";
  return field.value === "";
}

export function clearUntitledTitlePlaceholder(field: TitleField): void {
  if (field.dataset[PLACEHOLDER_DATA_KEY] !== "true") return;
  field.placeholder = field.dataset[ORIGINAL_PLACEHOLDER_DATA_KEY] || "";
  delete field.dataset[PLACEHOLDER_DATA_KEY];
  delete field.dataset[ORIGINAL_PLACEHOLDER_DATA_KEY];
}

/**
 * React 标题 onBlur 仍以 input.value 判定是否需要 PUT。占位态的 DOM value 是空串，
 * 所以在 focusout 捕获阶段短暂恢复真实默认标题，让既有保存逻辑看到“标题未变化”；事件
 * 分发结束后再切回 placeholder。这样无需侵入 Tiptap / Markdown 的 IME 与保存守卫。
 */
export function restoreUntitledTitleForBlur(field: TitleField, noteTitle: string): boolean {
  if (field.dataset[PLACEHOLDER_DATA_KEY] !== "true" || field.value !== "") return false;
  field.value = noteTitle;
  return true;
}

function collectTitleFields(root: HTMLElement): TitleField[] {
  const fields = Array.from(root.querySelectorAll<HTMLTextAreaElement>(
    "[data-mobile-editor-title] textarea, [data-markdown-mobile-title] textarea",
  ));

  // 大型 Markdown 会切到 LargeMarkdownSafeEditor，它保留独立 input，但没有 data-title。
  if (root.querySelector("[data-large-markdown-source], [data-large-markdown-preview]")) {
    root.querySelectorAll<HTMLInputElement>("input.text-2xl.font-bold.text-tx-primary").forEach((field) => {
      if (!fields.includes(field as never)) fields.push(field as never);
    });
  }
  return fields;
}

function resolveTitleField(root: HTMLElement, target: EventTarget | null): TitleField | null {
  if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return null;
  return collectTitleFields(root).includes(target) ? target : null;
}

/**
 * 编辑器默认标题展示桥。
 *
 * 只处理 UI presentation：后端、AppContext、Local-first 同步仍保留原来的默认标题值。
 * 因此 Web / Desktop / Capacitor 共享同一编辑器时都得到一致行为，也不会制造空标题数据。
 */
export default function UntitledNoteTitleBridge({
  rootRef,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { state } = useApp();
  const { t } = useTranslation();
  const activeNoteRef = useRef<Note | null>(state.activeNote);
  const localizedUntitledTitle = t("common.untitledNote", { defaultValue: "无标题笔记" });
  activeNoteRef.current = state.activeNote;

  const syncFields = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const note = activeNoteRef.current;
    const fields = collectTitleFields(root);
    if (!note) {
      fields.forEach(clearUntitledTitlePlaceholder);
      return;
    }

    const untitled = isUntitledNoteTitle(note.title, localizedUntitledTitle, note.contentFormat);
    for (const field of fields) {
      if (untitled) {
        // 只把仍等于默认标题（或已经为空的占位态）转换为空值；用户正在输入的新标题绝不覆盖。
        if (field.value === note.title || (field.dataset[PLACEHOLDER_DATA_KEY] === "true" && field.value === "")) {
          activateUntitledTitlePlaceholder(field, note.title);
        } else if (field.dataset[PLACEHOLDER_DATA_KEY] === "true") {
          field.placeholder = note.title;
        }
      } else {
        clearUntitledTitlePlaceholder(field);
      }
    }
  }, [localizedUntitledTitle, rootRef]);

  // activeNote 在正文自动保存时也会换对象；同步一次可以抵消编辑器内部
  // `titleRef.current.value = note.title` 对占位 DOM 的回填，而不会碰正在输入的自定义标题。
  useEffect(() => {
    syncFields();
  }, [state.activeNote, syncFields]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    syncFields();
    const observer = new MutationObserver(syncFields);
    observer.observe(root, { childList: true, subtree: true });

    const onFocusIn = (event: FocusEvent) => {
      const field = resolveTitleField(root, event.target);
      if (!field) return;
      const note = activeNoteRef.current;
      if (!note || !isUntitledNoteTitle(note.title, localizedUntitledTitle, note.contentFormat)) return;
      if (field.value === note.title) activateUntitledTitlePlaceholder(field, note.title);
    };

    const onFocusOut = (event: FocusEvent) => {
      const field = resolveTitleField(root, event.target);
      const note = activeNoteRef.current;
      if (
        !field
        || !note
        || !isUntitledNoteTitle(note.title, localizedUntitledTitle, note.contentFormat)
        || !restoreUntitledTitleForBlur(field, note.title)
      ) return;

      const noteId = note.id;
      queueMicrotask(() => {
        const current = activeNoteRef.current;
        if (
          !field.isConnected
          || !current
          || current.id !== noteId
          || field.value !== current.title
          || !isUntitledNoteTitle(current.title, localizedUntitledTitle, current.contentFormat)
        ) return;
        activateUntitledTitlePlaceholder(field, current.title);
      });
    };

    // document 捕获阶段早于 React 根节点的 onBlur/focusout 委托，保证空占位不会被保存成空标题。
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);

    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      collectTitleFields(root).forEach(clearUntitledTitlePlaceholder);
    };
  }, [localizedUntitledTitle, rootRef, syncFields]);

  return null;
}

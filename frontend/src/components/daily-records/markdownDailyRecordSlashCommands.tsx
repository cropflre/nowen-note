import React from "react";
import { CalendarDays, Clock3 } from "lucide-react";
import type { EditorView } from "@codemirror/view";

import type { MdSlashItem } from "@/components/MarkdownSlashMenu";
import { prompt as promptDialog } from "@/components/ui/confirm";
import { getCurrentWorkspace } from "@/lib/api";
import {
  DAILY_RECORD_COMMAND_DEFINITIONS,
  resolveDailyRecordCommandDate,
  type DailyRecordCommandDefinition,
} from "@/lib/dailyRecordCommandDefinitions";
import {
  formatCurrentTimestamp,
  parseLocalDateKey,
  relativeLocalDateKey,
} from "@/lib/dailyRecords";
import {
  getOrCreateJournalForScope,
  resolveJournalScope,
  scopedJournalToastMessage,
} from "@/lib/journalScope";
import { buildWikiNoteLink } from "@/lib/noteLinkSyntax";
import { toast } from "@/lib/toast";

export interface MarkdownInsertionAnchor {
  originalPosition: number;
  originalLength: number;
  before: string;
  after: string;
}

interface JournalResult {
  id: string;
  existed: boolean;
  scope?: "personal" | "workspace";
}

export interface MarkdownDailyRecordCommandDependencies {
  getOrCreateJournal: (dateKey: string, workspaceId: string) => Promise<JournalResult>;
  getWorkspace: () => string;
  chooseDate: () => Promise<string | null>;
  now: () => Date;
  info: (message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const DEFAULT_DEPENDENCIES: MarkdownDailyRecordCommandDependencies = {
  getOrCreateJournal: (dateKey, workspaceId) => getOrCreateJournalForScope(
    dateKey,
    resolveJournalScope(workspaceId),
  ),
  getWorkspace: getCurrentWorkspace,
  chooseDate: () => promptDialog({
    title: "选择日记日期",
    description: "选择日期后，会在当前空间创建或复用对应日记，并在光标位置插入内部链接。",
    type: "date",
    defaultValue: relativeLocalDateKey(0),
    confirmText: "插入链接",
    cancelText: "取消",
    allowEmpty: false,
    validate: (candidate) => {
      try {
        parseLocalDateKey(candidate.trim());
        return null;
      } catch {
        return "请选择有效日期";
      }
    },
  }),
  now: () => new Date(),
  info: (message) => toast.info(message),
  success: (message) => toast.success(message),
  error: (message) => toast.error(message),
};

function dependenciesWith(
  overrides: Partial<MarkdownDailyRecordCommandDependencies> = {},
): MarkdownDailyRecordCommandDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function uniqueIndexOf(text: string, token: string): number {
  if (!token) return -1;
  const first = text.indexOf(token);
  if (first < 0) return -1;
  return text.indexOf(token, first + 1) < 0 ? first : -1;
}

export function captureMarkdownInsertionAnchor(
  text: string,
  position: number,
  contextLength = 48,
): MarkdownInsertionAnchor {
  const safePosition = Math.max(0, Math.min(position, text.length));
  return {
    originalPosition: safePosition,
    originalLength: text.length,
    before: text.slice(Math.max(0, safePosition - contextLength), safePosition),
    after: text.slice(safePosition, safePosition + contextLength),
  };
}

export function resolveMarkdownInsertionPosition(
  text: string,
  anchor: MarkdownInsertionAnchor,
): number {
  const fallback = Math.max(0, Math.min(anchor.originalPosition, text.length));
  if (text.length === anchor.originalLength) {
    const beforeStart = Math.max(0, fallback - anchor.before.length);
    if (
      text.slice(beforeStart, fallback) === anchor.before
      && text.slice(fallback, fallback + anchor.after.length) === anchor.after
    ) {
      return fallback;
    }
  }

  const beforeIndex = uniqueIndexOf(text, anchor.before);
  const afterIndex = uniqueIndexOf(text, anchor.after);
  if (beforeIndex >= 0 && afterIndex >= 0) {
    const afterBefore = beforeIndex + anchor.before.length;
    if (afterBefore <= afterIndex) return afterBefore;
  }
  if (beforeIndex >= 0) return beforeIndex + anchor.before.length;
  if (afterIndex >= 0) return afterIndex;
  return fallback;
}

export function buildMarkdownJournalDateLink(noteId: string, dateKey: string): string {
  return `${buildWikiNoteLink(noteId, null, dateKey)} `;
}

function viewIsActive(view: EditorView): boolean {
  const dom = (view as unknown as { dom?: { isConnected?: boolean } }).dom;
  return dom?.isConnected !== false;
}

function insertAt(view: EditorView, position: number, value: string): void {
  const safePosition = Math.max(0, Math.min(position, view.state.doc.length));
  view.dispatch({
    changes: { from: safePosition, to: safePosition, insert: value },
    selection: { anchor: safePosition + value.length },
    scrollIntoView: true,
  });
  queueMicrotask(() => {
    if (viewIsActive(view)) view.focus();
  });
}

export async function insertMarkdownJournalDateLink(
  view: EditorView,
  dateKey: string,
  overrides: Partial<MarkdownDailyRecordCommandDependencies> = {},
): Promise<boolean> {
  const deps = dependenciesWith(overrides);
  try {
    parseLocalDateKey(dateKey);
  } catch {
    deps.error("日期格式无效");
    return false;
  }

  const insertionAnchor = captureMarkdownInsertionAnchor(
    view.state.doc.toString(),
    view.state.selection.main.from,
  );
  const workspace = deps.getWorkspace();

  try {
    const journal = await deps.getOrCreateJournal(dateKey, workspace);
    if (!viewIsActive(view)) return false;
    const position = resolveMarkdownInsertionPosition(view.state.doc.toString(), insertionAnchor);
    insertAt(view, position, buildMarkdownJournalDateLink(journal.id, dateKey));
    deps.success(scopedJournalToastMessage({
      existed: journal.existed,
      scope: journal.scope || resolveJournalScope(workspace).kind,
    }, dateKey));
    return true;
  } catch (error: any) {
    deps.error(error?.message || "创建日期日记失败");
    return false;
  }
}

async function chooseAndInsertJournalDate(
  view: EditorView,
  deps: MarkdownDailyRecordCommandDependencies,
): Promise<void> {
  const value = await deps.chooseDate();
  if (!value || !viewIsActive(view)) return;
  await insertMarkdownJournalDateLink(view, value.trim(), deps);
}

function iconFor(definition: DailyRecordCommandDefinition): React.ReactNode {
  return definition.kind === "timestamp"
    ? <Clock3 size={16} />
    : <CalendarDays size={16} />;
}

export function getMarkdownDailyRecordSlashCommands(
  overrides: Partial<MarkdownDailyRecordCommandDependencies> = {},
): MdSlashItem[] {
  const deps = dependenciesWith(overrides);
  return DAILY_RECORD_COMMAND_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    icon: iconFor(definition),
    category: definition.category,
    keywords: definition.keywords,
    run: (view) => {
      if (definition.kind === "timestamp") {
        insertAt(view, view.state.selection.main.from, `${formatCurrentTimestamp(deps.now())} `);
        return;
      }
      if (definition.kind === "pick-journal-date") {
        void chooseAndInsertJournalDate(view, deps);
        return;
      }
      const dateKey = resolveDailyRecordCommandDate(definition, deps.now());
      if (dateKey) void insertMarkdownJournalDateLink(view, dateKey, deps);
    },
  }));
}

import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import {
  buildMarkdownJournalDateLink,
  getMarkdownDailyRecordSlashCommands,
  insertMarkdownJournalDateLink,
  resolveMarkdownInsertionPosition,
  captureMarkdownInsertionAnchor,
} from "@/components/daily-records/markdownDailyRecordSlashCommands";

function createView(doc: string, cursor = doc.length): EditorView {
  let state = EditorState.create({ doc, selection: { anchor: cursor } });
  return {
    get state() { return state; },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
    focus() {},
    destroyed: false,
  } as unknown as EditorView;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const journalId = "11111111-2222-4333-8444-555555555555";

describe("Markdown daily record slash commands", () => {
  it("registers the same complete date command set as the rich-text editor", () => {
    const items = getMarkdownDailyRecordSlashCommands();
    expect(items.map((item) => item.id)).toEqual([
      "daily-now",
      "daily-yesterday",
      "daily-today",
      "daily-tomorrow",
      "daily-day-after-tomorrow",
      "daily-this-monday",
      "daily-next-monday",
      "daily-pick-date",
    ]);
    expect(new Set(items.map((item) => item.category))).toEqual(new Set(["日期与日记"]));
  });

  it("inserts a deterministic local timestamp", () => {
    const view = createView("记录：");
    const command = getMarkdownDailyRecordSlashCommands({
      now: () => new Date(2026, 7, 3, 14, 54, 0),
    }).find((item) => item.id === "daily-now");

    command!.run(view);

    expect(view.state.doc.toString()).toBe("记录：2026-08-03 14:54 ");
  });

  it("builds a Nowen wiki link with the date as a stable alias", () => {
    expect(buildMarkdownJournalDateLink(journalId, "2026-08-03"))
      .toBe(`[[note:${journalId}|2026-08-03]] `);
  });

  it("keeps the invocation position while the journal request is pending", async () => {
    const view = createView("alpha omega", 6);
    const request = deferred<{ id: string; existed: boolean }>();
    const success = vi.fn();

    const insertion = insertMarkdownJournalDateLink(view, "2026-08-03", {
      getOrCreateJournal: () => request.promise,
      getWorkspace: () => "personal",
      success,
      error: vi.fn(),
      info: vi.fn(),
    });

    view.dispatch({ changes: { from: 0, insert: "X " } });
    request.resolve({ id: journalId, existed: false });

    await expect(insertion).resolves.toBe(true);
    expect(view.state.doc.toString())
      .toBe(`X alpha [[note:${journalId}|2026-08-03]] omega`);
    expect(success).toHaveBeenCalledWith("已创建并链接 2026-08-03 日记");
  });

  it("passes the active workspace to the scoped journal resolver", async () => {
    const view = createView("workspace ");
    const getOrCreateJournal = vi.fn().mockResolvedValue({
      id: journalId,
      existed: false,
      scope: "workspace",
    });
    const success = vi.fn();

    await expect(insertMarkdownJournalDateLink(view, "2026-08-03", {
      getOrCreateJournal,
      getWorkspace: () => "workspace-one",
      success,
      error: vi.fn(),
      info: vi.fn(),
    })).resolves.toBe(true);

    expect(getOrCreateJournal).toHaveBeenCalledWith("2026-08-03", "workspace-one");
    expect(success).toHaveBeenCalledWith("已创建并链接工作区 2026-08-03 日记");
    expect(view.state.doc.toString()).toContain(`[[note:${journalId}|2026-08-03]]`);
  });

  it("does not call the journal API for an invalid calendar date", async () => {
    const view = createView("");
    const getOrCreateJournal = vi.fn();
    const error = vi.fn();

    await expect(insertMarkdownJournalDateLink(view, "2026-02-30", {
      getOrCreateJournal,
      error,
    })).resolves.toBe(false);

    expect(getOrCreateJournal).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("日期格式无效");
  });

  it("falls back safely when surrounding text is no longer uniquely identifiable", () => {
    const anchor = captureMarkdownInsertionAnchor("same same", 5, 4);
    expect(resolveMarkdownInsertionPosition("same same same", anchor)).toBe(5);
  });
});

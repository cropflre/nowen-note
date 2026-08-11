// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  NOTE_IMAGE_EXPORT_REQUEST_EVENT,
  cancelAllNoteImageExportRequests,
  normalizeNoteImageExportSource,
  normalizeNoteImageExportTimestamp,
  prepareNoteImageExportSource,
  requestNoteImageExport,
  settleNoteImageExportRequest,
  type NoteImageExportRequestDetail,
} from "@/lib/noteImageExportBridge";

afterEach(() => {
  cancelAllNoteImageExportRequests();
  localStorage.clear();
});

describe("NOTE-EXPORT-TIME-01 image export timestamp regression", () => {
  it.each([
    ["SQLite datetime", "2026-07-16 02:56:52"],
    ["timezone-less ISO", "2026-07-16T02:56:52"],
    ["explicit UTC", "2026-07-16T02:56:52Z"],
    ["explicit UTC+8", "2026-07-16T10:56:52+08:00"],
  ])("normalizes %s to the same unambiguous UTC value", (_label, value) => {
    expect(normalizeNoteImageExportTimestamp(value)).toBe("2026-07-16T02:56:52.000Z");
  });

  it("renders the normalized instant as 10:56:52 in UTC+8", () => {
    const normalized = normalizeNoteImageExportTimestamp("2026-07-16 02:56:52");
    expect(normalized).toBeDefined();

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(normalized!));
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    expect(`${value.hour}:${value.minute}:${value.second}`).toBe("10:56:52");
  });

  it("normalizes a copy without changing the note stored by the editor", () => {
    const note = {
      id: "note-1",
      title: "时间测试",
      content: "",
      contentText: "",
      createdAt: "2026-07-16 01:00:00",
      updatedAt: "2026-07-16 02:56:52",
    };

    const normalized = normalizeNoteImageExportSource(note);

    expect(normalized).not.toBe(note);
    expect(normalized.createdAt).toBe("2026-07-16T01:00:00.000Z");
    expect(normalized.updatedAt).toBe("2026-07-16T02:56:52.000Z");
    expect(note.updatedAt).toBe("2026-07-16 02:56:52");
  });

  it("omits empty or invalid timestamps instead of exporting Invalid Date", () => {
    const normalized = normalizeNoteImageExportSource({
      id: "note-invalid",
      title: "非法时间",
      content: "",
      contentText: "",
      createdAt: "not-a-date",
      updatedAt: "",
    });

    expect(normalized.createdAt).toBeUndefined();
    expect(normalized.updatedAt).toBeUndefined();
    expect(JSON.stringify(normalized)).not.toContain("Invalid Date");
  });

  it("renders Markdown footnotes in an isolated export copy", () => {
    const note = {
      id: "note-footnotes",
      title: "脚注",
      contentFormat: "markdown",
      content: "正文。[^1]\n\n[^1]: 脚注内容",
      contentText: "正文。[^1]\n\n[^1]: 脚注内容",
    };

    const prepared = prepareNoteImageExportSource(note);

    expect(prepared).not.toBe(note);
    expect(prepared.content).toContain("data-footnote-ref");
    expect(prepared.content).toContain("class=\"footnotes\"");
    expect(prepared.content).toContain("脚注内容");
    expect(prepared.content).not.toContain("[^1]:");
    expect(note.content).toContain("[^1]: 脚注内容");
  });

  it("dispatches only prepared timestamps to the shared image export center", async () => {
    const detailPromise = new Promise<NoteImageExportRequestDetail>((resolve) => {
      const listener = (event: Event) => {
        window.removeEventListener(NOTE_IMAGE_EXPORT_REQUEST_EVENT, listener);
        resolve((event as CustomEvent<NoteImageExportRequestDetail>).detail);
      };
      window.addEventListener(NOTE_IMAGE_EXPORT_REQUEST_EVENT, listener);
    });

    const result = requestNoteImageExport({
      id: "note-request",
      title: "导出请求",
      content: "",
      contentText: "",
      updatedAt: "2026-07-16 02:56:52",
    });

    const detail = await detailPromise;
    expect(detail.note.updatedAt).toBe("2026-07-16T02:56:52.000Z");
    settleNoteImageExportRequest(detail.requestId, true);
    await expect(result).resolves.toBe(true);
  });
});

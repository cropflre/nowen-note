// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  NOTE_IMAGE_EXPORT_REQUEST_EVENT,
  cancelAllNoteImageExportRequests,
  normalizeNoteImageExportSource,
  normalizeNoteImageExportTimestamp,
  requestNoteImageExport,
  settleNoteImageExportRequest,
  type NoteImageExportRequestDetail,
} from "@/lib/noteImageExportBridge";

afterEach(() => {
  cancelAllNoteImageExportRequests();
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

  it("dispatches only normalized timestamps to the shared image export center", async () => {
    let detail: NoteImageExportRequestDetail | null = null;
    const listener = (event: Event) => {
      detail = (event as CustomEvent<NoteImageExportRequestDetail>).detail;
    };
    window.addEventListener(NOTE_IMAGE_EXPORT_REQUEST_EVENT, listener);

    try {
      const result = requestNoteImageExport({
        id: "note-request",
        title: "导出请求",
        content: "",
        contentText: "",
        updatedAt: "2026-07-16 02:56:52",
      });

      expect(detail).not.toBeNull();
      expect(detail!.note.updatedAt).toBe("2026-07-16T02:56:52.000Z");
      settleNoteImageExportRequest(detail!.requestId, true);
      await expect(result).resolves.toBe(true);
    } finally {
      window.removeEventListener(NOTE_IMAGE_EXPORT_REQUEST_EVENT, listener);
    }
  });
});

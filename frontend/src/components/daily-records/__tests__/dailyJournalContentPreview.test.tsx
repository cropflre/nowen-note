import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DailyJournalContentPreview, {
  resolveContentFormat,
} from "../DailyJournalContentPreview";
import type { Note } from "@/types";

function note(overrides: Partial<Note>): Note {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
    notebookId: "notebook-1",
    workspaceId: null,
    title: "今日日记",
    content: "",
    contentText: "",
    contentFormat: "tiptap-json",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    version: 1,
    sortOrder: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T01:00:00.000Z",
    ...overrides,
  };
}

describe("DailyJournalContentPreview", () => {
  it("renders Tiptap internal link marks as real anchors", () => {
    const target = "22222222-2222-4222-8222-222222222222";
    const content = JSON.stringify({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "2026-08-04",
          marks: [{
            type: "link",
            attrs: {
              href: `note:${target}`,
              target: "_blank",
              rel: "noopener noreferrer nofollow nowen-title-auto",
            },
          }],
        }, { type: "text", text: " 这是昨天的日记链接。" }],
      }],
    });

    const html = renderToStaticMarkup(
      <DailyJournalContentPreview
        note={note({ content, contentText: "2026-08-04 这是昨天的日记链接。" })}
        onOpenEditor={() => undefined}
      />,
    );

    expect(html).toContain(`href="note:${target}"`);
    expect(html).toContain("2026-08-04");
    expect(html).toContain("这是昨天的日记链接。");
  });

  it("respects the stored note format instead of flattening every note to text", () => {
    expect(resolveContentFormat(note({ contentFormat: "markdown", content: "[会议纪要](https://example.com)" }))).toBe("markdown");
    expect(resolveContentFormat(note({ contentFormat: "html", content: "<p><a href='https://example.com'>会议纪要</a></p>" }))).toBe("html");
    expect(resolveContentFormat(note({ contentFormat: "tiptap-json", content: '{"type":"doc","content":[]}' }))).toBe("tiptap-json");
  });

  it("keeps the journal card content outside a wrapping button", () => {
    const source = readFileSync("src/components/daily-records/DailyJournalView.tsx", "utf8");
    expect(source).toContain("<DailyJournalContentPreview");
    expect(source).not.toContain('className="block min-h-[190px] w-full px-5 py-5 text-left');
  });
});

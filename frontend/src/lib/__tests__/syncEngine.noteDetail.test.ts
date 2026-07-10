import { describe, expect, it } from "vitest";
import { isCompleteNoteDetail } from "@/lib/syncEngine";

function complete(content = "Body") {
  return {
    id: "note-1",
    userId: "user-1",
    notebookId: "notebook-1",
    title: "Title",
    content,
    contentText: content,
    version: 2,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

describe("syncEngine note detail integrity", () => {
  it("accepts complete server note details", () => {
    expect(isCompleteNoteDetail(complete())).toBe(true);
  });

  it("rejects optimistic objects that only imitate body fields", () => {
    expect(isCompleteNoteDetail({
      id: "note-1",
      title: "Title",
      content: "",
      contentText: "",
      version: 1,
      updatedAt: "2026-07-10T00:00:00.000Z",
    })).toBe(false);
  });

  it("rejects missing body fields", () => {
    expect(isCompleteNoteDetail({
      ...complete(),
      content: undefined,
      contentText: undefined,
    })).toBe(false);
  });

  it("accepts a legitimate empty note when identity and body fields are present", () => {
    expect(isCompleteNoteDetail(complete(""))).toBe(true);
  });
});

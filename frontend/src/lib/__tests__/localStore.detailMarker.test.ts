import { describe, expect, it } from "vitest";
import { isNoteDetailCached } from "@/lib/localStore";

describe("local note detail marker", () => {
  it("accepts a server-confirmed empty note", () => {
    expect(isNoteDetailCached({
      id: "note-1",
      content: "",
      __detailCached: true,
    } as any)).toBe(true);
  });

  it("rejects list placeholders even when they contain a summary string", () => {
    expect(isNoteDetailCached({
      id: "note-1",
      content: "summary placeholder",
      __detailCached: false,
    } as any)).toBe(false);
  });

  it("keeps legacy non-empty details readable", () => {
    expect(isNoteDetailCached({
      id: "note-1",
      content: "legacy full body",
    } as any)).toBe(true);
  });

  it("treats an unmarked legacy empty body as ambiguous placeholder", () => {
    expect(isNoteDetailCached({
      id: "note-1",
      content: "",
    } as any)).toBe(false);
  });
});

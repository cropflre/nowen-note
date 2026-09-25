import { describe, expect, it } from "vitest";
import {
  consumeNewNoteImmediateEdit,
  markNewNoteForImmediateEdit,
  shouldApplyDefaultViewLock,
} from "../newNoteImmediateEdit";

describe("new note immediate edit", () => {
  it("exempts only the first opening of the newly created note", () => {
    consumeNewNoteImmediateEdit("reset");
    expect(consumeNewNoteImmediateEdit("existing")).toBe(false);

    markNewNoteForImmediateEdit("new-note");
    expect(consumeNewNoteImmediateEdit("new-note")).toBe(true);
    expect(consumeNewNoteImmediateEdit("new-note")).toBe(false);
  });

  it("does not leave an exemption behind if another note opens first", () => {
    markNewNoteForImmediateEdit("new-note");
    expect(consumeNewNoteImmediateEdit("other-note")).toBe(false);
    expect(consumeNewNoteImmediateEdit("new-note")).toBe(false);
  });

  it("locks existing and reopened notes, but not a newly created first opening", () => {
    expect(shouldApplyDefaultViewLock("existing", true)).toBe(true);
    markNewNoteForImmediateEdit("new-note");
    expect(shouldApplyDefaultViewLock("new-note", true)).toBe(false);
    expect(shouldApplyDefaultViewLock("other-note", true)).toBe(true);
    expect(shouldApplyDefaultViewLock("new-note", true)).toBe(true);
  });

  it("keeps the preference-off behavior and still consumes the marker", () => {
    markNewNoteForImmediateEdit("new-note");
    expect(shouldApplyDefaultViewLock("new-note", false)).toBe(false);
    expect(shouldApplyDefaultViewLock("new-note", true)).toBe(true);
  });
});

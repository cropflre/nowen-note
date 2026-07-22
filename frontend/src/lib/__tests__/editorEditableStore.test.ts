import { describe, expect, it, vi } from "vitest";
import {
  getEditorEditableSnapshot,
  publishEditorEditable,
  subscribeEditorEditable,
} from "@/lib/editorEditableStore";

describe("editorEditableStore", () => {
  it("notifies only when the editable value actually changes", () => {
    const editor = { isEditable: true };
    const listener = vi.fn();
    const unsubscribe = subscribeEditorEditable(editor, listener);

    expect(getEditorEditableSnapshot(editor)).toBe(true);
    expect(publishEditorEditable(editor)).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    editor.isEditable = false;
    expect(publishEditorEditable(editor)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getEditorEditableSnapshot(editor)).toBe(false);

    expect(publishEditorEditable(editor)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

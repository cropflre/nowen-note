// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { installRuntimeCompatibility } from "../runtimeCompatibility";

type ArrayPrototypeCompat = {
  findLast?: unknown;
};

type NumberFindLast = (
  this: number[],
  predicate: (
    this: any,
    value: number,
    index: number,
    array: ArrayLike<number>,
  ) => unknown,
  thisArg?: unknown,
) => number | undefined;

const originalFindLastDescriptor = Object.getOwnPropertyDescriptor(
  Array.prototype,
  "findLast",
);

function removeFindLast(): void {
  delete (Array.prototype as unknown as ArrayPrototypeCompat).findLast;
}

function restoreFindLast(): void {
  removeFindLast();
  if (originalFindLastDescriptor) {
    Object.defineProperty(
      Array.prototype,
      "findLast",
      originalFindLastDescriptor,
    );
  }
}

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
  restoreFindLast();
});

describe("installRuntimeCompatibility", () => {
  it("installs a non-enumerable standards-compatible findLast fallback", () => {
    removeFindLast();
    installRuntimeCompatibility();

    const findLast = Reflect.get(
      Array.prototype,
      "findLast",
    ) as NumberFindLast;

    const context = { minimum: 3 };
    const values = [1, 2, 3, 4];
    const predicate = function (
      this: typeof context,
      value: number,
    ): boolean {
      return value < this.minimum;
    };

    expect(findLast.call(values, predicate, context)).toBe(2);
    expect(findLast.call(values, (value) => value > 10)).toBeUndefined();

    const descriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "findLast",
    );
    expect(descriptor).toMatchObject({
      configurable: true,
      writable: true,
      enumerable: false,
    });
  });

  it("does not replace an existing native implementation", () => {
    const nativeLike = vi.fn(() => "native");
    Object.defineProperty(Array.prototype, "findLast", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: nativeLike,
    });

    installRuntimeCompatibility();

    expect(Reflect.get(Array.prototype, "findLast")).toBe(nativeLike);
  });

  it("keeps a real Tiptap editor usable without native findLast", () => {
    removeFindLast();
    installRuntimeCompatibility();

    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "兼容测试" }],
          },
        ],
      },
    });
    editors.push(editor);

    expect(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.commands.insertContent("通过");
      editor.view.dispatch(editor.state.tr.setMeta("focus", true));
      editor.view.dispatch(editor.state.tr.setMeta("blur", true));
    }).not.toThrow();

    expect(editor.getText()).toContain("兼容测试通过");
  });
});

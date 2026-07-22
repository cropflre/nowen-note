import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import {
  createCodeBlockHighlightPlugin,
  isPlainTextLanguage,
  type LowlightLike,
} from "@/lib/codeBlockHighlightPlugin";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    codeBlock: {
      attrs: { language: { default: null } },
      content: "text*",
      group: "block",
      code: true,
      toDOM: () => ["pre", ["code", 0]],
    },
  },
});

function codeDocument(language: string, blocks: string[]) {
  return schema.node("doc", null, blocks.map((code) => (
    schema.node("codeBlock", { language }, code ? schema.text(code) : undefined)
  )));
}

function fakeLowlight() {
  const calls = { explicit: 0, auto: 0 };
  const result = (code: string) => ({
    children: [{
      type: "element",
      properties: { className: ["hljs-keyword"] },
      children: [{ type: "text", value: code }],
    }],
  });
  const lowlight: LowlightLike = {
    listLanguages: () => ["javascript", "json", "sql", "markdown"],
    registered: (language) => ["javascript", "json", "sql", "markdown"].includes(language),
    highlight: (_language, code) => {
      calls.explicit += 1;
      return result(code);
    },
    highlightAuto: (code) => {
      calls.auto += 1;
      return result(code);
    },
  };
  return { calls, lowlight };
}

describe("incremental code block highlighting", () => {
  it("does not invoke lowlight for explicit plain-text aliases", () => {
    for (const language of ["text", "plaintext", "plain", "txt"]) {
      const { calls, lowlight } = fakeLowlight();
      const plugin = createCodeBlockHighlightPlugin({ name: "codeBlock", lowlight });
      EditorState.create({ doc: codeDocument(language, ["one", "two"]), plugins: [plugin] });
      expect(calls).toEqual({ explicit: 0, auto: 0 });
      expect(isPlainTextLanguage(language)).toBe(true);
    }
  });

  it("reuses exact results so editing one block does not re-highlight the other 19", () => {
    const { calls, lowlight } = fakeLowlight();
    const plugin = createCodeBlockHighlightPlugin({ name: "codeBlock", lowlight });
    const state = EditorState.create({
      doc: codeDocument("javascript", Array.from({ length: 20 }, (_, index) => `const value${index} = ${index}`)),
      plugins: [plugin],
    });
    expect(calls.explicit).toBe(20);

    state.apply(state.tr.insertText("x", 2));
    expect(calls.explicit).toBe(21);
  });

  it("defers a large auto block and applies only a current idle result without changing the document", () => {
    const { calls, lowlight } = fakeLowlight();
    const callbacks = new Map<number, IdleRequestCallback>();
    let nextHandle = 1;
    const originalRequestIdle = window.requestIdleCallback;
    const originalCancelIdle = window.cancelIdleCallback;
    window.requestIdleCallback = ((callback: IdleRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    }) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = ((handle: number) => {
      callbacks.delete(handle);
    }) as typeof window.cancelIdleCallback;

    const plugin = createCodeBlockHighlightPlugin({
      name: "codeBlock",
      lowlight,
      autoSyncMaxCharacters: 10,
    });
    let state = EditorState.create({
      doc: codeDocument("auto", ["const value = 1234567890"]),
      plugins: [plugin],
    });
    const initialDoc = state.doc;
    const initialSelection = TextSelection.create(state.doc, 2);
    state = state.apply(state.tr.setSelection(initialSelection));
    const metadataTransactions: Array<{ docChanged: boolean; steps: number }> = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state,
      dispatchTransaction(transaction) {
        metadataTransactions.push({ docChanged: transaction.docChanged, steps: transaction.steps.length });
        state = state.apply(transaction);
        view.updateState(state);
      },
    });

    expect(calls.auto).toBe(0);
    expect(callbacks.size).toBe(1);
    const callback = [...callbacks.values()][0];
    callback({ didTimeout: false, timeRemaining: () => 50 });

    expect(calls.auto).toBe(1);
    expect(state.doc.eq(initialDoc)).toBe(true);
    expect(state.selection.eq(initialSelection)).toBe(true);
    expect(metadataTransactions).toEqual([{ docChanged: false, steps: 0 }]);

    view.destroy();
    host.remove();
    window.requestIdleCallback = originalRequestIdle;
    window.cancelIdleCallback = originalCancelIdle;
  });

  it("keeps only the newest idle task during a simulated 30-second edit burst and cancels it on language change", () => {
    const { calls, lowlight } = fakeLowlight();
    const callbacks = new Map<number, IdleRequestCallback>();
    const diagnostics: Array<{ event: string; detail: Record<string, number | string | boolean> }> = [];
    let nextHandle = 1;
    const originalRequestIdle = window.requestIdleCallback;
    const originalCancelIdle = window.cancelIdleCallback;
    window.requestIdleCallback = ((callback: IdleRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    }) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = ((handle: number) => {
      callbacks.delete(handle);
    }) as typeof window.cancelIdleCallback;

    const plugin = createCodeBlockHighlightPlugin({
      name: "codeBlock",
      lowlight,
      autoSyncMaxCharacters: 10,
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    let state = EditorState.create({
      doc: codeDocument("auto", ["line\n".repeat(2_000)]),
      plugins: [plugin],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state,
      dispatchTransaction(transaction) {
        state = state.apply(transaction);
        view.updateState(state);
      },
    });

    try {
      expect(callbacks.size).toBe(1);
      for (let index = 0; index < 300; index += 1) {
        view.dispatch(state.tr.insertText(String(index % 10), 2));
        expect(callbacks.size).toBe(1);
      }

      const queueDepths = diagnostics
        .filter(({ event }) => event === "highlight-queue-depth")
        .map(({ detail }) => Number(detail.depth));
      expect(Math.max(...queueDepths)).toBe(1);
      expect(diagnostics.filter(({ event }) => event === "highlight-task-created")).toHaveLength(301);
      expect(diagnostics.filter(({ event }) => event === "highlight-task-cancelled")).toHaveLength(300);

      const selectionBeforeHighlight = state.selection;
      const [latestHandle, latestCallback] = [...callbacks.entries()][0];
      callbacks.delete(latestHandle);
      latestCallback({ didTimeout: false, timeRemaining: () => 50 });
      expect(calls.auto).toBe(1);
      expect(state.selection.eq(selectionBeforeHighlight)).toBe(true);
      expect(diagnostics.filter(({ event }) => event === "highlight-task-executed")).toHaveLength(1);
      expect(diagnostics.filter(({ event }) => event === "highlight-task-applied")).toHaveLength(1);

      view.dispatch(state.tr.setNodeMarkup(0, undefined, { language: "javascript" }));
      expect(callbacks.size).toBe(0);
      view.dispatch(state.tr.setNodeMarkup(0, undefined, { language: "auto" }));
      expect(callbacks.size).toBe(0); // exact auto result is reused after switching back
      view.dispatch(state.tr.insertText("new", 2));
      expect(callbacks.size).toBe(1);
      view.destroy();
      expect(callbacks.size).toBe(0);
      expect(diagnostics.some(({ event, detail }) => event === "highlight-task-cancelled" && detail.destroyed === true)).toBe(true);
    } finally {
      if (!view.isDestroyed) view.destroy();
      host.remove();
      window.requestIdleCallback = originalRequestIdle;
      window.cancelIdleCallback = originalCancelIdle;
    }
  });

  it("bounds the queue to one current task per block while alternating across 20 large auto blocks", () => {
    const { calls, lowlight } = fakeLowlight();
    const callbacks = new Map<number, IdleRequestCallback>();
    const diagnostics: Array<{ event: string; detail: Record<string, number | string | boolean> }> = [];
    let nextHandle = 1;
    const originalRequestIdle = window.requestIdleCallback;
    const originalCancelIdle = window.cancelIdleCallback;
    window.requestIdleCallback = ((callback: IdleRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    }) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = ((handle: number) => callbacks.delete(handle)) as typeof window.cancelIdleCallback;

    const plugin = createCodeBlockHighlightPlugin({
      name: "codeBlock",
      lowlight,
      autoSyncMaxCharacters: 10,
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    const block = (index: number) => `${index}:line\n`.repeat(500);
    let state = EditorState.create({
      doc: codeDocument("auto", Array.from({ length: 20 }, (_, index) => block(index))),
      plugins: [plugin],
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state,
      dispatchTransaction(transaction) {
        state = state.apply(transaction);
        view.updateState(state);
      },
    });

    try {
      expect(callbacks.size).toBe(20);
      for (let round = 0; round < 5; round += 1) {
        let pos = 0;
        for (let index = 0; index < 20; index += 1) {
          view.dispatch(state.tr.insertText(String(round), pos + 2));
          pos += state.doc.child(index).nodeSize;
          expect(callbacks.size).toBe(20);
        }
      }
      const queueDepths = diagnostics
        .filter(({ event }) => event === "highlight-queue-depth")
        .map(({ detail }) => Number(detail.depth));
      expect(Math.max(...queueDepths)).toBe(20);

      while (callbacks.size > 0) {
        const [handle, callback] = [...callbacks.entries()][0];
        callbacks.delete(handle);
        callback({ didTimeout: false, timeRemaining: () => 50 });
      }
      expect(calls.auto).toBe(20);
      expect(diagnostics.filter(({ event }) => event === "highlight-task-applied")).toHaveLength(20);
    } finally {
      view.destroy();
      host.remove();
      window.requestIdleCallback = originalRequestIdle;
      window.cancelIdleCallback = originalCancelIdle;
    }
  });

  it("cancels superseded paste tasks and cannot apply after the block is deleted", () => {
    const { calls, lowlight } = fakeLowlight();
    const callbacks = new Map<number, IdleRequestCallback>();
    const diagnostics: Array<{ event: string; detail: Record<string, number | string | boolean> }> = [];
    let nextHandle = 1;
    const originalRequestIdle = window.requestIdleCallback;
    const originalCancelIdle = window.cancelIdleCallback;
    window.requestIdleCallback = ((callback: IdleRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    }) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = ((handle: number) => callbacks.delete(handle)) as typeof window.cancelIdleCallback;

    const plugin = createCodeBlockHighlightPlugin({
      name: "codeBlock",
      lowlight,
      autoSyncMaxCharacters: 10,
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    let state = EditorState.create({
      doc: codeDocument("auto", ["seed\n".repeat(2_000), "keep\n".repeat(20)]),
      plugins: [plugin],
    });
    const originalSelection = TextSelection.create(state.doc, 2);
    state = state.apply(state.tr.setSelection(originalSelection));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state,
      dispatchTransaction(transaction) {
        state = state.apply(transaction);
        view.updateState(state);
      },
    });

    try {
      expect(callbacks.size).toBe(2);
      for (let paste = 0; paste < 5; paste += 1) {
        view.dispatch(state.tr.insertText(`paste-${paste}\n`.repeat(1_000), 2));
        expect(callbacks.size).toBe(2);
      }
      const firstNodeSize = state.doc.child(0).nodeSize;
      view.dispatch(state.tr.delete(0, firstNodeSize));
      expect(callbacks.size).toBe(1);

      const [handle, callback] = [...callbacks.entries()][0];
      callbacks.delete(handle);
      callback({ didTimeout: false, timeRemaining: () => 50 });
      expect(calls.auto).toBe(1);
      expect(state.doc.childCount).toBe(1);
      expect(state.doc.textContent).toBe("keep\n".repeat(20));
      expect(diagnostics.filter(({ event }) => event === "highlight-task-stale")).toHaveLength(0);
      expect(diagnostics.filter(({ event }) => event === "highlight-task-applied")).toHaveLength(1);
    } finally {
      view.destroy();
      expect(callbacks.size).toBe(0);
      host.remove();
      window.requestIdleCallback = originalRequestIdle;
      window.cancelIdleCallback = originalCancelIdle;
    }
  });
});

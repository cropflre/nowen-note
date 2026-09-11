// @vitest-environment jsdom

import { CompletionContext } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, describe, expect, it } from "vitest";
import {
  completeMarkdownFenceOnEnter,
  fencedCodeLanguageCompletion,
  getFenceLanguageLabel,
  hasMatchingFenceClosing,
  markdownFencedCodeAuthoringExtension,
  markdownFencedCodeLiveEditingExtension,
  normalizeFenceLanguage,
  parseMarkdownFenceOpening,
} from "@/lib/markdownFenceAuthoring";

beforeAll(() => {
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function createView(
  doc: string,
  selection = doc.length,
  extensions = [history(), markdown(), markdownFencedCodeAuthoringExtension],
) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions,
    }),
  });
}

describe("Markdown fenced code authoring", () => {
  it("parses backtick/tilde fences and preserves the original info string", () => {
    expect(parseMarkdownFenceOpening("```bash shell-session")).toMatchObject({
      marker: "`",
      length: 3,
      language: "bash",
      info: "bash shell-session",
    });
    expect(parseMarkdownFenceOpening("  ~~~~python")).toMatchObject({
      marker: "~",
      length: 4,
      prefix: "  ",
      language: "python",
    });
  });

  it("normalizes common aliases for labels without rewriting Markdown source", () => {
    expect(normalizeFenceLanguage("js")).toBe("javascript");
    expect(normalizeFenceLanguage("ts")).toBe("typescript");
    expect(normalizeFenceLanguage("sh")).toBe("bash");
    expect(normalizeFenceLanguage("py")).toBe("python");
    expect(normalizeFenceLanguage("yml")).toBe("yaml");
    expect(getFenceLanguageLabel("c#")).toBe("C#");
    expect(getFenceLanguageLabel("some-custom-lang")).toBe("some-custom-lang");
  });

  it("expands ```bash + Enter into one standard Markdown fenced block", () => {
    const view = createView("```bash");
    expect(completeMarkdownFenceOnEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```bash\n\n```");
    expect(view.state.selection.main.head).toBe("```bash\n".length);
    view.destroy();
  });

  it("does not duplicate an existing closing fence", () => {
    const doc = "```bash\n```";
    const view = createView(doc, "```bash".length);
    expect(completeMarkdownFenceOnEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```bash\n\n```");
    expect(view.state.doc.toString().match(/```/g)?.length).toBe(2);
    view.destroy();
  });

  it("does not treat an inner three-backtick line as the close of a four-backtick fence", () => {
    const doc = "````markdown\n```\n````";
    const opening = parseMarkdownFenceOpening("````markdown")!;
    const state = EditorState.create({ doc, extensions: [markdown()] });
    expect(hasMatchingFenceClosing(state, 1, opening)).toBe(true);
    expect(opening.length).toBe(4);
  });

  it("keeps blockquote prefixes and the opening fence length", () => {
    const view = createView("> ~~~~sh");
    expect(completeMarkdownFenceOnEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("> ~~~~sh\n> \n> ~~~~");
    expect(view.state.selection.main.head).toBe("> ~~~~sh\n> ".length);
    view.destroy();
  });

  it("creates the auto-close as one undoable transaction", () => {
    const view = createView("```json");
    expect(completeMarkdownFenceOnEnter(view)).toBe(true);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```json");
    view.destroy();
  });

  it("supports multiple cursors when every cursor is at a fence opening", () => {
    const doc = "```js\n\n```py";
    const second = doc.length;
    const view = createView(doc, 0, [
      EditorState.allowMultipleSelections.of(true),
      markdown(),
      markdownFencedCodeAuthoringExtension,
    ]);
    view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor("```js".length),
        EditorSelection.cursor(second),
      ]),
    });
    expect(completeMarkdownFenceOnEnter(view)).toBe(true);
    expect(view.state.doc.toString()).toContain("```js\n\n```");
    expect(view.state.doc.toString()).toContain("```py\n\n```");
    view.destroy();
  });

  it("offers lightweight language completion for fence tokens and aliases", () => {
    const state = EditorState.create({
      doc: "```ja",
      selection: { anchor: 5 },
      extensions: [markdown()],
    });
    const result = fencedCodeLanguageCompletion(new CompletionContext(state, state.doc.length, false));
    expect(result?.from).toBe(3);
    expect(result?.options.some((option) => option.label === "javascript")).toBe(true);
    expect(result?.options.some((option) => option.label === "js" && option.apply === "javascript")).toBe(true);
  });

  it("decorates only the active fenced block as a Live editing frame", () => {
    const doc = "```bash\necho one\n```\n\n```json\n{\"a\":1}\n```";
    const firstBody = doc.indexOf("echo one") + 2;
    const view = createView(doc, firstBody, [
      markdown(),
      markdownFencedCodeLiveEditingExtension,
    ]);

    const activeLines = view.dom.querySelectorAll(".cm-nowen-fence-active");
    expect(activeLines.length).toBe(3);
    expect(view.dom.querySelector(".cm-nowen-fence-opening")?.getAttribute("data-fence-language-label")).toBe("Bash");
    expect(view.dom.textContent).toContain("{\"a\":1}");
    view.destroy();
  });
});

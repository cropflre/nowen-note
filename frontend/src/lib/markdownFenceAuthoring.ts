import {
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  Prec,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { toggleCodeBlock } from "@/lib/markdownCommands";

export type FenceMarker = "`" | "~";

export interface MarkdownFenceOpening {
  prefix: string;
  marker: FenceMarker;
  length: number;
  fence: string;
  info: string;
  language: string;
}

export const MARKDOWN_FENCE_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  plaintext: "text",
  txt: "text",
  cs: "csharp",
  "c#": "csharp",
  ps1: "powershell",
};

const LANGUAGE_LABELS: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  bash: "Bash",
  python: "Python",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  yaml: "YAML",
  sql: "SQL",
  java: "Java",
  go: "Go",
  rust: "Rust",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  powershell: "PowerShell",
  maxscript: "MAXScript",
  markdown: "Markdown",
  text: "Text",
};

const FENCE_LANGUAGE_OPTIONS = [
  "javascript", "typescript", "bash", "python", "html", "css", "json", "yaml",
  "sql", "java", "go", "rust", "c", "cpp", "csharp", "powershell", "maxscript",
  "markdown", "text",
];

const FENCE_ALIAS_OPTIONS = Object.entries(MARKDOWN_FENCE_LANGUAGE_ALIASES)
  .filter(([alias]) => !FENCE_LANGUAGE_OPTIONS.includes(alias))
  .map(([alias, canonical]) => ({
    label: alias,
    apply: canonical,
    detail: `${LANGUAGE_LABELS[canonical] || canonical} alias`,
    type: "keyword" as const,
    boost: 5,
  }));

// CommonMark allows arbitrary info text after a tilde fence. Backtick fences are the exception:
// their info string may not itself contain a backtick.
const OPENING_FENCE_RE = /^(\s{0,3}(?:(?:>\s*)*))((`{3,})|(~{3,}))(.*)$/;

export function normalizeFenceLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  return MARKDOWN_FENCE_LANGUAGE_ALIASES[normalized] || normalized;
}

export function getFenceLanguageLabel(language: string): string {
  const canonical = normalizeFenceLanguage(language);
  if (!canonical) return "Plain text";
  return LANGUAGE_LABELS[canonical] || language.trim() || "Plain text";
}

export function parseMarkdownFenceOpening(line: string): MarkdownFenceOpening | null {
  const match = line.match(OPENING_FENCE_RE);
  if (!match) return null;
  const fence = match[2];
  const marker = fence[0] as FenceMarker;
  const rawInfo = match[5] || "";
  if (marker === "`" && rawInfo.includes("`")) return null;
  const info = rawInfo.trim();
  const language = info.split(/\s+/)[0] || "";
  return {
    prefix: match[1],
    marker,
    length: fence.length,
    fence,
    info,
    language,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isMatchingFenceClosing(line: string, opening: MarkdownFenceOpening): boolean {
  const prefix = escapeRegExp(opening.prefix);
  const marker = escapeRegExp(opening.marker);
  return new RegExp(`^${prefix}${marker}{${opening.length},}\\s*$`).test(line);
}

export function hasMatchingFenceClosing(
  state: EditorState,
  openingLineNumber: number,
  opening: MarkdownFenceOpening,
): boolean {
  for (let lineNumber = openingLineNumber + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    if (isMatchingFenceClosing(state.doc.line(lineNumber).text, opening)) return true;
  }
  return false;
}

/**
 * Typora-style fenced-code input rule. It only takes over Enter when every selection is an empty
 * cursor at the end of a pure fence-opening line. Paste, normal Enter and IME composition therefore
 * fall through to CodeMirror unchanged. Active autocomplete also wins Enter so a visible language
 * candidate can be accepted before the user enters the code body.
 */
export function completeMarkdownFenceOnEnter(view: EditorView): boolean {
  if (view.composing) return false;
  if (completionStatus(view.state)) return false;
  const state = view.state;
  const ranges = state.selection.ranges;
  if (!ranges.length || ranges.some((range) => !range.empty)) return false;

  const canHandleEveryCursor = ranges.every((range) => {
    const line = state.doc.lineAt(range.head);
    return range.head === line.to && Boolean(parseMarkdownFenceOpening(line.text));
  });
  if (!canHandleEveryCursor) return false;

  const transaction = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const opening = parseMarkdownFenceOpening(line.text)!;
    const alreadyClosed = hasMatchingFenceClosing(state, line.number, opening);
    const contentPrefix = opening.prefix;
    const insert = alreadyClosed
      ? `\n${contentPrefix}`
      : `\n${contentPrefix}\n${opening.prefix}${opening.fence}`;
    return {
      changes: { from: range.head, insert },
      range: EditorSelection.cursor(range.head + 1 + contentPrefix.length),
    };
  });

  view.dispatch(transaction);
  return true;
}

export function fencedCodeLanguageCompletion(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.doc.sliceString(line.from, context.pos);
  const match = before.match(/^(\s{0,3}(?:(?:>\s*)*))(`{3,}|~{3,})([A-Za-z0-9_+#.-]*)$/);
  if (!match) return null;
  const token = match[3];
  const from = context.pos - token.length;
  return {
    from,
    validFor: /^[A-Za-z0-9_+#.-]*$/,
    options: [
      ...FENCE_LANGUAGE_OPTIONS.map((language) => ({
        label: language,
        detail: LANGUAGE_LABELS[language],
        type: "keyword" as const,
      })),
      ...FENCE_ALIAS_OPTIONS,
    ],
  };
}

function activeFenceDecorations(state: EditorState): DecorationSet {
  const heads = state.selection.ranges.map((range) => range.head);
  const ranges: Array<{ from: number; decoration: Decoration }> = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      if (!heads.some((head) => head >= node.from && head <= node.to)) return;

      const firstLine = state.doc.lineAt(node.from);
      const opening = parseMarkdownFenceOpening(firstLine.text);
      if (!opening) return;
      const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1));
      const hasClosing = lastLine.number > firstLine.number
        && isMatchingFenceClosing(lastLine.text, opening);
      const label = getFenceLanguageLabel(opening.language);

      for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber += 1) {
        const line = state.doc.line(lineNumber);
        const openingLine = lineNumber === firstLine.number;
        const closingLine = hasClosing && lineNumber === lastLine.number;
        ranges.push({
          from: line.from,
          decoration: Decoration.line({
            class: [
              "cm-nowen-fence-active",
              openingLine ? "cm-nowen-fence-opening" : "",
              closingLine ? "cm-nowen-fence-closing" : "",
              !openingLine && !closingLine ? "cm-nowen-fence-body" : "",
            ].filter(Boolean).join(" "),
            ...(openingLine ? { attributes: { "data-fence-language-label": label } } : {}),
          }),
        });
      }
    },
  });

  return Decoration.set(
    ranges
      .sort((left, right) => left.from - right.from)
      .map(({ from, decoration }) => decoration.range(from)),
    true,
  );
}

const fencedCodeLiveField = StateField.define<DecorationSet>({
  create: activeFenceDecorations,
  update(value, transaction) {
    if (!transaction.docChanged && transaction.startState.selection.eq(transaction.state.selection)) {
      return value;
    }
    return activeFenceDecorations(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const fencedCodeLiveTheme = EditorView.theme({
  ".cm-nowen-fence-active": {
    backgroundColor: "color-mix(in srgb, var(--color-app-hover, #f1f5f9) 62%, transparent)",
    fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
  },
  ".cm-nowen-fence-opening": {
    position: "relative",
    paddingTop: "8px",
    borderTopLeftRadius: "10px",
    borderTopRightRadius: "10px",
    color: "var(--color-text-tertiary, #94a3b8)",
  },
  ".cm-nowen-fence-opening::after": {
    content: "attr(data-fence-language-label)",
    position: "absolute",
    right: "10px",
    top: "7px",
    padding: "1px 7px",
    borderRadius: "999px",
    backgroundColor: "color-mix(in srgb, var(--color-app-bg, #fff) 72%, transparent)",
    color: "var(--color-text-tertiary, #94a3b8)",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    fontSize: "10px",
    lineHeight: "18px",
    pointerEvents: "none",
  },
  ".cm-nowen-fence-body": {
    paddingLeft: "10px",
    paddingRight: "10px",
  },
  ".cm-nowen-fence-closing": {
    paddingBottom: "8px",
    borderBottomLeftRadius: "10px",
    borderBottomRightRadius: "10px",
    color: "var(--color-text-tertiary, #94a3b8)",
  },
});

export const markdownFencedCodeAuthoringExtension: Extension = [
  Prec.highest(keymap.of([
    { key: "Enter", run: completeMarkdownFenceOnEnter },
    { key: "Mod-Shift-k", run: toggleCodeBlock },
  ])),
  markdownLanguage.data.of({ autocomplete: fencedCodeLanguageCompletion }),
];

export const markdownFencedCodeLiveEditingExtension: Extension = [
  fencedCodeLiveField,
  fencedCodeLiveTheme,
];

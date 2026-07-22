export type EditorMediaButtonKind = "image" | "video";

export interface EditorMediaButtonScope {
  kind: EditorMediaButtonKind | null;
  label: string;
  insideMediaSheet: boolean;
  insideEditorContext: boolean;
  insideMarkdownEditorShell: boolean;
}

const MEDIA_LABEL_PATTERN = /图片|image|视频|video/i;
const MEDIA_SHEET_ATTRIBUTE = "data-nowen-media-sheet";
const TEMPORARY_GUARD_VALUE = "scope-guard";
const EDITOR_CONTEXT_SELECTOR = [
  ".ProseMirror",
  ".cm-editor",
  "[data-editor-toolbar]",
  ".note-editor",
  ".editor-toolbar-scroll-fade",
].join(", ");
const MARKDOWN_EDITOR_SHELL_SELECTOR = ".flex.flex-col.h-full.overflow-hidden";

export function shouldShieldNonEditorMediaButton(scope: EditorMediaButtonScope): boolean {
  if (!scope.kind || scope.insideMediaSheet) return false;
  if (!MEDIA_LABEL_PATTERN.test(scope.label)) return false;
  return !scope.insideEditorContext && !scope.insideMarkdownEditorShell;
}

function resolveButtonKind(button: HTMLButtonElement): EditorMediaButtonKind | null {
  if (button.querySelector("svg.lucide-image-plus")) return "image";
  if (button.querySelector("svg.lucide-film")) return "video";
  return null;
}

function isInsideMarkdownEditorShell(button: HTMLButtonElement): boolean {
  const shell = button.closest<HTMLElement>(MARKDOWN_EDITOR_SHELL_SELECTOR);
  return Boolean(shell?.querySelector(".nowen-md-editor"));
}

export function shouldShieldMediaButton(button: HTMLButtonElement): boolean {
  return shouldShieldNonEditorMediaButton({
    kind: resolveButtonKind(button),
    label: `${button.title || ""} ${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`,
    insideMediaSheet: Boolean(button.closest(`[${MEDIA_SHEET_ATTRIBUTE}]`)),
    insideEditorContext: Boolean(button.closest(EDITOR_CONTEXT_SELECTOR)),
    insideMarkdownEditorShell: isInsideMarkdownEditorShell(button),
  });
}

let installed = false;

/**
 * Prevent the mobile note-editor media bridge from hijacking similarly named buttons in
 * independent business modules such as Diary, Tasks, avatars, and attachment managers.
 *
 * MediaExperienceBridge deliberately ignores controls under `[data-nowen-media-sheet]`.
 * The guard runs one capture level earlier (window -> document), applies that marker only
 * for the duration of the current click dispatch, and leaves the original React onClick
 * untouched so the owning module can open its own file input and upload endpoint.
 */
export function installEditorMediaScopeGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button");
    if (!button || !shouldShieldMediaButton(button)) return;

    const previousValue = button.getAttribute(MEDIA_SHEET_ATTRIBUTE);
    button.setAttribute(MEDIA_SHEET_ATTRIBUTE, TEMPORARY_GUARD_VALUE);

    queueMicrotask(() => {
      if (button.getAttribute(MEDIA_SHEET_ATTRIBUTE) !== TEMPORARY_GUARD_VALUE) return;
      if (previousValue === null) button.removeAttribute(MEDIA_SHEET_ATTRIBUTE);
      else button.setAttribute(MEDIA_SHEET_ATTRIBUTE, previousValue);
    });
  }, true);
}

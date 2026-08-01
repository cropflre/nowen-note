export type ImeKeyboardEvent = Pick<KeyboardEvent, "isComposing" | "keyCode">;

/**
 * Chromium on Windows can report IME keydowns with isComposing=false while the
 * legacy keyCode=229 marker is still present. Treat both signals as composition
 * so global shortcuts never consume the first punctuation keystroke.
 */
export function isImeKeyEvent(
  event: ImeKeyboardEvent,
  editorComposing = false,
): boolean {
  return editorComposing || event.isComposing || event.keyCode === 229;
}

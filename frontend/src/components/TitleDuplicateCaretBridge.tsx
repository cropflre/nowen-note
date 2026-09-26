import { useEffect } from "react";

type TitleField = HTMLInputElement | HTMLTextAreaElement;

const MIRROR_SELECTOR = "[data-title-duplicate-mirror]";
const CARET_SELECTOR = "[data-nowen-title-duplicate-caret]";
const TITLE_FIELD_SELECTOR = [
  "[data-mobile-editor-title] textarea",
  "[data-markdown-mobile-title] textarea",
  "input.text-2xl.font-bold.text-tx-primary",
].join(",");

function activeTitleField(root: ParentNode = document): TitleField | null {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active;

  // DuplicateTitleAssistBridge makes the real field transparent while its mirror is active.
  // Fall back to that marked field if a browser briefly reports body/documentElement as active
  // during pointer selection updates.
  const fields = Array.from(root.querySelectorAll<TitleField>(TITLE_FIELD_SELECTOR));
  return fields.find((field) =>
    field.style.color === "transparent" || field.style.webkitTextFillColor === "transparent",
  ) || null;
}

function removeCaretProxy(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(CARET_SELECTOR).forEach((node) => node.remove());
}

/**
 * TitleDuplicateAssistBridge renders duplicate-title text in a fixed mirror above the real field.
 * The real input caret is therefore painted underneath that mirror and can become invisible.
 *
 * Keep the original field as the source of truth and draw only a visual caret inside the mirror at
 * the field's current selectionStart. This does not change value, selection, focus, composition or
 * save behaviour.
 */
export function syncTitleDuplicateCaretProxy(root: ParentNode = document): boolean {
  removeCaretProxy(root);

  const mirror = root.querySelector<HTMLElement>(MIRROR_SELECTOR);
  const field = activeTitleField(root);
  if (!mirror || !field || !field.isConnected) return false;

  const selectionStart = field.selectionStart;
  const selectionEnd = field.selectionEnd;
  if (selectionStart == null || selectionEnd == null || selectionStart !== selectionEnd) return false;

  const textLayer = mirror.firstElementChild as HTMLElement | null;
  if (!textLayer) return false;
  const spans = Array.from(textLayer.children).filter(
    (child): child is HTMLSpanElement => child instanceof HTMLSpanElement,
  );
  if (!spans.length) return false;
  if (spans.map((span) => span.textContent || "").join("") !== field.value) return false;

  const caret = document.createElement("span");
  caret.dataset.nowenTitleDuplicateCaret = "";
  caret.setAttribute("aria-hidden", "true");
  const computedCaretColor = window.getComputedStyle(field).caretColor;
  const caretColor = computedCaretColor && computedCaretColor !== "auto" && computedCaretColor !== "transparent"
    ? computedCaretColor
    : "#2563eb";
  Object.assign(caret.style, {
    display: "inline-block",
    width: "2px",
    minWidth: "2px",
    height: "1.08em",
    marginLeft: "-1px",
    marginRight: "-1px",
    backgroundColor: caretColor,
    borderRadius: "1px",
    boxSizing: "border-box",
    verticalAlign: "-0.14em",
    pointerEvents: "none",
    opacity: "1",
  });

  const position = Math.max(0, Math.min(selectionStart, field.value.length));
  let start = 0;
  for (const span of spans) {
    const value = span.textContent || "";
    const end = start + value.length;
    if (position <= end) {
      const offset = position - start;
      span.replaceChildren(
        document.createTextNode(value.slice(0, offset)),
        caret,
        document.createTextNode(value.slice(offset)),
      );
      return true;
    }
    start = end;
  }
  return false;
}

export default function TitleDuplicateCaretBridge() {
  useEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        syncTitleDuplicateCaretProxy();
      });
    };

    const onSelectionChange = () => schedule();
    const onFieldInteraction = (event: Event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        schedule();
      }
    };

    // The duplicate mirror is updated again whenever its async notebook-title candidates refresh.
    // That update uses prefix/suffix.textContent and therefore removes a proxy caret already
    // inserted into the mirror. Observe the mirror subtree as well as body insertion and restore
    // the caret only when the mirror exists but no caret is currently present. Our own caret
    // insertion also produces mutations, but the callback then sees an existing caret and stops,
    // avoiding a MutationObserver loop.
    const observer = new MutationObserver(() => {
      const mirror = document.querySelector<HTMLElement>(MIRROR_SELECTOR);
      if (mirror && !mirror.querySelector(CARET_SELECTOR)) schedule();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", onFieldInteraction, true);
    document.addEventListener("mouseup", onFieldInteraction, true);
    document.addEventListener("keyup", onFieldInteraction, true);
    document.addEventListener("input", onFieldInteraction, true);
    document.addEventListener("focusin", onFieldInteraction, true);
    schedule();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", onFieldInteraction, true);
      document.removeEventListener("mouseup", onFieldInteraction, true);
      document.removeEventListener("keyup", onFieldInteraction, true);
      document.removeEventListener("input", onFieldInteraction, true);
      document.removeEventListener("focusin", onFieldInteraction, true);
      removeCaretProxy();
    };
  }, []);

  return null;
}

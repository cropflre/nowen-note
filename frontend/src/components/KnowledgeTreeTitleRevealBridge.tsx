import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { revealKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import { useApp } from "@/store/AppContext";

type TitleField = HTMLInputElement | HTMLTextAreaElement;

function titleFields(root: HTMLElement): TitleField[] {
  const fields: TitleField[] = Array.from(root.querySelectorAll<HTMLTextAreaElement>(
    "[data-mobile-editor-title] textarea, [data-markdown-mobile-title] textarea",
  ));
  if (root.querySelector("[data-large-markdown-source], [data-large-markdown-preview]")) {
    fields.push(...root.querySelectorAll<HTMLInputElement>("input.text-2xl.font-bold.text-tx-primary"));
  }
  return fields;
}

/** Keep title editing intact while offering an explicit way back to the document's tree row. */
export default function KnowledgeTreeTitleRevealBridge({
  rootRef,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
}) {
  const { state } = useApp();
  const { t } = useTranslation();
  const noteId = state.activeNote?.id;
  const trashed = state.activeNote?.isTrashed;
  const hint = t("knowledgeTreeUi.locateByDoubleClick", { defaultValue: "双击在目录中定位" });

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !noteId || trashed) return;
    const originalTitles = new Map<TitleField, string | null>();
    const updateHints = () => {
      for (const field of titleFields(root)) {
        if (originalTitles.has(field)) continue;
        originalTitles.set(field, field.getAttribute("title"));
        field.title = field.title ? `${field.title}\n${hint}` : hint;
      }
    };
    const reveal = (event: MouseEvent) => {
      if (titleFields(root).includes(event.target as TitleField)) revealKnowledgeTreeNote(noteId);
    };
    updateHints();
    const observer = new MutationObserver(updateHints);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("dblclick", reveal);
    return () => {
      observer.disconnect();
      root.removeEventListener("dblclick", reveal);
      for (const [field, original] of originalTitles) {
        if (original === null) field.removeAttribute("title");
        else field.title = original;
      }
    };
  }, [hint, noteId, rootRef, trashed]);

  return null;
}

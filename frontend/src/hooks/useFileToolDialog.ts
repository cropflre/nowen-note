import { useEffect, useRef } from "react";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";

export function useFileToolDialog(onClose: () => void, busy = false) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef({ onClose, busy });
  current.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    (element?.querySelector<HTMLElement>("input") || element)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!current.current.busy) current.current.onClose();
      } else if (event.key === "Tab" && element) {
        const choices = [
          ...element.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']",
          ),
        ];
        const target = event.shiftKey ? choices.at(-1) : choices[0];
        if (
          !choices.length ||
          (event.shiftKey
            ? document.activeElement === choices[0]
            : document.activeElement === choices.at(-1)) ||
          !choices.includes(document.activeElement as HTMLElement)
        ) {
          event.preventDefault();
          (target || element).focus();
        }
      }
    };
    element?.addEventListener("keydown", keydown, true);
    const unregister = registerMobileBackHandler("modal", () => {
      if (!current.current.busy) current.current.onClose();
      return true;
    });
    return () => {
      element?.removeEventListener("keydown", keydown, true);
      unregister();
      previous?.focus();
    };
  }, []);
  return ref;
}

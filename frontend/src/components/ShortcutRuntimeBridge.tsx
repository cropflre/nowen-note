import { useEffect } from "react";
import { isImeKeyEvent } from "@/lib/ime";
import {
  SHORTCUT_COMMANDS,
  detectShortcutPlatform,
  detectShortcutSurface,
  getDefaultShortcutChords,
  getShortcutChords,
  isShortcutAllowedInTarget,
  shortcutChordMatchesEvent,
  shortcutMatchesEvent,
} from "@/lib/shortcutRegistry";

const FORMAT_PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = {
  bold: { mark: "bold" },
  italic: { mark: "italic" },
  underline: { mark: "underline" },
  strikethrough: { mark: "strike" },
  "inline-code": { mark: "code" },
  paragraph: { node: "paragraph" },
  "heading-1": { node: "heading", level: 1 },
  "heading-2": { node: "heading", level: 2 },
  "heading-3": { node: "heading", level: 3 },
  "heading-4": { node: "heading", level: 4 },
  "heading-5": { node: "heading", level: 5 },
  "heading-6": { node: "heading", level: 6 },
};

const FORMAT_COMMAND_IDS = SHORTCUT_COMMANDS
  .filter((command) => command.customizable && FORMAT_PAYLOADS[command.id])
  .map((command) => command.id);

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

/**
 * Executes user-configurable rich-text shortcuts before Tiptap's built-in keymaps.
 * The capture listener also blocks stale defaults after a binding is changed or cleared,
 * preventing both the old and new shortcuts from firing.
 */
export default function ShortcutRuntimeBridge() {
  useEffect(() => {
    const platform = detectShortcutPlatform();
    const surface = detectShortcutSurface();
    if (surface === "android") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyEvent(event) || event.defaultPrevented) return;

      for (const commandId of FORMAT_COMMAND_IDS) {
        if (!isShortcutAllowedInTarget(commandId, event.target)) continue;
        if (!shortcutMatchesEvent(commandId, event, platform, surface)) continue;
        consume(event);
        window.dispatchEvent(new CustomEvent("nowen:format", {
          detail: FORMAT_PAYLOADS[commandId],
        }));
        return;
      }

      // Tiptap still owns its compiled default keymaps. Once a user changes or clears a
      // binding, consume the former default in capture phase so the stale keymap cannot fire.
      for (const commandId of FORMAT_COMMAND_IDS) {
        if (!isShortcutAllowedInTarget(commandId, event.target)) continue;
        const current = getShortcutChords(commandId, platform, surface);
        const defaults = getDefaultShortcutChords(commandId, platform, surface);
        const matchesDefault = defaults.some((chord) => shortcutChordMatchesEvent(chord, event, platform));
        if (!matchesDefault) continue;
        const stillCurrent = current.some((chord) => shortcutChordMatchesEvent(chord, event, platform));
        if (!stillCurrent) consume(event);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return null;
}

import {
  resolveDocumentThemeMode,
  type NoteThemeTokens,
} from "@/lib/noteTheme";
import { resolveRegisteredNoteTheme } from "@/lib/pluginNoteThemeRegistry";

const SURFACE_TOKEN_PROPERTIES: Array<[keyof NoteThemeTokens, string]> = [
  ["surface", "--note-theme-surface"],
  ["text", "--pm-text"],
  ["heading", "--pm-heading"],
  ["muted", "--note-theme-muted"],
  ["border", "--note-theme-border"],
  ["accent", "--note-theme-accent"],
  ["accentHover", "--note-theme-accent-hover"],
  ["inlineCodeBackground", "--pm-code-bg"],
  ["inlineCodeText", "--pm-code-text"],
  ["preBackground", "--pm-pre-bg"],
  ["preText", "--pm-pre-text"],
  ["quoteBorder", "--pm-blockquote-border"],
  ["quoteText", "--pm-blockquote-text"],
  ["softBackground", "--note-theme-soft"],
  ["tableStripe", "--note-theme-table-stripe"],
  ["markBackground", "--note-theme-mark"],
  ["selection", "--pm-selection"],
  ["contentMaxWidth", "--note-theme-content-width"],
  ["lineHeight", "--pm-p-line-height"],
];

export function applyExplicitNoteTheme(surface: HTMLElement, themeId: string): boolean {
  const resolved = resolveRegisteredNoteTheme(themeId, resolveDocumentThemeMode());
  surface.dataset.noteTheme = resolved.id;
  surface.dataset.noteThemeRequested = themeId;
  surface.toggleAttribute("data-note-theme-fallback", !resolved.available);
  for (const [key, property] of SURFACE_TOKEN_PROPERTIES) {
    surface.style.setProperty(property, resolved.tokens[key]);
  }
  return resolved.available;
}

export function clearExplicitNoteTheme(surface: HTMLElement): void {
  surface.removeAttribute("data-note-theme");
  surface.removeAttribute("data-note-theme-requested");
  surface.removeAttribute("data-note-theme-fallback");
  for (const [, property] of SURFACE_TOKEN_PROPERTIES) surface.style.removeProperty(property);
}

export function noteAppearanceSurfaceTokenProperties(): readonly string[] {
  return SURFACE_TOKEN_PROPERTIES.map(([, property]) => property);
}

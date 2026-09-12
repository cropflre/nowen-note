import {
  APP_APPEARANCE_CHANGED_EVENT,
  getAppAppearance,
  readStoredAppAppearance,
  resolveAppAppearanceMode,
} from "@/lib/appAppearance";

let installed = false;
let protectedEditorFont = "";
let reconciling = false;

function projectedAppearanceFont(root: HTMLElement): string {
  const appearanceId = readStoredAppAppearance();
  // Default appearance clears projected tokens and therefore owns no editor-font override.
  if (appearanceId === "default") return "";
  return getAppAppearance(appearanceId).modes[resolveAppAppearanceMode(root)].editorFontFamily.trim();
}

export function resolveEditorFontGuardState(
  currentFont: string,
  appearanceFont: string,
  previousProtectedFont: string,
): { protectedFont: string; restoreFont: string | null } {
  const current = currentFont.trim();
  const projected = appearanceFont.trim();
  const protectedFont = previousProtectedFont.trim();

  // SiteSettings writes the explicit editor font to the same root property. Any non-empty value
  // that differs from the appearance projection becomes the protected source of truth.
  if (current && current !== projected) {
    return { protectedFont: current, restoreFont: null };
  }

  // Appearance switching/theme-mode switching may replace or clear the property. Restore the latest
  // explicit SiteSettings value once one has been observed.
  if (protectedFont && current !== protectedFont) {
    return { protectedFont, restoreFont: protectedFont };
  }

  return { protectedFont, restoreFont: null };
}

function reconcile(root: HTMLElement): void {
  if (reconciling) return;
  reconciling = true;
  try {
    const current = root.style.getPropertyValue("--editor-font-family");
    const next = resolveEditorFontGuardState(
      current,
      projectedAppearanceFont(root),
      protectedEditorFont,
    );
    protectedEditorFont = next.protectedFont;
    if (next.restoreFont) {
      root.style.setProperty("--editor-font-family", next.restoreFont);
    }
  } finally {
    reconciling = false;
  }
}

/**
 * Keep the dedicated "编辑器字体" setting higher priority than whole-app appearance styles.
 *
 * App Appearance owns application visual language. SiteSettings owns editor typography. The two
 * features share a legacy CSS variable, so this guard preserves the latest explicit SiteSettings
 * value across appearance switches and Light/Dark/System changes without changing persisted data.
 */
export function installEditorFontAppearanceGuard(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || installed) return;
  installed = true;
  const root = document.documentElement;

  const schedule = () => queueMicrotask(() => reconcile(root));
  reconcile(root);

  const observer = new MutationObserver((records) => {
    if (records.some((record) =>
      record.type === "attributes" &&
      (record.attributeName === "style" || record.attributeName === "class" || record.attributeName === "data-theme" || record.attributeName === "data-app-appearance")
    )) schedule();
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme", "data-app-appearance"],
  });

  window.addEventListener(APP_APPEARANCE_CHANGED_EVENT, schedule);
}

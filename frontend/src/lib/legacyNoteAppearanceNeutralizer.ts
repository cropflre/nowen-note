import { applyAppAppearance, readStoredAppAppearance } from "@/lib/appAppearance";

const LEGACY_NOTE_ONLY_PROPERTIES = [
  "--note-theme-surface",
  "--note-theme-muted",
  "--note-theme-border",
  "--note-theme-accent",
  "--note-theme-accent-hover",
  "--note-theme-soft",
  "--note-theme-table-stripe",
  "--note-theme-mark",
  "--note-theme-content-width",
  "--note-theme-font-family",
  "--note-theme-font-size",
  "--pm-p-line-height",
] as const;

let installed = false;
let reconciling = false;

/**
 * release/v1.5.0 previously exposed a note-theme preference that wrote editor-only tokens onto the
 * document root. App Appearance Style is now the product source of truth. This compatibility guard
 * prevents an old cached `noteTheme` value from partially overriding the selected whole-app skin.
 * It does not delete stored user data or note metadata; it only stops legacy presentation leakage.
 */
export function installLegacyNoteAppearanceNeutralizer(): void {
  if (typeof document === "undefined" || installed) return;
  installed = true;
  const root = document.documentElement;

  const reconcile = () => {
    if (reconciling) return;
    reconciling = true;
    try {
      root.removeAttribute("data-note-theme");
      for (const property of LEGACY_NOTE_ONLY_PROPERTIES) root.style.removeProperty(property);
      // Re-project the full app token set so overlapping --pm-* values also return to the selected
      // application appearance after a legacy note-theme effect attempted to write them.
      applyAppAppearance(readStoredAppAppearance(), root);
    } finally {
      reconciling = false;
    }
  };

  reconcile();
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "data-note-theme")) reconcile();
  });
  observer.observe(root, { attributes: true, attributeFilter: ["data-note-theme"] });
}

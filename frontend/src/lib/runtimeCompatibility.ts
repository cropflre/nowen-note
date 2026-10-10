import { installRuntimePrelude } from "./runtimePrelude";
import "../app-appearance.css";
import "../app-appearance-neutral-compat.css";
import { bootstrapAppAppearanceRuntime } from "./appAppearance";
import { installEditorFontAppearanceGuard } from "./editorFontAppearanceGuard";
import { installLegacyNoteAppearanceNeutralizer } from "./legacyNoteAppearanceNeutralizer";
import { migrateUnifiedTreeOnlyLayout } from "./unifiedTreeOnlyLayout";

/**
 * Application-level compatibility work that depends on DOM/CSS modules.
 *
 * Primitive language/runtime polyfills live in runtimePrelude.ts and execute before this
 * dependency graph. Keep that separation intact: older Safari can fail while evaluating a
 * dependency before this module body gets a chance to run.
 */
export function installRuntimeCompatibility(): void {
  // Re-run the zero-dependency prelude for direct callers/tests that deliberately remove
  // a native method after module evaluation. It is idempotent and preserves native methods.
  installRuntimePrelude();
  migrateUnifiedTreeOnlyLayout();
  bootstrapAppAppearanceRuntime();
  installLegacyNoteAppearanceNeutralizer();
  installEditorFontAppearanceGuard();
}

installRuntimeCompatibility();

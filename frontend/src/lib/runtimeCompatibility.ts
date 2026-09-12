import "../app-appearance.css";
import "../app-appearance-neutral-compat.css";
import { bootstrapAppAppearanceRuntime } from "./appAppearance";
import { installEditorFontAppearanceGuard } from "./editorFontAppearanceGuard";
import { installLegacyNoteAppearanceNeutralizer } from "./legacyNoteAppearanceNeutralizer";
import { migrateUnifiedTreeOnlyLayout } from "./unifiedTreeOnlyLayout";

type FindLastPredicate<T> = (
  value: T,
  index: number,
  array: ArrayLike<T>,
) => unknown;

type FindLastMethod = <T>(
  this: ArrayLike<T>,
  predicate: FindLastPredicate<T>,
  thisArg?: unknown,
) => T | undefined;

const MAX_SAFE_LENGTH = Number.MAX_SAFE_INTEGER;

function toSafeLength(value: unknown): number {
  const numeric = Number(value);
  if (Number.isNaN(numeric) || numeric <= 0) return 0;
  if (numeric === Number.POSITIVE_INFINITY) return MAX_SAFE_LENGTH;
  return Math.min(Math.floor(numeric), MAX_SAFE_LENGTH);
}

/**
 * Standards-aligned Array.prototype.findLast fallback for WebViews whose
 * JavaScript runtime predates ES2023. Keep this module lightweight because it
 * executes before React, Tiptap and the rest of the application graph.
 *
 * App Appearance also boots here intentionally: main.tsx imports this module
 * first, so the persisted whole-app style is projected before React paints.
 * This avoids relying on Settings/SkinSwitcher being evaluated and prevents a
 * default-theme flash on cold start or public surfaces.
 */
const findLastPolyfill: FindLastMethod = function findLast<T>(
  this: ArrayLike<T>,
  predicate: FindLastPredicate<T>,
  thisArg?: unknown,
): T | undefined {
  if (this == null) {
    throw new TypeError("Array.prototype.findLast called on null or undefined");
  }
  if (typeof predicate !== "function") {
    throw new TypeError("predicate must be a function");
  }

  const target = Object(this) as ArrayLike<T>;
  const length = toSafeLength(target.length);
  for (let index = length - 1; index >= 0; index -= 1) {
    const value = target[index];
    if (predicate.call(thisArg, value, index, target)) return value;
  }
  return undefined;
};

export function installRuntimeCompatibility(): void {
  migrateUnifiedTreeOnlyLayout();

  // Whole-app appearance is runtime infrastructure, not a Settings-panel side effect.
  bootstrapAppAppearanceRuntime();
  installLegacyNoteAppearanceNeutralizer();
  // SiteSettings remains authoritative for editor typography even when a style suggests a font.
  installEditorFontAppearanceGuard();

  if (typeof Array === "undefined") return;
  if (typeof Reflect.get(Array.prototype, "findLast") === "function") return;

  Object.defineProperty(Array.prototype, "findLast", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: findLastPolyfill,
  });
}

installRuntimeCompatibility();

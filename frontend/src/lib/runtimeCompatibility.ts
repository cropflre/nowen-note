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
 * JavaScript runtime predates ES2023. Keep this module dependency-free so it
 * can execute before React, Tiptap and the rest of the application graph.
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

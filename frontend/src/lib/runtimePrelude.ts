type FindLastPredicate<T> = (
  value: T,
  index: number,
  array: ArrayLike<T>,
) => unknown;

const MAX_SAFE_LENGTH = 9007199254740991;

function toSafeLength(value: unknown): number {
  const numeric = Number(value);
  if (Number.isNaN(numeric) || numeric <= 0) return 0;
  if (numeric === Number.POSITIVE_INFINITY) return MAX_SAFE_LENGTH;
  return Math.min(Math.floor(numeric), MAX_SAFE_LENGTH);
}

export function findLastPolyfill<T>(
  this: ArrayLike<T>,
  predicate: FindLastPredicate<T>,
  thisArg?: unknown,
): T | undefined {
  if (this == null) throw new TypeError("Array.prototype.findLast called on null or undefined");
  if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
  const target = Object(this) as ArrayLike<T>;
  for (let index = toSafeLength(target.length) - 1; index >= 0; index -= 1) {
    const value = target[index];
    if (predicate.call(thisArg, value, index, target)) return value;
  }
  return undefined;
}

export function findLastIndexPolyfill<T>(
  this: ArrayLike<T>,
  predicate: FindLastPredicate<T>,
  thisArg?: unknown,
): number {
  if (this == null) throw new TypeError("Array.prototype.findLastIndex called on null or undefined");
  if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
  const target = Object(this) as ArrayLike<T>;
  for (let index = toSafeLength(target.length) - 1; index >= 0; index -= 1) {
    if (predicate.call(thisArg, target[index], index, target)) return index;
  }
  return -1;
}

export function toSortedPolyfill<T>(
  this: ArrayLike<T>,
  compareFn?: (a: T, b: T) => number,
): T[] {
  if (this == null) throw new TypeError("Array.prototype.toSorted called on null or undefined");
  return Array.prototype.slice.call(this).sort(compareFn);
}

export function toReversedPolyfill<T>(this: ArrayLike<T>): T[] {
  if (this == null) throw new TypeError("Array.prototype.toReversed called on null or undefined");
  return Array.prototype.slice.call(this).reverse();
}

function defineMethod(target: object, name: string, value: unknown): void {
  if (typeof (target as Record<string, unknown>)[name] === "function") return;
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    enumerable: false,
    value,
  });
}

function installPromiseFinally(): void {
  if (typeof Promise === "undefined") return;
  const prototype = Promise.prototype as Promise<unknown> & {
    finally?: (onFinally?: (() => void) | null) => Promise<unknown>;
  };
  if (typeof prototype.finally === "function") return;

  Object.defineProperty(prototype, "finally", {
    configurable: true,
    writable: true,
    enumerable: false,
    value: function (this: Promise<unknown>, onFinally?: (() => void) | null) {
      const handler = typeof onFinally === "function" ? onFinally : () => undefined;
      return this.then(
        (value) => Promise.resolve(handler()).then(() => value),
        (reason) => Promise.resolve(handler()).then(() => { throw reason; }),
      );
    },
  });
}

function installQueueMicrotask(): void {
  const runtime = typeof globalThis !== "undefined"
    ? globalThis as typeof globalThis & { queueMicrotask?: (callback: VoidFunction) => void }
    : window as typeof window & { queueMicrotask?: (callback: VoidFunction) => void };
  if (typeof runtime.queueMicrotask === "function") return;
  runtime.queueMicrotask = (callback: VoidFunction) => {
    Promise.resolve()
      .then(callback)
      .catch((error) => {
        setTimeout(() => { throw error; }, 0);
      });
  };
}

/**
 * Zero-dependency compatibility prelude.
 *
 * This file MUST stay free of CSS and application imports. ES modules evaluate dependencies
 * before the importing module body, so putting compatibility code inside a module that itself
 * imports App/appearance code is too late for older Safari/WKWebView runtimes.
 */
export function installRuntimePrelude(): void {
  if (typeof Array !== "undefined") {
    defineMethod(Array.prototype, "findLast", findLastPolyfill);
    defineMethod(Array.prototype, "findLastIndex", findLastIndexPolyfill);
    defineMethod(Array.prototype, "toSorted", toSortedPolyfill);
    defineMethod(Array.prototype, "toReversed", toReversedPolyfill);
  }
  installPromiseFinally();
  installQueueMicrotask();
}

installRuntimePrelude();

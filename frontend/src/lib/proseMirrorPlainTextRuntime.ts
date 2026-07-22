import type { Fragment } from "@tiptap/pm/model";

import { serializeProseMirrorPlainText as serializeBase } from "./proseMirrorPlainText";

/**
 * Cache a derived value by immutable ProseMirror Fragment identity.
 *
 * Every document transaction creates a new Fragment. The Tiptap editor currently asks for the same
 * plain-text snapshot once for derived UI and again for the debounced save. A WeakMap lets both
 * consumers reuse the first traversal without retaining old documents after ProseMirror releases
 * them.
 */
export function createFragmentSnapshotCache<T extends object, R>(
  derive: (value: T) => R,
): (value: T) => R {
  const cache = new WeakMap<T, R>();
  return (value: T): R => {
    const cached = cache.get(value);
    if (cached !== undefined || cache.has(value)) return cached as R;
    const result = derive(value);
    cache.set(value, result);
    return result;
  };
}

const serializeCached = createFragmentSnapshotCache<Fragment, string>(serializeBase);

/**
 * Runtime replacement for the original serializer. The public contract stays identical while
 * duplicate derived/save reads of one immutable editor document become O(1).
 */
export function serializeProseMirrorPlainText(content: Fragment): string {
  return serializeCached(content);
}
